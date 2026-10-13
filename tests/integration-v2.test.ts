import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  it,
  expect,
  vi,
} from "vitest";
import request from "supertest";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { migrate, type Database } from "../server/db";
import { testDatabase } from "./test-database";
import { seed } from "../server/seed";
import { createApp } from "../server/app";
import { Repository, record } from "../server/repository";
import { envelopeHash, type Envelope } from "../server/gateway-contract";
import { stageMapping, approvedTools } from "../server/crm-v2-contracts";
import {
  assertDatabaseOwnership,
  databaseReadiness,
} from "../server/readiness";
import type { Config } from "../server/config";
import type {
  Conversation,
  Client,
  Identity,
  Run,
  Attempt,
  Message,
  Prompt,
  ScenarioRun,
} from "../shared/domain";
const cfg: Config = {
  port: 4310,
  host: "127.0.0.1",
  publicUrl: "https://studio.test.invalid",
  local: true,
  dataDir: "memory://",
  mediaDir: ".local/v2-test-media",
  signingSecret: "test-signing-secret-only-32-characters",
  sandbox: true,
  environment: "test",
  crmVersion: "v2",
  allowedHosts: ["contract.test.invalid"],
  integrationHosts: ["contract.test.invalid"],
  crmUrl: "https://contract.test.invalid/api/integrations/agent",
  crmKey: "test-key",
  pmsUrl: "https://contract.test.invalid/api/v1/connect",
  pmsKey: "test-key",
  n8nUrl: "https://contract.test.invalid/webhook/guestra-studio",
  n8nCapabilitiesUrl:
    "https://contract.test.invalid/webhook/guestra-studio-capabilities",
  n8nToken: "test-orchestrator-bearer-only-32-characters",
  callbackSecret: "test-callback-secret-only-32-characters",
  crmProperty: "crm-property",
  pmsProperty: "00000000-0000-4000-a000-000000000001",
  crmTenant: "crm-tenant",
  pmsTenant: "pms-tenant",
  orchestratorWorkspaces: ["les-sandbox"],
  scannerUrl: "",
  scannerToken: "",
};
const cap = {
  contractVersion: "guestra-crm-integration-v2",
  environment: "test",
  propertyId: cfg.crmProperty,
  tenantId: cfg.crmTenant,
  pmsPropertyId: cfg.pmsProperty,
  pmsTenantId: cfg.pmsTenant,
  deploymentId: "crm-test-deployment",
  verifiedMapping: true,
  operationalAuthority: "guestra_pms",
  features: {
    durableOperations: true,
    guestMessageChanges: true,
    operationReceipts: true,
  },
};
const pmsCap = {
  contractVersion: "guestra-connect-v2",
  environment: "test",
  sourceSystem: "guestra_pms",
  propertyId: cfg.pmsProperty,
  tenantId: cfg.pmsTenant,
  deploymentId: "pms-test-deployment",
  credentialId: "pms-test-read-principal",
  ownership: ["guests", "inventory", "reservations", "folios", "payments"],
  features: {
    acceptedQuote: true,
    operationReceipts: true,
    durableEvents: true,
    authoritativeReadBack: true,
    paymentLinks: false,
  },
};
const guestId = "00000000-0000-4000-a000-000000000010";
const reservationId = "00000000-0000-4000-a000-000000000011";
const snapshot = {
  id: reservationId,
  entityType: "reservation",
  propertyId: cfg.pmsProperty,
  guestId,
  status: "confirmed",
  revision: 1,
  integrationContext: {
    sourceSystem: "guestra_crm",
    customerId: "crm-customer",
  },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let db: Database,
  platform: ReturnType<typeof createApp>,
  browser: ReturnType<typeof request.agent>,
  repo: Repository,
  client: Client;
let feed: {
    sequence: number;
    kind: string;
    messageId: string;
    message?: unknown;
  }[] = [],
  human = false,
  operationStatus = "pending",
  lastScope: { conversationId: string; externalUserId: string } | undefined,
  inboundCount = 0,
  dispatchCount = 0,
  loseResponse = false;
function context(conversationId: string) {
  const ai = !human;
  return {
    customerId: "crm-customer",
    conversationId,
    automationMode: ai ? "ai" : "human",
    aiReplyAllowed: ai,
    operationalAuthority: "guestra_pms",
    projections: [],
    context: {
      contractVersion: "agent-api-v1",
      property: {
        id: cfg.crmProperty,
        name: "Test property",
        timezone: "Asia/Qyzylorda",
      },
      customer: {
        id: "crm-customer",
        name: "Test guest",
        language: "ru",
        repeatGuest: false,
        stayCount: 0,
      },
      conversation: {
        id: conversationId,
        channel: "simulator",
        automationMode: ai ? "ai" : "human",
        handoffNote: "PRIVATE STAFF NOTE",
      },
      lifecycle: "new_contact",
      request: null,
      offer: null,
      recentMessages: [
        {
          id: "private",
          direction: "note",
          senderType: "internal",
          text: "PRIVATE STAFF NOTE",
          at: new Date().toISOString(),
        },
      ],
      aiReplyAllowed: ai,
      allowedActions: ai
        ? ["search_accommodation", "create_pms_offer", "book_accommodation"]
        : [],
      operationalAuthority: "guestra_pms",
      pmsReferences: [],
      testerNotes: "NEVER SEND THIS",
    },
  };
}
function msg(
  id: string,
  text = "guest",
  direction = "in",
  deliveryStatus = "received",
  externalMessageId?: string,
) {
  return {
    id,
    direction,
    senderType: direction === "in" ? "contact" : "ai",
    text,
    at: new Date().toISOString(),
    deliveryStatus,
    externalMessageId,
    attachments: [],
  };
}
async function fakeTransport(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input)),
    path = url.pathname,
    body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url.hostname !== "contract.test.invalid")
    throw Error("Unexpected external request");
  if (path.endsWith("/v2/capabilities"))
    return json(path.startsWith("/api/v1") ? pmsCap : cap);
  if (path.endsWith("guestra-studio-capabilities"))
    return json({
      contractVersion: "studio-gateway-v1",
      environment: "test",
      inboundOwner: "n8n",
      durableClaim: "studio-claim-v1",
      workflowId: "test-workflow",
      deploymentId: "test-deployment",
      property: {
        crmPropertyId: cfg.crmProperty,
        crmTenantId: cfg.crmTenant,
        pmsPropertyId: cfg.pmsProperty,
        pmsTenantId: cfg.pmsTenant,
      },
      workspaceIds: ["les-sandbox"],
    });
  if (path.endsWith("/v2/context")) {
    lastScope = {
      conversationId: url.searchParams.get("conversationId")!,
      externalUserId: url.searchParams.get("externalUserId")!,
    };
    return json(context(lastScope.conversationId));
  }
  if (path.endsWith("/changes")) {
    const after = Number(url.searchParams.get("after")),
      eligible = feed.filter((x) => x.sequence > after),
      changes = eligible.slice(0, 2);
    return json({
      contractVersion: "guest-message-changes-v1",
      conversationId: url.searchParams.get("conversationId"),
      nextCursor: changes.at(-1)?.sequence ?? after,
      hasMore: eligible.length > 2,
      changes,
    });
  }
  if (path.endsWith("/v2/inspector"))
    return json({
      customerId: "crm-customer",
      conversationId: url.searchParams.get("conversationId"),
      events: [],
    });
  if (path.includes("/v2/operations/"))
    return json({
      operationId: "operation-test",
      operationKey: "stable-key",
      status: operationStatus,
      result: operationStatus === "completed" ? snapshot : null,
      errorCode: operationStatus === "rejected" ? "PRICE_CHANGED" : null,
      attempts: 1,
    });
  if (path.endsWith("/messages/inbound")) {
    inboundCount++;
    return json({
      messageId: "crm-in-" + body.externalMessageId,
      duplicate: false,
      context: {
        conversation: { id: "crm-conversation" },
        customer: { id: "crm-customer" },
      },
      aiReplyAllowed: !human,
      allowedActions: [],
    });
  }
  if (path.endsWith("/webhook/guestra-studio")) {
    dispatchCount++;
    const envelope = body as Envelope;
    const receipt = await platform.claims.claim(
      envelope,
      "execution-" + envelope.runId,
    );
    if (receipt.execute) {
      inboundCount++;
      feed.push({
        sequence: feed.length + 1,
        kind: "created",
        messageId: "crm-in-" + envelope.externalMessageId,
        message: msg(
          "crm-in-" + envelope.externalMessageId,
          envelope.inbound.text,
          "in",
          "received",
          envelope.externalMessageId,
        ),
      });
    }
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Simulated response loss after durable claim");
    }
    return json(receipt);
  }
  if (
    path.endsWith("/v2/accommodations/book") ||
    path.endsWith("/v2/actions") ||
    path.endsWith("/v2/guest-requests")
  )
    return json({
      operationId: "operation-test",
      status: operationStatus,
      snapshot: operationStatus === "completed" ? snapshot : null,
    });
  if (path.endsWith("/v2/accommodations/search"))
    return json({
      source: "haip",
      sourceVersion: "1.0.0",
      searchId: randomUUID(),
      timestamp: new Date().toISOString(),
      results: [],
      totalResults: 0,
      responseTimeMs: 1,
    });
  if (path.endsWith("/v2/services")) return json({ services: [] });
  if (path.endsWith("/v2/services/availability"))
    return json({
      serviceId: body.serviceId,
      available: false,
      bookingMode: "live_booking",
    });
  if (path.endsWith("/v2/offers"))
    return json({
      offer: { id: "offer-test" },
      pricing: {
        acceptedQuote: "test-signed-quote",
        totalAmount: "10000.00",
        currency: "KZT",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      },
      duplicate: false,
    });
  throw Error("Unhandled contract route " + path);
}
async function chat(mode = "preview") {
  await db.query("UPDATE workspaces SET mode=$1 WHERE id='les-sandbox'", [
    mode,
  ]);
  return (
    await browser
      .post("/api/conversations")
      .send({
        clientId: client.id,
        title: "v2 test",
        channel: "whatsapp",
        stage: "new_contact",
      })
      .expect(201)
  ).body as Conversation;
}
async function enqueue(conv: Conversation, text = "Hello") {
  return (
    await browser
      .post("/api/conversations/" + conv.id + "/messages")
      .send({ text, externalMessageId: randomUUID(), attachmentIds: [] })
      .expect(202)
  ).body as Attempt;
}
function signedEvent(run: Run, event: Record<string, unknown>) {
  const body = JSON.stringify({
    eventId: randomUUID(),
    workspaceId: repo.workspaceId,
    runId: run.id,
    correlationId: run.correlationId,
    crmConversationId: "crm-conversation",
    executionId: run.claim?.executionId,
    sequence: 1,
    ...event,
  });
  const time = String(Math.floor(Date.now() / 1000));
  return request(platform.app)
    .post("/api/integrations/n8n/events")
    .set("Content-Type", "application/json")
    .set("x-studio-timestamp", time)
    .set(
      "x-studio-signature",
      createHmac("sha256", cfg.callbackSecret)
        .update(time + "." + body)
        .digest("hex"),
    )
    .send(body);
}
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  await seed(db, true);
  platform = createApp(db, cfg);
  repo = new Repository(db, "les-sandbox");
  browser = request.agent(platform.app);
  await browser.post("/api/auth/local").expect(200);
  client = (await repo.list<Client>("virtual_clients"))[0];
});
beforeEach(async () => {
  vi.restoreAllMocks();
  feed = [];
  human = false;
  operationStatus = "pending";
  inboundCount = 0;
  dispatchCount = 0;
  loseResponse = false;
  await db.query("UPDATE conversation_refs SET lease_until=NULL");
  await db.query(
    "UPDATE message_attempts SET status='failed',data=data||'{\"status\":\"failed\"}'::jsonb",
  );
  await db.query(
    'UPDATE agent_runs SET data=data||\'{"status":"failed"}\'::jsonb',
  );
  await db.query("UPDATE workspaces SET mode='preview' WHERE id='les-sandbox'");
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeTransport);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => db.close());
it("maps legacy tool names before intersecting authoritative action permission", () => {
  expect(
    approvedTools(
      [
        "check_accommodation_availability",
        "create_offer",
        "book_accommodation",
      ],
      ["search_accommodation", "create_pms_offer"],
      true,
    ),
  ).toEqual(["search_accommodation", "create_pms_offer"]);
  expect(
    approvedTools(["book_accommodation"], ["book_accommodation"], false),
  ).toEqual([]);
});
it("freezes a selectable test prompt and preserves its run snapshot", async () => {
  const base = (await repo.list<Prompt>("prompt_versions"))[0];
  const draft = (
    await browser
      .post("/api/agents/" + base.agentId + "/prompts")
      .send({ body: "Immutable test prompt" })
      .expect(201)
  ).body as Prompt;
  await browser.post("/api/prompts/" + draft.id + "/test-version").expect(200);
  await browser
    .patch("/api/prompts/" + draft.id)
    .send({ body: "mutated" })
    .expect(409);
  const conv = (
    await browser
      .post("/api/conversations")
      .send({
        clientId: client.id,
        title: "Specific prompt",
        channel: "whatsapp",
        stage: "new_contact",
        agentId: base.agentId,
        promptVersionId: draft.id,
      })
      .expect(201)
  ).body as Conversation;
  const a = await enqueue(conv);
  const run = (await repo.get<Run>("agent_runs", a.runId))!;
  expect(run.promptSnapshot).toBe("Immutable test prompt");
  expect(run.promptVersionId).toBe(draft.id);
});
it("passes sanitized trace correlation via the actual CRM query contract", async () => {
  const correlationId = randomUUID(),
    adapter = platform.integrations.crmV2.withTrace({
      correlationId,
      executionReference: "n8n-execution",
      promptVersion: "test-prompt",
    });
  await adapter.search({
    channel: "simulator",
    propertyId: cfg.crmProperty,
    externalUserId: "virtual",
    conversationId: "crm-conversation",
    checkIn: "2027-01-01",
    checkOut: "2027-01-02",
    adults: 1,
  });
  const call = vi
    .mocked(fetch)
    .mock.calls.find(([url]) => String(url).includes("accommodations/search"))!;
  expect(new URL(String(call[0])).searchParams.get("correlationId")).toBe(
    correlationId,
  );
});
it("blocks final completion while business outcome is pending and retains unknown recovery", async () => {
  const conv = await chat("sandbox"),
    a = await enqueue(conv);
  await platform.gateway.tick();
  const run = (await repo.get<Run>("agent_runs", a.runId))!;
  await signedEvent(run, {
    state: "business_pending",
    businessOperationId: "operation-test",
  }).expect(200);
  await signedEvent(run, { sequence: 2, state: "completed" }).expect(409);
  await signedEvent(run, {
    sequence: 3,
    state: "failed",
    errorCode: "UPSTREAM_TIMEOUT",
  }).expect(200);
  expect((await repo.get<Run>("agent_runs", run.id))?.status).toBe(
    "completion_unknown",
  );
  const next = await enqueue(conv);
  await expect(
    platform.claims.claim(
      (await repo.get<Run>("agent_runs", next.runId))!.dispatchEnvelope!,
      "another-execution",
    ),
  ).rejects.toThrow("Previous logical run");
});
it("refreshes media only for an active claimed run and never another workspace/asset", async () => {
  const asset = record({
    storageKey: randomUUID(),
    ownerId: "tester",
    fileName: "voice.ogg",
    kind: "audio" as const,
    mimeType: "audio/ogg",
    size: 16,
    scanStatus: "clean",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await repo.put("media_assets", asset);
  const conv = await chat("sandbox");
  const a = (
    await browser
      .post("/api/conversations/" + conv.id + "/messages")
      .send({
        text: "",
        externalMessageId: randomUUID(),
        attachmentIds: [asset.id],
      })
      .expect(202)
  ).body as Attempt;
  const run = (await repo.get<Run>("agent_runs", a.runId))!;
  await platform.claims.claim(run.dispatchEnvelope!, "media-execution");
  const exchange = await request(platform.app)
    .post("/api/integrations/n8n/media/exchange")
    .set("Authorization", "Bearer " + cfg.n8nToken)
    .send({ workspaceId: repo.workspaceId, runId: run.id, assetId: asset.id })
    .expect(200);
  const url = new URL(exchange.body.url);
  expect(url.origin).toBe(cfg.publicUrl);
  expect(url.searchParams.get("purpose")).toBe("workflow");
  await request(platform.app)
    .post("/api/integrations/n8n/media/exchange")
    .set("Authorization", "Bearer " + cfg.n8nToken)
    .send({ workspaceId: repo.workspaceId, runId: run.id, assetId: "unowned" })
    .expect(403);
  await request(platform.app)
    .post("/api/integrations/n8n/media/exchange")
    .set("Authorization", "Bearer " + cfg.n8nToken)
    .send({ workspaceId: "other", runId: run.id, assetId: asset.id })
    .expect(403);
});
it("pins adapter property and validates every confirmed action variant", async () => {
  const scope = {
    channel: "simulator" as const,
    propertyId: cfg.crmProperty,
    externalUserId: "virtual",
    conversationId: "crm-conversation",
    proposalMessageId: "delivered-proposal",
    confirmationMessageId: "later-guest-reply",
    idempotencyKey: "stable",
  };
  await expect(
    platform.integrations.crmV2.services({
      channel: scope.channel,
      externalUserId: scope.externalUserId,
      conversationId: scope.conversationId,
      propertyId: "other-property",
    }),
  ).rejects.toThrow("property scope");
  const actions = [
    {
      actionType: "book_service",
      payload: {
        serviceId: guestId,
        startAt: "2027-01-01T09:00:00Z",
        endAt: "2027-01-01T10:00:00Z",
        participants: 1,
        expectedTotal: "10.00",
      },
    },
    {
      actionType: "reschedule_service",
      payload: {
        entityId: guestId,
        expectedRevision: 1,
        startAt: "2027-01-01T09:00:00Z",
        endAt: "2027-01-01T10:00:00Z",
      },
    },
    {
      actionType: "cancel_service",
      payload: { entityId: guestId, expectedRevision: 1 },
    },
    {
      actionType: "cancel_accommodation",
      payload: {
        entityId: reservationId,
        expectedUpdatedAt: "2027-01-01T00:00:00Z",
      },
    },
    {
      actionType: "amend_accommodation",
      payload: {
        entityId: reservationId,
        expectedUpdatedAt: "2027-01-01T00:00:00Z",
        acceptedQuote: "signed-quote",
      },
    },
  ];
  for (const action of actions)
    expect(
      (
        await platform.integrations.crmV2.action({
          ...scope,
          ...action,
        } as never)
      ).status,
    ).toBe("pending");
});
it("preserves local annotation target while binding a proven CRM message reference", async () => {
  const conv = await chat("sandbox"),
    a = await enqueue(conv);
  const annotation = (
    await browser
      .post("/api/annotations")
      .send({
        conversationId: conv.id,
        targetType: "message",
        targetId: a.id,
        body: "Review pending input",
        severity: "warning",
        type: "quality",
        flags: [],
      })
      .expect(201)
  ).body;
  await browser
    .patch("/api/annotations/" + annotation.id + "/reference")
    .send({ reference: "unverified" })
    .expect(409);
  await repo.patch("message_attempts", a.id, {
    crmMessageId: "verified-crm-message",
  });
  await browser
    .patch("/api/annotations/" + annotation.id + "/reference")
    .send({ reference: "verified-crm-message" })
    .expect(200);
  const stored = await repo.get<{
    targetId: string;
    externalReference: string;
    body: string;
  }>("tester_annotations", annotation.id);
  expect(stored).toMatchObject({
    targetId: a.id,
    externalReference: "verified-crm-message",
    body: "Review pending input",
  });
});
it("attests CRM/PMS contracts independently of deployed URL and sandbox flag", async () => {
  expect((await platform.integrations.capabilities()).sandboxReady).toBe(true);
  const production = createApp(db, {
    ...cfg,
    environment: "production",
    sandbox: true,
  });
  const caps = await production.integrations.capabilities();
  expect(caps.sandboxReady).toBe(false);
  expect(caps.connections[0].status).toBe("ENVIRONMENT_MISMATCH");
});
it("fails closed for optional migration/flag and authentication errors without v1 downgrade", async () => {
  vi.mocked(fetch).mockResolvedValue(
    json({ code: "INTEGRATION_DATABASE_NOT_ATTESTED" }, 503),
  );
  expect(
    (await platform.integrations.capabilities()).connections[0].status,
  ).toBe("DATABASE_NOT_ATTESTED");
  vi.mocked(fetch).mockResolvedValue(
    json({ code: "INTEGRATION_DISABLED" }, 503),
  );
  expect(
    (await platform.integrations.capabilities()).connections[0].status,
  ).toBe("INTEGRATION_DISABLED");
  vi.mocked(fetch).mockResolvedValue(json({ code: "SCOPE_DENIED" }, 403));
  expect(
    (await platform.integrations.capabilities()).connections[0].status,
  ).toBe("AUTH_FAILED");
  vi.mocked(fetch).mockResolvedValue(json({ contractVersion: "agent-api-v1" }));
  expect(
    (await platform.integrations.capabilities()).connections[0].status,
  ).toBe("CONTRACT_MISMATCH");
});
it("denies wrong tenants/properties and unallowlisted endpoints", async () => {
  vi.mocked(fetch).mockResolvedValue(json({ ...cap, pmsTenantId: "other" }));
  expect((await platform.integrations.capabilities()).mappingReady).toBe(false);
  const unsafe = createApp(db, {
    ...cfg,
    crmUrl:
      "https://guestracrm-production.up.railway.app/api/integrations/agent",
  });
  expect((await unsafe.integrations.capabilities()).connections[0].status).toBe(
    "ENVIRONMENT_MISMATCH",
  );
});
it("maps safe CRM context and omits tester annotations and internal notes", async () => {
  const result = await platform.integrations.crmV2.context({
    channel: "simulator",
    propertyId: cfg.crmProperty,
    externalUserId: "virtual-1",
    conversationId: "crm-conversation",
  });
  expect(result.customerId).toBe("crm-customer");
  expect(JSON.stringify(result)).not.toContain("PRIVATE STAFF NOTE");
  expect(JSON.stringify(result)).not.toContain("NEVER SEND THIS");
  expect(result.context.recentMessages).toEqual([]);
});
it("drains immutable cursor pages, updates delivery/media, merges duplicates and keeps tombstones", async () => {
  const conv = await chat();
  await repo.patch("conversation_refs", conv.id, {
    mode: "crm",
    crmConversationId: "crm-conversation",
  });
  const m = msg("reply", "proposal", "out", "pending");
  feed = [
    { sequence: 1, kind: "created", messageId: "reply", message: m },
    {
      sequence: 2,
      kind: "updated",
      messageId: "reply",
      message: { ...m, deliveryStatus: "sent" },
    },
    {
      sequence: 3,
      kind: "created",
      messageId: "late",
      message: msg("late", "late response", "out", "sent"),
    },
    {
      sequence: 4,
      kind: "media",
      messageId: "reply",
      message: {
        ...m,
        deliveryStatus: "sent",
        attachments: [
          {
            id: "crm-a",
            externalFileId: "external-a",
            kind: "audio",
            mimeType: "audio/ogg",
            fileName: "voice.ogg",
            fileSize: 10,
            processingStatus: "ready",
            transcript: "Guest-safe transcript",
          },
        ],
      },
    },
    { sequence: 5, kind: "tombstone", messageId: "late" },
  ];
  await platform.gateway.reconcile(
    repo,
    (await repo.get<Conversation>("conversation_refs", conv.id))!,
  );
  await platform.gateway.reconcile(
    repo,
    (await repo.get<Conversation>("conversation_refs", conv.id))!,
  );
  expect(
    (await repo.get<Conversation>("conversation_refs", conv.id))?.changesCursor,
  ).toBe(5);
  expect(
    (await repo.get<Message>("transcript_snapshots", "reply"))?.attachments[0]
      .transcript,
  ).toBe("Guest-safe transcript");
  expect(
    (await repo.get<Message>("transcript_snapshots", "late"))?.tombstone,
  ).toBe(true);
  const timeline = (
    await browser.get("/api/conversations/" + conv.id + "/timeline").expect(200)
  ).body;
  expect(timeline.messages.map((m: Message) => m.id)).toEqual(["reply"]);
  expect(timeline.removedMessageIds).toContain("late");
});
it("persists cursor through outage and rejects malformed/out-of-order changes", async () => {
  const conv = await chat();
  await repo.patch("conversation_refs", conv.id, {
    mode: "crm",
    crmConversationId: "crm-conversation",
    changesCursor: 10,
  });
  vi.mocked(fetch).mockRejectedValueOnce(Error("outage"));
  await expect(
    platform.gateway.reconcile(
      repo,
      (await repo.get<Conversation>("conversation_refs", conv.id))!,
    ),
  ).rejects.toThrow();
  expect(
    (await repo.get<Conversation>("conversation_refs", conv.id))?.changesCursor,
  ).toBe(10);
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).includes("/changes")
      ? json({
          contractVersion: "guest-message-changes-v1",
          conversationId: "crm-conversation",
          nextCursor: 12,
          hasMore: false,
          changes: [
            { sequence: 12, kind: "tombstone", messageId: "x" },
            { sequence: 11, kind: "tombstone", messageId: "y" },
          ],
        })
      : fakeTransport(input, init),
  );
  await expect(
    platform.gateway.reconcile(
      repo,
      (await repo.get<Conversation>("conversation_refs", conv.id))!,
    ),
  ).rejects.toThrow("changes cursor");
  expect(
    (await repo.get<Conversation>("conversation_refs", conv.id))?.changesCursor,
  ).toBe(10);
});
it("durably claims identical dispatch once, conflicts changed payload and scopes authentication", async () => {
  const conv = await chat("sandbox"),
    a = await enqueue(conv),
    run = (await repo.get<Run>("agent_runs", a.runId))!,
    envelope = run.dispatchEnvelope!;
  const results = await Promise.all([
    platform.claims.claim(envelope, "exec-1"),
    platform.claims.claim(envelope, "exec-2"),
  ]);
  expect(results.filter((x) => x.execute)).toHaveLength(1);
  expect(results[0].runId).toBe(results[1].runId);
  const changed = {
    ...envelope,
    inbound: { ...envelope.inbound, text: "different" },
  };
  changed.payloadHash = envelopeHash(changed);
  await expect(platform.claims.claim(changed, "exec-3")).rejects.toThrow(
    "durable dispatch",
  );
  await request(platform.app)
    .post("/api/integrations/n8n/claims")
    .send({ envelope, executionId: "x" })
    .expect(401);
  await expect(
    platform.claims.claim({ ...envelope, workspaceId: "other" }, "exec-other"),
  ).rejects.toThrow("workspace");
});
it("lost webhook response and duplicate n8n execution keep one inbound and frozen prompt payload", async () => {
  const conv = await chat("sandbox"),
    a = await enqueue(conv);
  loseResponse = true;
  await platform.gateway.tick();
  expect(inboundCount).toBe(1);
  await repo.patch("message_attempts", a.id, {
    nextAt: new Date(0).toISOString(),
  });
  await platform.gateway.tick();
  expect(dispatchCount).toBe(2);
  expect(inboundCount).toBe(1);
  const run = (await repo.get<Run>("agent_runs", a.runId))!;
  expect(run.claim?.payloadHash).toBe(run.dispatchHash);
  expect(run.dispatchEnvelope?.inbound.externalMessageId).toBe(
    a.externalMessageId,
  );
  expect(run.promptHash).toHaveLength(64);
});
it("rejects accepted:true without durable claim", async () => {
  const conv = await chat("sandbox"),
    a = await enqueue(conv);
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).includes("/webhook/guestra-studio") &&
    !String(input).endsWith("capabilities")
      ? json({ accepted: true })
      : fakeTransport(input, init),
  );
  await platform.gateway.tick();
  expect((await repo.get<Run>("agent_runs", a.runId))?.claim).toBeUndefined();
  expect((await repo.get<Run>("agent_runs", a.runId))?.status).toBe("failed");
});
it("serializes logical runs within a conversation but allows different conversations", async () => {
  const first = await chat("sandbox"),
    second = await chat("sandbox"),
    a = await enqueue(first),
    b = await enqueue(first),
    c = await enqueue(second);
  const ra = (await repo.get<Run>("agent_runs", a.runId))!,
    rb = (await repo.get<Run>("agent_runs", b.runId))!,
    rc = (await repo.get<Run>("agent_runs", c.runId))!;
  await platform.claims.claim(ra.dispatchEnvelope!, "one");
  await expect(
    platform.claims.claim(rb.dispatchEnvelope!, "two"),
  ).rejects.toThrow("Previous logical run");
  expect(
    (await platform.claims.claim(rc.dispatchEnvelope!, "three")).execute,
  ).toBe(true);
});
it("receives signed sequenced events, rejects changed event ID and does not infer guest delivery", async () => {
  const conv = await chat("sandbox"),
    a = await enqueue(conv);
  await platform.gateway.tick();
  const run = (await repo.get<Run>("agent_runs", a.runId))!;
  feed = [];
  const eventId = randomUUID();
  await signedEvent(run, { eventId, sequence: 2, state: "completed" }).expect(
    200,
  );
  await signedEvent(run, { eventId, sequence: 2, state: "completed" }).expect(
    200,
  );
  await signedEvent(run, {
    eventId,
    sequence: 2,
    state: "failed",
    errorCode: "TOOL_FAILED",
  }).expect(409);
  await signedEvent(run, { sequence: 1, state: "inbound_saved" }).expect(200);
  expect((await repo.get<Run>("agent_runs", run.id))?.status).toBe("completed");
  expect((await repo.get<Attempt>("message_attempts", a.id))?.status).toBe(
    "awaiting_crm",
  );
});
it("business pending/completed are distinct and completed requires receipt read-back", async () => {
  const conv = await chat("sandbox"),
    a = await enqueue(conv);
  await platform.gateway.tick();
  const run = (await repo.get<Run>("agent_runs", a.runId))!;
  await signedEvent(run, {
    state: "business_pending",
    businessOperationId: "operation-test",
  }).expect(200);
  await signedEvent(run, {
    sequence: 2,
    state: "business_completed",
    businessOperationId: "operation-test",
  }).expect(409);
  operationStatus = "completed";
  await signedEvent(run, {
    sequence: 2,
    state: "business_completed",
    businessOperationId: "operation-test",
  }).expect(200);
  expect((await repo.get<Run>("agent_runs", run.id))?.businessStatus).toBe(
    "completed",
  );
});
it("human takeover remains sticky and cannot be bypassed by late completion", async () => {
  const conv = await chat("sandbox"),
    a = await enqueue(conv);
  await platform.gateway.tick();
  const run = (await repo.get<Run>("agent_runs", a.runId))!;
  human = true;
  await signedEvent(run, { sequence: 3, state: "human_owned" }).expect(200);
  await signedEvent(run, { sequence: 4, state: "completed" }).expect(200);
  expect((await repo.get<Run>("agent_runs", run.id))?.status).toBe(
    "human_owned",
  );
  expect(
    (await repo.get<Conversation>("conversation_refs", conv.id))?.handoff,
  ).toBe(true);
});
it("validates confirmation IDs and preserves price/quote/revision error codes", async () => {
  const scope = {
    channel: "simulator" as const,
    propertyId: cfg.crmProperty,
    externalUserId: "virtual",
    conversationId: "crm-conversation",
  };
  expect(() =>
    platform.integrations.crmV2.book({
      ...scope,
      offerId: "offer",
      idempotencyKey: "key",
    } as never),
  ).toThrow();
  for (const code of [
    "PRICE_CHANGED",
    "QUOTE_EXPIRED",
    "REVISION_CONFLICT",
    "IDENTITY_CONFLICT",
  ]) {
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes("accommodations/book")
        ? json({ code, retryable: false }, 409)
        : fakeTransport(input, init),
    );
    await expect(
      platform.integrations.crmV2.book({
        ...scope,
        offerId: "offer",
        idempotencyKey: "key",
        proposalMessageId: "proposal",
        confirmationMessageId: "later-guest-message",
      }),
    ).rejects.toMatchObject({ code });
  }
  expect(inboundCount).toBe(0);
});
it("implements exact search, offers, services and guest request envelopes", async () => {
  const scope = {
    channel: "simulator" as const,
    propertyId: cfg.crmProperty,
    externalUserId: "virtual",
    conversationId: "crm-conversation",
  };
  expect(
    (
      await platform.integrations.crmV2.search({
        ...scope,
        checkIn: "2027-01-01",
        checkOut: "2027-01-03",
        adults: 1,
      })
    ).results,
  ).toEqual([]);
  expect(
    (
      await platform.integrations.crmV2.offer({
        ...scope,
        requestId: "request",
        roomTypeId: guestId,
        ratePlanId: reservationId,
        idempotencyKey: "offer-key",
      })
    ).offer.id,
  ).toBe("offer-test");
  expect((await platform.integrations.crmV2.services(scope)).services).toEqual(
    [],
  );
  expect(
    (
      await platform.integrations.crmV2.availability({
        ...scope,
        serviceId: guestId,
        startAt: "2027-01-01T09:00:00Z",
        endAt: "2027-01-01T10:00:00Z",
      })
    ).available,
  ).toBe(false);
  expect(
    (
      await platform.integrations.crmV2.guestRequest({
        ...scope,
        sourceMessageId: "actual-guest-message",
        title: "Need towels",
        idempotencyKey: "request-key",
      })
    ).status,
  ).toBe("pending");
});
it("maps every legacy scenario vocabulary without inferring business identity", () => {
  expect(stageMapping.known_customer).toBe("returning_customer");
  expect(stageMapping.returning_guest).toBe("returning_customer");
  expect(stageMapping.confirmed).toBe("confirmed_reservation");
  expect(stageMapping.commercial_request).toBe("enquire");
  expect(stageMapping.due_out).toBe("due_out");
});
it("fixture setup/replay/retire and simulated payment use authoritative distinct refs", async () => {
  const conv = await chat("sandbox");
  await repo.patch("conversation_refs", conv.id, {
    stage: "pending_payment",
    setupStatus: "SETUP_UNAVAILABLE",
  });
  const scenario = (await repo.list<{ id: string }>("test_scenarios"))[0],
    run = record({
      scenarioId: scenario.id,
      conversationId: conv.id,
      status: "SETUP_UNAVAILABLE" as const,
      reason: "",
      references: {},
      assertions: [],
    });
  await repo.put("scenario_runs", run);
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input)),
      body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.endsWith("/sandbox/fixtures"))
      return json({
        contractVersion: "guestra-fixtures-v1",
        propertyId: cfg.crmProperty,
        pmsPropertyId: cfg.pmsProperty,
        fixtureId: body.fixtureId,
        stage: body.stage,
        customerId: "crm-customer",
        conversationId: "crm-fixture-conversation",
        externalUserId: "fixture:" + body.fixtureId,
        requestId: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        refs: { guestId, reservationId },
        snapshots: [{ ...snapshot, status: "pending" }],
        simulatedPayment: {
          source: "simulated",
          status: "pending",
          ledgerEffect: false,
        },
      });
    if (url.pathname.endsWith("/simulate-payment"))
      return json({
        fixtureId: url.pathname.split("/").at(-2),
        simulatedPayment: {
          source: "simulated",
          status: "confirmed",
          ledgerEffect: false,
          providerVerified: false,
        },
      });
    if (url.pathname.endsWith("/retire"))
      return json({
        fixtureId: url.pathname.split("/").at(-2),
        retired: true,
        retainedForAudit: true,
      });
    return fakeTransport(input, init);
  });
  const prepared = await platform.fixtures.prepare(repo.workspaceId, run.id);
  expect(prepared.status).toBe("READY");
  expect(prepared.references.crmCustomerId).not.toBe(client.id);
  expect(prepared.references.pmsGuestId).toBe(guestId);
  const replay = await platform.fixtures.prepare(repo.workspaceId, run.id);
  expect(replay.references.fixtureId).toBe(prepared.references.fixtureId);
  const identity = (await repo.get<Identity>(
    "virtual_identities",
    (await repo.get<Conversation>("conversation_refs", conv.id))!.identityId,
  ))!;
  expect(identity.externalUserId).toBe(
    "fixture:" + prepared.references.fixtureId,
  );
  expect(
    (await platform.fixtures.simulatePayment(repo.workspaceId, run.id))
      .simulatedPayment.ledgerEffect,
  ).toBe(false);
  await platform.fixtures.retire(repo.workspaceId, run.id);
  expect(
    (await repo.get<ScenarioRun>("scenario_runs", run.id))?.references
      .retiredAt,
  ).toBeDefined();
  await expect(
    platform.fixtures.prepare(repo.workspaceId, run.id),
  ).rejects.toThrow("Retired fixture");
});
it("production sandbox flag cannot create fixture or business writes", async () => {
  const other = createApp(db, {
    ...cfg,
    environment: "production",
    sandbox: true,
  });
  await expect(
    other.integrations.crmV2.fixture({
      propertyId: cfg.crmProperty,
      fixtureId: "never",
      stage: "in_house",
    }),
  ).rejects.toThrow("sandbox");
  const conv = await chat("sandbox");
  await expect(
    other.gateway.enqueue(repo.workspaceId, conv.id, {
      text: "No production write",
      externalMessageId: randomUUID(),
      attachmentIds: [],
    }),
  ).rejects.toMatchObject({ code: "SANDBOX_REQUIRED" });
  expect(fetch).not.toHaveBeenCalled();
});
it("Studio local publish is separate from unavailable and verified n8n deployments", async () => {
  const prompt = (await repo.list<Prompt>("prompt_versions"))[0];
  await browser.post("/api/prompts/" + prompt.id + "/publish").expect(200);
  const pending = await browser
    .post("/api/prompts/" + prompt.id + "/deploy")
    .expect(200);
  expect(pending.body.reason).toBe("WORKFLOW_NOT_DEPLOYED");
  expect(
    (await repo.get<Prompt>("prompt_versions", prompt.id))?.deploymentState,
  ).toBe("N8N_DEPLOYMENT_PENDING");
  const hash = createHash("sha256").update(prompt.body).digest("hex");
  const publisher = {
    metadata: async () => ({ workflowId: "w" }),
    publish: async () => ({ deploymentId: "test-deploy", readBackHash: hash }),
    active: async () => ({
      deploymentId: "test-deploy",
      versionId: prompt.id,
      readBackHash: hash,
    }),
    rollback: async () => ({ deploymentId: "test-deploy", readBackHash: hash }),
  };
  const injected = createApp(db, cfg, { publisher });
  expect(
    (await injected.promptDeployments.deploy(repo.workspaceId, prompt.id))
      .state,
  ).toBe("N8N_DEPLOYED");
  expect(
    (await injected.promptDeployments.rollback(repo.workspaceId, prompt.id))
      .state,
  ).toBe("ROLLED_BACK");
});
it("rejects prompt read-back mismatch without changing the Studio active version", async () => {
  const p = (await repo.list<Prompt>("prompt_versions"))[0];
  const injected = createApp(db, cfg, {
    publisher: {
      metadata: async () => ({ workflowId: "w" }),
      publish: async () => ({ deploymentId: "bad", readBackHash: "bad" }),
      active: async () => ({
        deploymentId: "bad",
        versionId: p.id,
        readBackHash: "bad",
      }),
      rollback: async () => ({ deploymentId: "bad", readBackHash: "bad" }),
    },
  });
  await expect(
    injected.promptDeployments.deploy(repo.workspaceId, p.id),
  ).rejects.toThrow("hash");
  expect(
    (await repo.get<Prompt>("prompt_versions", p.id))?.deploymentState,
  ).toBe("DEPLOYMENT_FAILED");
});
it("refuses foreign database ownership and requires separate deployment marker", async () => {
  expect(
    (
      await databaseReadiness(db, {
        ...cfg,
        local: false,
        databaseOwner: "guestra_ai_studio",
        databaseDeployment: "unattested",
      })
    ).ready,
  ).toBe(false);
  await expect(assertDatabaseOwnership(db, "guestra_crm")).rejects.toThrow(
    "OWNER",
  );
  await db.query("CREATE TABLE guests(id text)");
  try {
    await expect(
      assertDatabaseOwnership(db, "guestra_ai_studio"),
    ).rejects.toThrow("foreign business tables");
  } finally {
    await db.query("DROP TABLE guests");
  }
});
it("migration is additive and preserves existing prompt/client/history rows", async () => {
  const before = await repo.get<Client>("virtual_clients", client.id);
  await migrate(db);
  expect(await repo.get<Client>("virtual_clients", client.id)).toEqual(before);
  expect(
    await db.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    ),
  ).toHaveLength(3);
});
it("paginates long guest history without deleting authoritative references", async () => {
  const conv = await chat();
  for (let i = 0; i < 106; i++)
    await repo.put(
      "preview_messages",
      record({
        conversationId: conv.id,
        direction: "inbound" as const,
        senderType: "guest" as const,
        text: String(i),
        deliveryStatus: "delivered",
        attachments: [],
        source: "preview" as const,
      }),
    );
  const recent = (
    await browser.get("/api/conversations/" + conv.id + "/timeline").expect(200)
  ).body;
  expect(recent.messages).toHaveLength(100);
  expect(recent.hasOlder).toBe(true);
  const older = (
    await browser
      .get(
        "/api/conversations/" +
          conv.id +
          "/timeline?before=" +
          recent.olderCursor,
      )
      .expect(200)
  ).body;
  expect(older.messages).toHaveLength(6);
  expect(older.hasOlder).toBe(false);
  expect(
    (await repo.list<Message>("preview_messages")).filter(
      (m) => m.conversationId === conv.id,
    ),
  ).toHaveLength(106);
});
