import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";
import { orchestrationAllowed, type Config } from "./config.js";
import { Repository, record, now } from "./repository.js";
import { ApiError, requireValue } from "./errors.js";
import type { Run, Conversation, Attempt, Identity } from "../shared/domain.js";
import type { Gateway } from "./gateway.js";
import type { MediaService } from "./media.js";
import {
  envelopeSchema,
  envelopeHash,
  executionStates,
  executionRank,
  payloadHash,
  type Envelope,
} from "./gateway-contract.js";
import { databaseReadiness } from "./readiness.js";
export class ExecutionClaims {
  constructor(
    public db: Database,
    public cfg: Config,
  ) {}
  scope(workspace: string) {
    if (
      !orchestrationAllowed(this.cfg) ||
      !this.cfg.orchestratorWorkspaces?.includes(workspace)
    )
      throw new ApiError(
        403,
        "WORKSPACE_SCOPE_DENIED",
        "Orchestrator workspace / environment не разрешён",
      );
  }
  async claim(raw: unknown, executionId: string) {
    const envelope = envelopeSchema.parse(raw);
    this.scope(envelope.workspaceId);
    if (envelopeHash(envelope) !== envelope.payloadHash)
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Envelope hash mismatch");
    if (
      envelope.environment !== this.cfg.environment ||
      envelope.property.crmPropertyId !== this.cfg.crmProperty ||
      envelope.property.pmsPropertyId !== this.cfg.pmsProperty ||
      envelope.property.crmTenantId !== this.cfg.crmTenant ||
      envelope.property.pmsTenantId !== this.cfg.pmsTenant
    )
      throw new ApiError(
        409,
        "ENVIRONMENT_MISMATCH",
        "Claim property scope mismatch",
      );
    const ready = await databaseReadiness(this.db, this.cfg);
    if (!ready.ready)
      throw new ApiError(
        503,
        ready.status,
        "Studio database readiness required",
      );
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM conversation_refs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [envelope.workspaceId, envelope.conversationId],
      );
      await tx.query(
        "SELECT id FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [envelope.workspaceId, envelope.runId],
      );
      const r = new Repository(tx, envelope.workspaceId),
        run = requireValue(await r.get<Run>("agent_runs", envelope.runId)),
        conv = requireValue(
          await r.get<Conversation>(
            "conversation_refs",
            envelope.conversationId,
          ),
        );
      if (
        conv.mode !== "sandbox" ||
        run.conversationId !== conv.id ||
        run.correlationId !== envelope.correlationId ||
        run.dispatchHash !== envelope.payloadHash
      )
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Claim does not match durable dispatch",
        );
      if (run.claim)
        return {
          accepted: true as const,
          durablyClaimed: true as const,
          runId: run.id,
          payloadHash: run.claim.payloadHash,
          duplicate: true,
          execute: false,
          resume:
            run.claim.executionId === executionId &&
            run.status === "dispatch_accepted",
          state: run.status,
          executionId: run.claim.executionId,
        };
      const attempt = requireValue(
        (
          await tx.query<{ data: Attempt; sequence: string }>(
            "SELECT data,sequence FROM message_attempts WHERE workspace_id=$1 AND conversation_id=$2 AND external_message_id=$3",
            [r.workspaceId, conv.id, envelope.externalMessageId],
          )
        )[0],
      );
      if (attempt.data.runId !== run.id)
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Attempt/run mismatch");
      const previous = await tx.query(
        "SELECT a.id FROM message_attempts a JOIN agent_runs pr ON pr.workspace_id=a.workspace_id AND pr.id=a.data->>'runId' WHERE a.workspace_id=$1 AND a.conversation_id=$2 AND a.sequence<$3::bigint AND pr.data->>'status' NOT IN ('completed','failed','human_owned','inbound_saved_no_orchestrator')",
        [r.workspaceId, conv.id, attempt.sequence],
      );
      if (previous.length)
        throw new ApiError(
          409,
          "CONVERSATION_BUSY",
          "Previous logical run requires completion/recovery",
          true,
        );
      const active = await tx.query(
        "SELECT id FROM agent_runs WHERE workspace_id=$1 AND conversation_id=$2 AND id<>$3 AND data ? 'claim' AND data->>'status' NOT IN ('completed','failed','human_owned')",
        [r.workspaceId, conv.id, run.id],
      );
      if (active.length)
        throw new ApiError(
          409,
          "CONVERSATION_BUSY",
          "Previous logical run requires completion/recovery",
          true,
        );
      if (["completed", "failed", "human_owned"].includes(run.status))
        throw new ApiError(409, "RUN_TERMINAL", "Run already terminal");
      const claim = {
        payloadHash: envelope.payloadHash,
        executionId,
        claimedAt: now(),
      };
      await r.patch("agent_runs", run.id, {
        claim,
        executionId,
        status: "dispatch_accepted",
      });
      return {
        accepted: true as const,
        durablyClaimed: true as const,
        runId: run.id,
        payloadHash: envelope.payloadHash,
        duplicate: false,
        execute: true,
        state: "dispatch_accepted",
        executionId,
      };
    });
  }
}
const eventSchema = z
  .object({
    eventId: z.string().uuid(),
    workspaceId: z.string().min(1),
    runId: z.string().uuid(),
    correlationId: z.string().uuid(),
    crmConversationId: z.string().min(1).optional(),
    crmCustomerId: z.string().min(1).optional(),
    state: z.enum(executionStates),
    sequence: z.number().int().positive().safe().optional(),
    executionId: z.string().max(200).optional(),
    workflowVersion: z.string().max(200).optional(),
    deploymentId: z.string().max(200).optional(),
    contextVersion: z.string().max(200).optional(),
    businessOperationId: z.string().max(200).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional(),
  })
  .strict();
export function registerOrchestration(
  app: express.Express,
  db: Database,
  cfg: Config,
  gateway: Gateway,
  media: MediaService,
) {
  const claims = new ExecutionClaims(db, cfg);
  const bearer = (req: express.Request) => {
    const expected = Buffer.from("Bearer " + cfg.n8nToken),
      provided = Buffer.from(req.header("authorization") ?? "");
    if (
      cfg.n8nToken.length < 32 ||
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    )
      throw new ApiError(
        401,
        "AUTH_FAILED",
        "Invalid orchestrator credentials",
      );
  };
  app.post(
    "/api/integrations/n8n/claims",
    express.json({ limit: "128kb" }),
    async (req, res) => {
      bearer(req);
      const input = z
        .object({
          executionId: z.string().min(1).max(200),
          envelope: envelopeSchema,
        })
        .strict()
        .parse(req.body);
      res.json(await claims.claim(input.envelope, input.executionId));
    },
  );
  app.get("/api/integrations/n8n/runs/:id", async (req, res) => {
    bearer(req);
    const workspace = z.string().parse(req.query.workspaceId);
    claims.scope(workspace);
    const run = requireValue(
      await new Repository(db, workspace).get<Run>(
        "agent_runs",
        String(req.params.id),
      ),
    );
    res.json({
      runId: run.id,
      status: run.status,
      correlationId: run.correlationId,
      payloadHash: run.dispatchHash,
      executionId: run.executionId,
      businessOperationId: run.businessOperationId,
      businessStatus: run.businessStatus,
      promptVersionId: run.promptVersionId,
      promptHash: run.promptHash,
      workflowId: run.workflowId,
      deploymentId: run.deploymentId,
    });
  });
  app.post(
    "/api/integrations/n8n/media/exchange",
    express.json({ limit: "8kb" }),
    async (req, res) => {
      bearer(req);
      const input = z
        .object({
          workspaceId: z.string(),
          runId: z.string(),
          assetId: z.string(),
        })
        .strict()
        .parse(req.body);
      claims.scope(input.workspaceId);
      const r = new Repository(db, input.workspaceId),
        run = requireValue(await r.get<Run>("agent_runs", input.runId));
      if (
        !run.claim ||
        !run.dispatchEnvelope?.media.some((a) => a.id === input.assetId) ||
        ["completed", "failed", "human_owned"].includes(run.status)
      )
        throw new ApiError(
          403,
          "MEDIA_NOT_OWNED",
          "Asset not owned by active claimed run",
        );
      const asset = await media.authorized(r, input.assetId);
      if (asset.scanStatus !== "clean")
        throw new ApiError(403, "SCANNER_REQUIRED", "Clean media required");
      res.setHeader("Cache-Control", "no-store");
      res.json({
        id: asset.id,
        url: new URL(
          media.sign(r.workspaceId, asset.id, "workflow"),
          cfg.publicUrl,
        ).toString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      });
    },
  );
  app.post(
    "/api/integrations/n8n/events",
    express.raw({ type: "application/json", limit: "128kb" }),
    async (req, res) => {
      if (
        !orchestrationAllowed(cfg) ||
        cfg.callbackSecret.length < 32
      )
        throw new ApiError(503, "NOT_CONFIGURED", "Callback disabled");
      const timestamp = req.header("x-studio-timestamp") ?? "",
        signature = req.header("x-studio-signature") ?? "";
      if (
        !/^\d+$/.test(timestamp) ||
        !/^[a-f0-9]{64}$/.test(signature) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
        !Buffer.isBuffer(req.body)
      )
        throw new ApiError(
          401,
          "INVALID_SIGNATURE",
          "Invalid callback signature",
        );
      const expected = createHmac("sha256", cfg.callbackSecret)
          .update(timestamp + ".")
          .update(req.body)
          .digest(),
        provided = Buffer.from(signature, "hex");
      if (
        expected.length !== provided.length ||
        !timingSafeEqual(expected, provided)
      )
        throw new ApiError(
          401,
          "INVALID_SIGNATURE",
          "Invalid callback signature",
        );
      let raw: unknown;
      try {
        raw = JSON.parse(req.body.toString());
      } catch {
        throw new ApiError(400, "INVALID_JSON", "Invalid JSON");
      }
      const event = eventSchema.parse(raw);
      claims.scope(event.workspaceId);
      const r = new Repository(db, event.workspaceId),
        run = requireValue(await r.get<Run>("agent_runs", event.runId)),
        conv = requireValue(
          await r.get<Conversation>("conversation_refs", run.conversationId),
        );
      if (conv.mode !== "sandbox" || run.correlationId !== event.correlationId)
        throw new ApiError(
          409,
          "CORRELATION_CONFLICT",
          "Callback scope mismatch",
        );
      if (
        gateway.integrations.v2 &&
        (!run.claim ||
          !event.sequence ||
          event.executionId !== run.claim.executionId)
      )
        throw new ApiError(
          409,
          "CLAIM_REQUIRED",
          "Callback requires matching execution claim and sequence",
        );
      if (
        conv.crmConversationId &&
        event.crmConversationId &&
        conv.crmConversationId !== event.crmConversationId
      )
        throw new ApiError(
          409,
          "IDENTITY_CONFLICT",
          "Conversation reference changed",
        );
      if (
        !["dispatch_accepted", "failed", "completion_unknown"].includes(
          event.state,
        ) &&
        !event.crmConversationId
      )
        throw new ApiError(
          400,
          "CRM_REFERENCE_REQUIRED",
          "CRM conversation required",
        );
      let customerId: string | undefined, operationStatus: string | undefined;
      let authoritativeHuman = false;
      if (gateway.integrations.v2 && event.crmConversationId) {
        const identity = requireValue(
            await r.get<Identity>("virtual_identities", conv.identityId),
          ),
          scope = gateway.integrations.scope(
            { ...conv, crmConversationId: event.crmConversationId },
            identity,
          );
        const context = await gateway.integrations.crmV2.context(scope);
        customerId = context.customerId;
        authoritativeHuman = !context.aiReplyAllowed;
        if (
          (event.crmCustomerId && event.crmCustomerId !== customerId) ||
          (conv.crmCustomerId && conv.crmCustomerId !== customerId)
        )
          throw new ApiError(
            409,
            "IDENTITY_CONFLICT",
            "Customer reference mismatch",
          );
        const operationId =
          event.businessOperationId ?? run.businessOperationId;
        if (
          event.state === "business_completed" ||
          (event.state === "completed" && operationId)
        ) {
          if (!operationId)
            throw new ApiError(
              400,
              "OPERATION_REFERENCE_REQUIRED",
              "Operation ID required",
            );
          const receipt = await gateway.integrations.crmV2.operation(
            scope,
            operationId,
          );
          operationStatus = receipt.status;
          if (
            receipt.status === "pending" ||
            (event.state === "business_completed" &&
              receipt.status !== "completed")
          )
            throw new ApiError(
              409,
              "OPERATION_NOT_COMPLETED",
              "Authoritative read-back has not completed",
            );
        }
      }
      const fingerprint = payloadHash(event);
      await db.transaction(async (tx) => {
        await tx.query(
          "SELECT id FROM conversation_refs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [event.workspaceId, conv.id],
        );
        await tx.query(
          "SELECT id FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [event.workspaceId, run.id],
        );
        const repo = new Repository(tx, event.workspaceId),
          key = "event:" + event.eventId,
          prior = await repo.get<{ fingerprint: string }>(
            "integration_configuration",
            key,
          );
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Callback event payload changed",
            );
          return;
        }
        const fresh = requireValue(await repo.get<Run>("agent_runs", run.id));
        await repo.put("integration_configuration", {
          ...record({ runId: run.id, state: event.state, fingerprint }),
          id: key,
        });
        if (event.sequence && event.sequence <= (fresh.lastEventSequence ?? 0))
          return;
        if (
          ["human_owned", "completed"].includes(fresh.status) ||
          (fresh.status === "failed" && event.state !== "human_owned")
        )
          return;
        if (
          !event.sequence &&
          (executionRank[fresh.status] ?? -1) >=
            (executionRank[event.state] ?? -1)
        )
          return;
        await repo.patch("conversation_refs", conv.id, {
          ...(event.crmConversationId
            ? { crmConversationId: event.crmConversationId }
            : {}),
          ...(customerId ? { crmCustomerId: customerId } : {}),
          ...(event.state === "human_owned" || authoritativeHuman
            ? { handoff: true }
            : {}),
        });
        const status = authoritativeHuman
          ? "human_owned"
          : event.state === "failed" &&
              (fresh.businessOperationId || event.businessOperationId) &&
              !["completed", "rejected"].includes(
                operationStatus ?? fresh.businessStatus ?? "",
              )
            ? "completion_unknown"
            : event.state;
        await repo.patch("agent_runs", run.id, {
          status,
          ...(event.sequence ? { lastEventSequence: event.sequence } : {}),
          ...(event.errorCode ? { error: event.errorCode } : {}),
          ...(event.workflowVersion
            ? { workflowVersion: event.workflowVersion }
            : {}),
          ...(event.deploymentId ? { deploymentId: event.deploymentId } : {}),
          ...(event.contextVersion
            ? { contextVersion: event.contextVersion }
            : {}),
          ...(event.businessOperationId
            ? { businessOperationId: event.businessOperationId }
            : {}),
          ...(operationStatus ? { businessStatus: operationStatus } : {}),
        });
        if (event.state === "failed")
          for (const a of (await repo.list<Attempt>("message_attempts")).filter(
            (a) => a.runId === run.id,
          ))
            await repo.patch("message_attempts", a.id, {
              status: "failed",
              error: event.errorCode ?? "WORKFLOW_FAILED",
            });
      });
      try {
        await gateway.reconcile(
          r,
          requireValue(await r.get<Conversation>("conversation_refs", conv.id)),
        );
      } catch {
        /* Durable callback survives upstream outage; timeline polling recovers. */
      }
      res.json({ accepted: true });
    },
  );
  return claims;
}
