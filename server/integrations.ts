import { z } from "zod";
import { orchestrationAllowed, type Config } from "./config.js";
import type {
  Attachment,
  Conversation,
  Identity,
  Attempt,
  Message,
  Client,
} from "../shared/domain.js";
import { ApiError } from "./errors.js";
import { now } from "./repository.js";
import { CrmV2Adapter } from "./crm-v2.js";
import { pmsCapabilitiesSchema, crmMessageSchema } from "./crm-v2-contracts.js";
import { integrationHttp } from "./integration-http.js";
import {
  acceptedSchema,
  envelopeHash,
  envelopeSchema,
  type Envelope,
} from "./gateway-contract.js";
export { permittedUrl } from "./integration-http.js";
export interface ScenarioSetupAdapter {
  prepare(input: {
    workspaceId: string;
    stage: string;
    externalUserId: string;
    crmPropertyId: string;
    pmsPropertyId: string;
  }): Promise<{
    status: "READY" | "SETUP_UNAVAILABLE";
    references: Record<string, string>;
    reason: string;
  }>;
}
export class UnavailableScenarioSetup implements ScenarioSetupAdapter {
  async prepare() {
    return {
      status: "SETUP_UNAVAILABLE" as const,
      references: {},
      reason: "Не настроена подтверждённая изолированная CRM/PMS fixture среда",
    };
  }
}
export interface TraceReader {
  read(
    correlationId: string,
    cursor?: string,
  ): Promise<{ events: unknown[]; nextCursor?: string }>;
}
export interface PromptPublisher {
  metadata(workflowId: string): Promise<{
    workflowId: string;
    activeDeploymentId?: string;
    activeHash?: string;
  }>;
  publish(input: {
    workflowId: string;
    versionId: string;
    body: string;
    expectedHash: string;
    environment: string;
  }): Promise<{ deploymentId: string; readBackHash: string }>;
  active(
    workflowId: string,
  ): Promise<{ deploymentId: string; versionId: string; readBackHash: string }>;
  rollback(input: {
    workflowId: string;
    deploymentId: string;
    expectedHash: string;
  }): Promise<{ deploymentId: string; readBackHash: string }>;
}
export interface SpeechAdapter {
  transcribe(asset: Attachment): Promise<string>;
  synthesize(text: string): Promise<Attachment>;
}
export interface VoiceSessionAdapter {
  open(input: {
    callId: string;
    workspaceId: string;
    crmConversationId?: string;
  }): Promise<{ sessionId: string }>;
  segment(input: {
    sessionId: string;
    sequence: number;
    asset: Attachment;
    speaker: "guest" | "agent";
  }): Promise<void>;
  complete(
    sessionId: string,
  ): Promise<{ summary: string; crmConversationId?: string }>;
}
export interface ObjectStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
const inboundResultSchema = z.object({
  messageId: z.string().min(1),
  duplicate: z.boolean(),
  context: z.object({
    conversation: z.object({ id: z.string().min(1) }),
    customer: z.object({ id: z.string().min(1) }).optional(),
  }),
  aiReplyAllowed: z.boolean(),
  allowedActions: z.array(z.string()),
});
type Connection = {
  name: string;
  status: string;
  detail: string;
  capabilities: unknown;
};
export class Integrations {
  crmV2: CrmV2Adapter;
  constructor(public cfg: Config) {
    this.crmV2 = new CrmV2Adapter(cfg);
  }
  get v2() {
    return this.cfg.crmVersion !== "v1";
  }
  async pmsCapabilities() {
    return integrationHttp(
      this.cfg.pmsUrl.replace(/\/$/, "") +
        "/v2/capabilities?" +
        new URLSearchParams({ propertyId: this.cfg.pmsProperty }),
      this.cfg,
      { "x-api-key": this.cfg.pmsKey },
      pmsCapabilitiesSchema,
    );
  }
  async capabilities() {
    const c = this.cfg;
    const targets = [
      ["crm", c.crmUrl, c.crmKey],
      ["pms", c.pmsUrl, c.pmsKey],
      ["n8n", c.n8nCapabilitiesUrl, c.n8nToken],
    ] as const;
    const connections: Connection[] = await Promise.all(
      targets.map(async ([name, url, key]) => {
        if (!url || !key)
          return {
            name,
            status: "NOT_CONFIGURED",
            detail: "Endpoint или credentials не предоставлены",
            capabilities: null,
          };
        try {
          let caps: unknown;
          if (name === "crm" && this.v2) caps = await this.crmV2.attest(true);
          else if (name === "pms" && this.v2) {
            const p = await this.pmsCapabilities();
            if (
              p.environment !== (c.environment ?? "production") ||
              p.propertyId !== c.pmsProperty ||
              p.tenantId !== c.pmsTenant
            )
              throw new ApiError(
                403,
                "ENVIRONMENT_MISMATCH",
                "PMS property / tenant / environment mismatch",
              );
            caps = p;
          } else if (name === "n8n") {
            caps = await integrationHttp(
              url,
              c,
              { Authorization: "Bearer " + key },
              z.object({
                contractVersion: z.literal("studio-gateway-v1"),
                environment: z.enum(["test", "sandbox", "production"]),
                inboundOwner: z.literal("n8n"),
                durableClaim: z.literal("studio-claim-v1"),
                workflowId: z.string().min(1),
                deploymentId: z.string().min(1),
                property: z.object({
                  crmPropertyId: z.string(),
                  crmTenantId: z.string(),
                  pmsPropertyId: z.string(),
                  pmsTenantId: z.string(),
                }),
                workspaceIds: z.array(z.string()),
              }),
            );
            const n = caps as {
              environment: string;
              property: {
                crmPropertyId: string;
                crmTenantId: string;
                pmsPropertyId: string;
                pmsTenantId: string;
              };
              workspaceIds: string[];
            };
            if (
              n.environment !== c.environment ||
              n.property.crmPropertyId !== c.crmProperty ||
              n.property.pmsPropertyId !== c.pmsProperty ||
              n.property.crmTenantId !== c.crmTenant ||
              n.property.pmsTenantId !== c.pmsTenant ||
              !c.orchestratorWorkspaces?.length ||
              c.orchestratorWorkspaces.some((w) => !n.workspaceIds.includes(w))
            )
              throw new ApiError(
                403,
                "ENVIRONMENT_MISMATCH",
                "Workflow scope mismatch",
              );
          } else {
            caps = await integrationHttp(
              url.replace(/\/$/, "") + "/capabilities",
              c,
              { [name === "crm" ? "x-crm-api-key" : "x-api-key"]: key },
              name === "crm"
                ? z.object({
                    contractVersion: z.literal("agent-api-v1"),
                    supportedChannels: z
                      .array(z.string())
                      .refine((x) => x.includes("simulator")),
                    featureFlags: z.object({
                      conversationMessagePolling: z.literal(true),
                    }),
                  })
                : z.object({
                    contractVersion: z.literal("v1"),
                    integrationContextSupported: z.literal(true),
                    idempotencySupported: z.literal(true),
                  }),
            );
          }
          return {
            name,
            status: "CONNECTED",
            detail:
              "Контракт, credentials и scope проверены; production E2E не подтверждён",
            capabilities: caps,
          };
        } catch (e) {
          const code = e instanceof ApiError ? e.code : "CONTRACT_MISMATCH";
          const status =
            code === "INTEGRATION_DATABASE_NOT_ATTESTED"
              ? "DATABASE_NOT_ATTESTED"
              : code === "INTEGRATION_DISABLED"
                ? "INTEGRATION_DISABLED"
                : code === "AUTH_FAILED" ||
                    code === "SCOPE_DENIED" ||
                    code === "V2_REQUIRES_SCOPED_PRINCIPAL"
                  ? "AUTH_FAILED"
                  : name === "n8n" && code === "CONTRACT_MISMATCH"
                    ? "WORKFLOW_NOT_DEPLOYED"
                    : code;
          return {
            name,
            status,
            detail: e instanceof ApiError ? e.message : "Discovery failed",
            capabilities: null,
          };
        }
      }),
    );
    const mappingReady =
      Boolean(
        c.crmProperty &&
        c.pmsProperty &&
        (!this.v2 || (c.crmTenant && c.pmsTenant)),
      ) && connections.slice(0, 2).every((x) => x.status === "CONNECTED");
    const sandboxAttested = orchestrationAllowed(c);
    return {
      connections,
      mappingReady,
      sandboxAttested,
      crmReady:
        connections[0].status === "CONNECTED" &&
        sandboxAttested &&
        Boolean(c.crmProperty),
      sandboxReady:
        connections.every((x) => x.status === "CONNECTED") &&
        mappingReady &&
        sandboxAttested &&
        c.callbackSecret.length >= 32 &&
        c.n8nToken.length >= 32,
      mediaScanner:
        c.scannerUrl && c.scannerToken
          ? "CONFIGURED_NOT_VERIFIED"
          : "MEDIA_SCANNER_NOT_CONFIGURED",
    };
  }
  async requireConnected() {
    const caps = await this.capabilities();
    if (!caps.sandboxReady)
      throw new ApiError(
        409,
        "CAPABILITIES_REQUIRED",
        "CRM/PMS/n8n scope и sandbox attestation не подтверждены",
      );
  }
  async inbound(
    conversation: Conversation,
    identity: Identity,
    attempt: Attempt,
    client: Client,
  ) {
    this.assertMapping(conversation);
    if (!orchestrationAllowed(this.cfg))
      throw new ApiError(
        403,
        "SANDBOX_REQUIRED",
        "Production simulator writes выключены",
      );
    if (this.v2) await this.crmV2.attest();
    return integrationHttp(
      this.cfg.crmUrl.replace(/\/$/, "") + "/messages/inbound",
      this.cfg,
      { "x-crm-api-key": this.cfg.crmKey },
      inboundResultSchema,
      this.inboundPayload(conversation, identity, attempt, client),
    );
  }
  inboundPayload(
    conv: Conversation,
    identity: Identity,
    attempt: Attempt,
    client: Client,
  ) {
    return {
      channel: "simulator" as const,
      propertyId: this.cfg.crmProperty,
      externalUserId: identity.externalUserId,
      externalChatId: conv.externalChatId,
      externalMessageId: attempt.externalMessageId,
      externalUpdateId: attempt.correlationId,
      text: attempt.text,
      firstName: client.firstName,
      lastName: client.lastName,
      displayName: client.displayName,
      language: client.language,
      attachments: attempt.attachments.map((a) => ({
        externalFileId: a.id,
        kind: a.kind,
        mimeType: a.mimeType,
        fileName: a.fileName,
        fileSize: a.size,
      })),
    };
  }
  envelope(
    workspaceId: string,
    conv: Conversation,
    identity: Identity,
    attempt: Attempt,
    client: Client,
    prompt: unknown,
    media: Attachment[],
  ) {
    const value = {
      contractVersion: "studio-gateway-v1",
      workspaceId,
      conversationId: conv.id,
      environment: this.cfg.environment ?? "production",
      runId: attempt.runId,
      correlationId: attempt.correlationId,
      inboundOwner: "n8n",
      externalMessageId: attempt.externalMessageId,
      property: {
        crmPropertyId: this.cfg.crmProperty,
        crmTenantId: this.cfg.crmTenant,
        pmsPropertyId: this.cfg.pmsProperty,
        pmsTenantId: this.cfg.pmsTenant,
      },
      inbound: this.inboundPayload(conv, identity, attempt, client),
      media,
      prompt,
      payloadHash: "0".repeat(64),
    };
    const parsed = envelopeSchema.parse(value);
    parsed.payloadHash = envelopeHash(parsed);
    return parsed;
  }
  async dispatch(
    workspaceId: string,
    conv: Conversation,
    identity: Identity,
    attempt: Attempt,
    client: Client,
    prompt: unknown,
    media: Attachment[],
    timeoutMs: number,
    frozen?: Envelope,
  ) {
    await this.requireConnected();
    this.assertMapping(conv);
    const envelope = frozen
      ? envelopeSchema.parse({
          ...frozen,
          media: frozen.media.map((a) => ({
            ...a,
            url: media.find((m) => m.id === a.id)?.url,
          })),
        })
      : this.envelope(
          workspaceId,
          conv,
          identity,
          attempt,
          client,
          prompt,
          media,
        );
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
        "Frozen dispatch mapping changed",
      );
    const receipt = await integrationHttp(
      this.cfg.n8nUrl,
      this.cfg,
      {
        Authorization: "Bearer " + this.cfg.n8nToken,
        "Idempotency-Key": `${workspaceId}:${conv.id}:${attempt.externalMessageId}`,
      },
      acceptedSchema,
      envelope,
      Math.min(timeoutMs, 10000),
    );
    if (
      receipt.runId !== attempt.runId ||
      receipt.payloadHash !== envelope.payloadHash
    )
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Workflow claim receipt mismatch",
      );
    return receipt;
  }
  assertMapping(conv: Conversation) {
    const m = conv.propertyMapping;
    if (
      m &&
      (m.crmPropertyId !== this.cfg.crmProperty ||
        m.pmsPropertyId !== this.cfg.pmsProperty ||
        m.crmTenantId !== this.cfg.crmTenant ||
        m.pmsTenantId !== this.cfg.pmsTenant ||
        m.environment !== this.cfg.environment)
    )
      throw new ApiError(
        409,
        "ENVIRONMENT_MISMATCH",
        "Conversation belongs to another property / environment",
      );
  }
  scope(conv: Conversation, identity: Identity) {
    this.assertMapping(conv);
    if (!conv.crmConversationId)
      throw new ApiError(
        409,
        "IDENTITY_NOT_VERIFIED",
        "CRM conversation не подтверждён",
      );
    return {
      channel: "simulator" as const,
      propertyId: this.cfg.crmProperty,
      externalUserId: identity.externalUserId,
      conversationId: conv.crmConversationId,
    };
  }
  message(conv: Conversation, m: z.infer<typeof crmMessageSchema>): Message {
    return {
      id: m.id,
      createdAt: m.at,
      updatedAt: now(),
      conversationId: conv.id,
      direction: m.direction === "in" ? "inbound" : "outbound",
      senderType:
        m.direction === "in"
          ? "guest"
          : m.senderType === "ai"
            ? "agent"
            : "human",
      text: m.text ?? "",
      externalMessageId: m.externalMessageId ?? undefined,
      deliveryStatus: m.deliveryStatus,
      attachments: m.attachments.map((a) => ({
        id: a.id,
        externalFileId: a.externalFileId ?? undefined,
        fileName: a.fileName ?? "attachment",
        mimeType: a.mimeType ?? "application/octet-stream",
        size: a.fileSize ?? 0,
        kind: ["image", "audio", "video"].includes(a.kind)
          ? (a.kind as "image" | "audio" | "video")
          : "document",
        processingStatus: a.processingStatus,
        transcript:
          a.processingStatus === "ready"
            ? (a.transcript ?? undefined)
            : undefined,
      })),
      source: "crm",
    };
  }
  async transcript(conv: Conversation, identity: Identity, after?: string) {
    if (!conv.crmConversationId)
      return {
        messages: [] as Message[],
        nextCursor: undefined,
        hasMore: false,
      };
    if (this.v2)
      throw new ApiError(
        409,
        "CONTRACT_MISMATCH",
        "V2 требует immutable changes; downgrade выключен",
      );
    const query = new URLSearchParams({
      channel: "simulator",
      propertyId: this.cfg.crmProperty,
      externalUserId: identity.externalUserId,
      limit: "100",
    });
    if (after) query.set("after", after);
    const result = await integrationHttp(
      `${this.cfg.crmUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conv.crmConversationId)}/messages?${query}`,
      this.cfg,
      { "x-crm-api-key": this.cfg.crmKey },
      z.object({
        messages: z.array(z.record(z.unknown())),
        nextCursor: z.string().nullable(),
      }),
    );
    const messages = result.messages
      .filter(
        (m) =>
          ["in", "out"].includes(String(m.direction)) &&
          !["note", "internal"].includes(String(m.senderType)),
      )
      .map((m) => this.message(conv, crmMessageSchema.parse(m)));
    return {
      messages,
      nextCursor:
        result.nextCursor ?? (result.messages.at(-1)?.id as string | undefined),
      hasMore: result.nextCursor !== null,
    };
  }
}
