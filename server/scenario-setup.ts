import type { Database } from "./db.js";
import type { Integrations } from "./integrations.js";
import { stageMapping } from "./crm-v2-contracts.js";
import { Repository, record, now } from "./repository.js";
import { ApiError, requireValue } from "./errors.js";
import type { Conversation, ScenarioRun, Identity } from "../shared/domain.js";
import { payloadHash } from "./gateway-contract.js";
export class ScenarioFixtures {
  constructor(
    public db: Database,
    public integrations: Integrations,
  ) {}
  async prepare(workspace: string, runId: string) {
    const r = new Repository(this.db, workspace),
      run = requireValue(await r.get<ScenarioRun>("scenario_runs", runId)),
      conv = requireValue(
        await r.get<Conversation>("conversation_refs", run.conversationId),
      );
    if (conv.mode !== "sandbox")
      throw new ApiError(
        409,
        "SETUP_UNAVAILABLE",
        "Fixtures требуют End-to-End Sandbox",
      );
    const stage = stageMapping[conv.stage];
    if (!stage)
      throw new ApiError(409, "CONTRACT_MISMATCH", "Unknown fixture stage");
    if (run.references.retiredAt)
      throw new ApiError(
        409,
        "FIXTURE_EXPIRED",
        "Retired fixture cannot be reused",
      );
    const caps = await this.integrations.capabilities();
    if (!caps.mappingReady || !caps.sandboxAttested || !this.integrations.v2)
      throw new ApiError(
        409,
        "SETUP_UNAVAILABLE",
        "Изолированная CRM/PMS среда не подтверждена",
      );
    const fixtureId =
      run.references.fixtureId ??
      "studio:" + payloadHash({ workspace, runId, conversationId: conv.id });
    await r.patch("scenario_runs", run.id, {
      references: { ...run.references, fixtureId },
      status: "SETUP_UNAVAILABLE",
      reason: "Ожидаем authoritative setup/read-back",
    });
    const fixture = await this.integrations.crmV2.fixture({
      propertyId: this.integrations.cfg.crmProperty,
      fixtureId,
      stage,
    });
    if (
      fixture.fixtureId !== fixtureId ||
      fixture.stage !== stage ||
      fixture.propertyId !== this.integrations.cfg.crmProperty ||
      fixture.pmsPropertyId !== this.integrations.cfg.pmsProperty ||
      fixture.externalUserId !== "fixture:" + fixtureId ||
      Date.parse(fixture.expiresAt) <= Date.now()
    )
      throw new ApiError(
        409,
        "FIXTURE_READBACK_MISMATCH",
        "Fixture references mismatch",
      );
    const scope = {
      channel: "simulator" as const,
      propertyId: fixture.propertyId,
      externalUserId: fixture.externalUserId,
      conversationId: fixture.conversationId,
    };
    const context = await this.integrations.crmV2.context(scope);
    if (
      context.customerId !== fixture.customerId ||
      fixture.snapshots.some(
        (s) =>
          s.propertyId !== fixture.pmsPropertyId ||
          s.guestId !== fixture.refs.guestId,
      )
    )
      throw new ApiError(
        409,
        "IDENTITY_CONFLICT",
        "Fixture guest references mismatch",
      );
    const reservationStates: Record<string, string> = {
      returning_customer: "checked_out",
      post_stay: "checked_out",
      pending_payment: "pending",
      confirmed_reservation: "confirmed",
      pre_arrival: "confirmed",
      in_house: "checked_in",
      due_out: "checked_in",
      cancelled: "cancelled",
    };
    const expected = reservationStates[stage];
    if (
      (expected &&
        !fixture.snapshots.some(
          (s) =>
            s.entityType === "reservation" &&
            s.id === fixture.refs.reservationId &&
            s.status === expected,
        )) ||
      (stage === "service_only" &&
        !fixture.snapshots.some(
          (s) =>
            s.entityType === "service_booking" &&
            s.id === fixture.refs.serviceBookingId &&
            s.status === "scheduled",
        )) ||
      (stage === "human_handoff" && context.aiReplyAllowed) ||
      (["tentative", "definite"].includes(stage) &&
        context.context.request?.requestLifecycle !== stage)
    )
      throw new ApiError(
        409,
        "FIXTURE_READBACK_MISMATCH",
        "Fixture business stage not confirmed by authoritative read-back",
      );
    const references = {
      fixtureId,
      crmCustomerId: fixture.customerId,
      crmConversationId: fixture.conversationId,
      pmsGuestId: fixture.refs.guestId,
      externalUserId: fixture.externalUserId,
      externalChatId: "fixture:" + fixtureId,
      crmPropertyId: fixture.propertyId,
      pmsPropertyId: fixture.pmsPropertyId,
      expiresAt: fixture.expiresAt,
      verifiedAt: now(),
      verificationSource: "crm-v2/fixture+context-readback",
    };
    await this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM conversation_refs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspace, conv.id],
      );
      const repo = new Repository(tx, workspace),
        fresh = requireValue(
          await repo.get<Conversation>("conversation_refs", conv.id),
        );
      if (
        fresh.crmConversationId &&
        fresh.crmConversationId !== fixture.conversationId
      )
        throw new ApiError(
          409,
          "IDENTITY_CONFLICT",
          "Conversation already mapped",
        );
      const attempts = await tx.query(
        "SELECT id FROM message_attempts WHERE workspace_id=$1 AND conversation_id=$2",
        [workspace, conv.id],
      );
      if (attempts.length && fresh.crmConversationId !== fixture.conversationId)
        throw new ApiError(
          409,
          "SETUP_AFTER_MESSAGE_DENIED",
          "Fixture must precede messaging",
        );
      let identity = (await repo.list<Identity>("virtual_identities")).find(
        (i) => i.externalUserId === fixture.externalUserId,
      );
      if (identity && identity.clientId !== conv.clientId)
        throw new ApiError(
          409,
          "IDENTITY_CONFLICT",
          "Fixture belongs to another virtual client",
        );
      if (!identity) {
        identity = record({
          clientId: conv.clientId,
          displayChannel: requireValue(
            await repo.get<Identity>("virtual_identities", conv.identityId),
          ).displayChannel,
          transportChannel: "simulator" as const,
          externalUserId: fixture.externalUserId,
          crmCustomerId: fixture.customerId,
          pmsGuestId: fixture.refs.guestId,
          environment: this.integrations.cfg.environment,
          verifiedAt: now(),
          verificationSource: references.verificationSource,
        });
        await repo.put("virtual_identities", identity);
      }
      await repo.patch("conversation_refs", conv.id, {
        identityId: identity.id,
        externalChatId: references.externalChatId,
        crmConversationId: fixture.conversationId,
        crmCustomerId: fixture.customerId,
        pmsGuestId: fixture.refs.guestId,
        changesCursor: 0,
        setupStatus: "READY",
        handoff: !context.aiReplyAllowed,
      });
      await tx.query(
        "UPDATE conversation_refs SET identity_id=$3,external_chat_id=$4 WHERE workspace_id=$1 AND id=$2",
        [workspace, conv.id, identity.id, references.externalChatId],
      );
      await repo.patch("scenario_runs", run.id, {
        status: "READY",
        reason: "CRM/PMS fixture и guest context подтверждены API",
        references,
      });
      await repo.put("integration_mappings", {
        ...record({
          studioClientId: conv.clientId,
          virtualIdentityId: identity.id,
          workspaceId: workspace,
          environment: this.integrations.cfg.environment,
          ...references,
          propertyMapping: conv.propertyMapping,
        }),
        id: "conversation:" + conv.id,
      });
    });
    return requireValue(await r.get<ScenarioRun>("scenario_runs", run.id));
  }
  async retire(workspace: string, id: string) {
    const r = new Repository(this.db, workspace),
      run = requireValue(await r.get<ScenarioRun>("scenario_runs", id)),
      key = run.references.fixtureId;
    if (!key)
      throw new ApiError(409, "SETUP_UNAVAILABLE", "Fixture not registered");
    const result = await this.integrations.crmV2.retire(key);
    await r.patch("scenario_runs", id, {
      status: "SETUP_UNAVAILABLE",
      reason: "Fixture retired; audit retained",
      references: { ...run.references, retiredAt: now() },
    });
    await r.patch("conversation_refs", run.conversationId, {
      setupStatus: "SETUP_UNAVAILABLE",
      handoff: true,
    });
    return result;
  }
  async simulatePayment(workspace: string, id: string) {
    const r = new Repository(this.db, workspace),
      run = requireValue(await r.get<ScenarioRun>("scenario_runs", id));
    if (
      run.status !== "READY" ||
      !run.references.fixtureId ||
      run.references.retiredAt
    )
      throw new ApiError(409, "SETUP_UNAVAILABLE", "Verified fixture required");
    const result = await this.integrations.crmV2.simulatePayment(
      run.references.fixtureId,
    );
    await r.audit(
      "scenario fixture",
      "simulated_payment",
      run.id,
      "source=simulated; ledgerEffect=false; providerVerified=false",
    );
    return result;
  }
}
