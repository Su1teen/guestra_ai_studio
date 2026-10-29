import { testDatabase } from "./test-database";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import request from "supertest";
import { randomUUID, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { database, migrate, type Database } from "../server/db";
import { seed } from "../server/seed";
import { createApp } from "../server/app";
import { Repository, record } from "../server/repository";
import type { Config } from "../server/config";
import type {
  Conversation,
  Identity,
  Message,
  Attempt,
  Run,
  Client,
} from "../shared/domain";
import { detectMedia } from "../server/media";
const cfg: Config = {
  port: 4310,
  host: "127.0.0.1",
  publicUrl: "http://127.0.0.1:5173",
  local: true,
  dataDir: "memory://",
  mediaDir: resolve(".local/test-media"),
  signingSecret: "test-signing-secret-only-32-characters",
  sandbox: true,
  environment: "test",
  crmVersion: "v1",
  crmTenant: "crm-tenant",
  pmsTenant: "pms-tenant",
  orchestratorWorkspaces: ["les-sandbox"],
  allowedHosts: ["sandbox.invalid"],
  crmUrl: "https://sandbox.invalid/crm",
  crmKey: "test-key",
  pmsUrl: "https://sandbox.invalid/pms",
  pmsKey: "test-key",
  n8nUrl: "https://sandbox.invalid/n8n",
  n8nCapabilitiesUrl: "https://sandbox.invalid/capabilities",
  n8nToken: "test-orchestrator-token-32-characters",
  callbackSecret: "test-callback-secret-only-32-characters",
  crmProperty: "test-property",
  pmsProperty: "00000000-0000-4000-a000-000000000001",
  scannerUrl: "",
  scannerToken: "",
};
let db: Database,
  platform: ReturnType<typeof createApp>,
  agent: ReturnType<typeof request.agent>,
  clientId: string,
  repo: Repository;
async function newChat(stage = "new_contact", channel = "whatsapp") {
  return (
    await agent
      .post("/api/conversations")
      .send({ clientId, title: "Тест " + randomUUID(), channel, stage })
      .expect(201)
  ).body as Conversation;
}
function send(
  conv: Conversation,
  text = "Здравствуйте",
  externalMessageId = randomUUID(),
) {
  return agent
    .post("/api/conversations/" + conv.id + "/messages")
    .send({ text, externalMessageId, attachmentIds: [] });
}
function callback(run: Run, conv: Conversation, state: string) {
  const body = JSON.stringify({
    eventId: randomUUID(),
    workspaceId: repo.workspaceId,
    runId: run.id,
    correlationId: run.correlationId,
    crmConversationId: "crm-" + conv.id,
    state,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", cfg.callbackSecret)
    .update(timestamp + "." + body)
    .digest("hex");
  return request(platform.app)
    .post("/api/integrations/n8n/events")
    .set("Content-Type", "application/json")
    .set("x-studio-timestamp", timestamp)
    .set("x-studio-signature", signature)
    .send(body);
}
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  await seed(db, true);
  platform = createApp(db, cfg);
  repo = new Repository(db, "les-sandbox");
  agent = request.agent(platform.app);
  await agent.post("/api/auth/local").expect(200);
  clientId = (await repo.list<Client>("virtual_clients"))[0].id;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.query(
    "UPDATE message_attempts SET status='failed',data=data || '{\"status\":\"failed\"}'::jsonb WHERE status IN ('queued','processing','awaiting_crm')",
  );
  await db.query(
    "UPDATE agent_runs SET data=data || '{\"status\":\"failed\"}'::jsonb WHERE data->>'status' NOT IN ('completed','preview_completed','human_owned','failed','inbound_saved_no_orchestrator')",
  );
  await db.query(
    "UPDATE memberships SET role='admin' WHERE user_id='local-tester'",
  );
  await db.query("UPDATE workspaces SET mode='preview' WHERE id='les-sandbox'");
});
afterAll(async () => {
  await db.close();
});
describe("authentication and isolation", () => {
  it("creates a scoped user with real login and role enforcement", async () => {
    const email = "viewer-" + randomUUID() + "@studio.invalid";
    await agent
      .post("/api/users")
      .send({
        email,
        name: "Viewer fixture",
        password: "test-only-password-123",
        role: "viewer",
      })
      .expect(201);
    const viewer = request.agent(platform.app);
    await viewer
      .post("/api/auth/login")
      .send({ email, password: "incorrect" })
      .expect(401);
    await viewer
      .post("/api/auth/login")
      .send({ email, password: "test-only-password-123" })
      .expect(200);
    expect(
      (await viewer.get("/api/bootstrap").expect(200)).body.user.role,
    ).toBe("viewer");
    await viewer.post("/api/clients").send({}).expect(403);
  });
  it("requires authentication and refuses cross-origin mutation", async () => {
    await request(platform.app).get("/api/bootstrap").expect(401);
    await agent
      .post("/api/clients")
      .set("Origin", "https://other.invalid")
      .send({})
      .expect(403);
  });
  it("viewer cannot send, upload, annotate or change prompts", async () => {
    const c = await newChat();
    await db.query(
      "UPDATE memberships SET role='viewer' WHERE user_id='local-tester'",
    );
    await send(c).expect(403);
    await agent
      .post("/api/media")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("text"))
      .expect(403);
    await agent.post("/api/annotations").send({}).expect(403);
    await agent
      .post("/api/agents/test/prompts")
      .send({ body: "x" })
      .expect(403);
  });
  it("does not expose resources across workspaces", async () => {
    const c = await newChat();
    await db.query(
      "INSERT INTO workspaces(id,name,environment) VALUES('other','Other','local') ON CONFLICT DO NOTHING",
    );
    const other = new Repository(db, "other");
    expect(await other.get("conversation_refs", c.id)).toBeUndefined();
    await db.query(
      "INSERT INTO memberships VALUES('other','local-tester','admin') ON CONFLICT DO NOTHING",
    );
    await db.query(
      "UPDATE auth_sessions SET workspace_id='other' WHERE user_id='local-tester'",
    );
    await agent.get("/api/conversations/" + c.id + "/timeline").expect(404);
    await db.query(
      "UPDATE auth_sessions SET workspace_id='les-sandbox' WHERE user_id='local-tester'",
    );
  });
  it("rejects connected modes until capabilities are verified", async () => {
    vi.spyOn(platform.integrations, "capabilities").mockResolvedValue({
      connections: [],
      crmReady: false,
      sandboxReady: false,
      sandboxAttested: false,
      mappingReady: false,
      mediaScanner: "MEDIA_SCANNER_NOT_CONFIGURED",
    });
    await agent
      .put("/api/integrations/mode")
      .send({ mode: "sandbox" })
      .expect(409);
  });
});
describe("virtual identity and durable messaging", () => {
  it("separates clients with identical phones and separates visual channels", async () => {
    const base = {
      firstName: "Тест",
      lastName: "Гость",
      displayName: "Тестовый гость",
      phone: "+70000000000",
      telegram: "",
      channel: "whatsapp",
      language: "ru",
      property: "LES Боровое",
      parameters: {},
    };
    const a = (await agent.post("/api/clients").send(base).expect(201)).body;
    const b = (await agent.post("/api/clients").send(base).expect(201)).body;
    const c1 = (
      await agent
        .post("/api/conversations")
        .send({ clientId: a.id, title: "A", channel: "whatsapp" })
        .expect(201)
    ).body;
    const c2 = (
      await agent
        .post("/api/conversations")
        .send({ clientId: b.id, title: "B", channel: "whatsapp" })
        .expect(201)
    ).body;
    const c3 = (
      await agent
        .post("/api/conversations")
        .send({ clientId: a.id, title: "T", channel: "telegram" })
        .expect(201)
    ).body;
    expect(new Set([c1.identityId, c2.identityId, c3.identityId]).size).toBe(3);
  });
  it("creates concurrent independent chats with one stable channel identity", async () => {
    const [a, b] = await Promise.all([newChat(), newChat()]);
    expect(a.identityId).toBe(b.identityId);
    expect(a.externalChatId).not.toBe(b.externalChatId);
  });
  it("deduplicates retries and rejects changed payload under same key", async () => {
    const c = await newChat(),
      key = randomUUID();
    const a = (await send(c, "Привет", key).expect(202)).body;
    const b = (await send(c, "Привет", key).expect(202)).body;
    expect(a.id).toBe(b.id);
    await send(c, "Другой текст", key).expect(409);
    await platform.gateway.tick();
    const timeline = (
      await agent.get("/api/conversations/" + c.id + "/timeline").expect(200)
    ).body;
    expect(
      timeline.messages.filter((m: Message) => m.direction === "inbound"),
    ).toHaveLength(1);
    expect(timeline.attempts[0].status).toBe("delivered");
  });
  it("same external UUID across two chats does not overwrite messages", async () => {
    const [a, b] = await Promise.all([newChat(), newChat()]);
    const key = randomUUID();
    await send(a, "Первый", key).expect(202);
    await send(b, "Второй", key).expect(202);
    await platform.gateway.tick();
    await platform.gateway.tick();
    const ma = (await repo.list<Message>("preview_messages")).find(
      (m) => m.conversationId === a.id && m.direction === "inbound",
    );
    const mb = (await repo.list<Message>("preview_messages")).find(
      (m) => m.conversationId === b.id && m.direction === "inbound",
    );
    expect(ma?.text).toBe("Первый");
    expect(mb?.text).toBe("Второй");
    expect(ma?.id).not.toBe(mb?.id);
  });
  it("persists drafts and stops preview agent after human takeover", async () => {
    const c = await newChat();
    await agent
      .patch("/api/conversations/" + c.id)
      .send({ draft: "Черновик", handoff: true })
      .expect(200);
    expect(
      (await repo.get<Conversation>("conversation_refs", c.id))?.draft,
    ).toBe("Черновик");
    await send(c).expect(202);
    await platform.gateway.tick();
    const m = (await repo.list<Message>("preview_messages")).filter(
      (m) => m.conversationId === c.id,
    );
    expect(m).toHaveLength(1);
    expect(m[0].direction).toBe("inbound");
  });
  it("preserves per-conversation message order", async () => {
    const c = await newChat();
    await send(c, "Первый");
    await send(c, "Второй");
    await platform.gateway.tick();
    await platform.gateway.tick();
    const a = (await repo.list<Attempt>("message_attempts")).filter(
      (a) => a.conversationId === c.id,
    );
    expect(a[0].sequence).toBeLessThan(a[1].sequence);
    expect(a.every((a) => a.status === "delivered")).toBe(true);
  });
});
describe("review, prompts, scenarios and calls", () => {
  it("runs the explicitly selected agent with its own prompt snapshot", async () => {
    const a = (
      await agent
        .post("/api/agents")
        .send({ name: "Second agent", body: "Отдельный промпт второго агента" })
        .expect(201)
    ).body;
    const c = (
      await agent
        .post("/api/conversations")
        .send({
          clientId,
          title: "Second agent chat",
          channel: "telegram",
          agentId: a.id,
        })
        .expect(201)
    ).body;
    await send(c).expect(202);
    const run = (await repo.list<Run>("agent_runs")).find(
      (r) => r.conversationId === c.id,
    );
    expect(run?.promptSnapshot).toBe("Отдельный промпт второго агента");
  });
  it("annotations persist revision history and never enter guest transcript", async () => {
    const c = await newChat();
    const a = (
      await agent
        .post("/api/annotations")
        .send({
          conversationId: c.id,
          targetType: "conversation",
          targetId: c.id,
          body: "Не понял дату",
          severity: "warning",
          type: "quality",
          flags: ["date"],
        })
        .expect(201)
    ).body;
    await agent
      .patch("/api/annotations/" + a.id)
      .send({ body: "Исправлено", status: "resolved" })
      .expect(200);
    const note = await repo.get<{ history: unknown[]; status: string }>(
      "tester_annotations",
      a.id,
    );
    expect(note?.history).toHaveLength(1);
    expect(note?.status).toBe("resolved");
    expect(
      (await agent.get("/api/conversations/" + c.id + "/timeline")).body
        .messages,
    ).toHaveLength(0);
  });
  it("published prompts are immutable and run snapshots survive rollback", async () => {
    const a = (
      await repo.list<{ id: string; activeVersionId: string }>(
        "agent_configurations",
      )
    )[0];
    await agent
      .patch("/api/prompts/" + a.activeVersionId)
      .send({ body: "changed" })
      .expect(409);
    const p = (
      await agent
        .post("/api/agents/" + a.id + "/prompts")
        .send({ body: "Тестовый промпт" })
        .expect(201)
    ).body;
    await agent.post("/api/prompts/" + p.id + "/publish").expect(200);
    const c = await newChat();
    await send(c);
    const run = (await repo.list<Run>("agent_runs")).find(
      (r) => r.conversationId === c.id,
    );
    await agent
      .post("/api/prompts/" + a.activeVersionId + "/publish")
      .expect(200);
    expect(run?.promptSnapshot).toBe("Тестовый промпт");
    expect(run?.configuration.timeoutMs).toBe(15000);
  });
  it("advanced connected scenarios are SETUP_UNAVAILABLE and cannot send", async () => {
    await db.query("UPDATE workspaces SET mode='crm' WHERE id='les-sandbox'");
    const c = await newChat("in_house");
    expect(c.setupStatus).toBe("SETUP_UNAVAILABLE");
    await send(c).expect(409);
  });
  it("call state transitions, durations and speaker turns are durable", async () => {
    const c = await newChat();
    const call = (
      await agent
        .post("/api/calls")
        .send({ conversationId: c.id, direction: "incoming" })
        .expect(201)
    ).body;
    await agent
      .post("/api/calls/" + call.id + "/turns")
      .send({ speaker: "guest", text: "hello" })
      .expect(409);
    await agent
      .post("/api/calls/" + call.id + "/action")
      .send({ action: "accept" })
      .expect(200);
    await agent
      .post("/api/calls/" + call.id + "/turns")
      .send({ speaker: "guest", text: "Алло" })
      .expect(200);
    await agent
      .post("/api/calls/" + call.id + "/action")
      .send({ action: "end" })
      .expect(200);
    const stored = (await agent.get("/api/conversations/" + c.id + "/timeline"))
      .body.calls[0];
    expect(stored.status).toBe("ended");
    expect(stored.turns).toHaveLength(1);
    await agent
      .post("/api/calls/" + call.id + "/action")
      .send({ action: "accept" })
      .expect(409);
  });
});
describe("media security", () => {
  it("uploads and downloads valid media with a signed URL", async () => {
    const bytes = Buffer.from("%PDF-1.4\ntest fixture");
    const asset = (
      await agent
        .post("/api/media")
        .set("Content-Type", "application/octet-stream")
        .set("x-file-name", "fixture.pdf")
        .set("x-file-type", "application/pdf")
        .send(bytes)
        .expect(201)
    ).body;
    const response = await request(platform.app).get(asset.url).expect(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toContain("attachment");
    await request(platform.app)
      .get(asset.url.replace("sig=", "sig=00"))
      .expect(403);
  });
  it("rejects active formats and MIME spoofing", () => {
    expect(() => detectMedia(Buffer.from("<svg/>"), "image/svg+xml")).toThrow();
    expect(() => detectMedia(Buffer.from("MZexe"), "image/png")).toThrow();
  });
});
describe("connected adapter and async completion", () => {
  it("maps contact inbound to guest and filters staff notes across full pages", async () => {
    const c = await newChat();
    const i = (await repo.get<Identity>("virtual_identities", c.identityId))!;
    await repo.patch("conversation_refs", c.id, {
      mode: "crm",
      crmConversationId: "crm-id",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "note",
                direction: "note",
                senderType: "staff",
                text: "private",
                at: new Date().toISOString(),
              },
            ],
            nextCursor: "note",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "contact",
                direction: "in",
                senderType: "contact",
                text: "guest",
                at: new Date().toISOString(),
                deliveryStatus: "received",
              },
            ],
            nextCursor: null,
          }),
        ),
      );
    const mapped = await repo.get<Conversation>("conversation_refs", c.id);
    await platform.gateway.reconcile(repo, mapped!);
    const messages = (await repo.list<Message>("transcript_snapshots")).filter(
      (m) => m.conversationId === c.id,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].senderType).toBe("guest");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("CRM mode has one inbound owner and no fake AI response", async () => {
    await db.query("UPDATE workspaces SET mode='crm' WHERE id='les-sandbox'");
    const c = await newChat();
    const inbound = vi
      .spyOn(platform.integrations, "inbound")
      .mockResolvedValue({
        messageId: "crm-msg",
        duplicate: false,
        context: { conversation: { id: "crm-conv" } },
        aiReplyAllowed: true,
        allowedActions: [],
      });
    vi.spyOn(platform.integrations, "transcript").mockResolvedValue({
      messages: [
        {
          ...record({}),
          id: "crm-msg",
          conversationId: c.id,
          direction: "inbound",
          senderType: "guest",
          text: "Здравствуйте",
          externalMessageId: "external",
          deliveryStatus: "received",
          attachments: [],
          source: "crm",
        },
      ],
      nextCursor: undefined,
      hasMore: false,
    });
    await send(c, "Здравствуйте", "00000000-0000-4000-a000-000000000001");
    await platform.gateway.tick();
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(
      (await repo.list<Message>("preview_messages")).filter(
        (m) => m.conversationId === c.id,
      ),
    ).toHaveLength(0);
    expect(
      (await repo.list<Run>("agent_runs")).find(
        (r) => r.conversationId === c.id,
      )?.status,
    ).toBe("inbound_saved_no_orchestrator");
  });
  it("signed out-of-order callbacks preserve completed and handoff state", async () => {
    const c = await newChat();
    await repo.patch("conversation_refs", c.id, {
      mode: "sandbox",
      draft: "keep",
      verdict: "pass",
    });
    await send(c);
    const run = (await repo.list<Run>("agent_runs")).find(
      (r) => r.conversationId === c.id,
    )!;
    vi.spyOn(platform.integrations, "transcript").mockResolvedValue({
      messages: [],
      nextCursor: undefined,
      hasMore: false,
    });
    await callback(run, c, "human_owned").expect(200);
    await callback(run, c, "inbound_saved").expect(200);
    expect((await repo.get<Run>("agent_runs", run.id))?.status).toBe(
      "human_owned",
    );
    const value = await repo.get<Conversation>("conversation_refs", c.id);
    expect(value?.handoff).toBe(true);
    expect(value?.verdict).toBe("pass");
  });
  it("rejects unsigned callbacks", async () => {
    await request(platform.app)
      .post("/api/integrations/n8n/events")
      .send({})
      .expect(401);
  });
  it("serializes n8n executions and preserves a fast completion callback", async () => {
    const c = await newChat();
    await repo.patch("conversation_refs", c.id, { mode: "sandbox" });
    // Studio records each guest message in the CRM Inbox before handing the run to n8n.
    vi.spyOn(platform.integrations, "inbound").mockImplementation(async (conv, _i, attempt) => ({
      messageId: "crm-in-" + attempt.externalMessageId, duplicate: false, aiReplyAllowed: true, allowedActions: [],
      context: { conversation: { id: "crm-" + conv.id }, customer: { id: "crm-customer" } },
    }) as never);
    const a = (await send(c, "Первый").expect(202)).body as Attempt;
    await send(c, "Второй").expect(202);
    const dispatch = vi
      .spyOn(platform.integrations, "dispatch")
      .mockImplementation(async (_w, _c, _i, a) => {
        const run = (await repo.get<Run>("agent_runs", a.runId))!;
        return platform.claims.claim(
          run.dispatchEnvelope!,
          "test-execution-" + run.id,
        );
      });
    await platform.gateway.tick();
    await platform.gateway.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const run = requireValueTest(await repo.get<Run>("agent_runs", a.runId));
    vi.spyOn(platform.integrations, "transcript").mockResolvedValue({
      messages: [
        {
          ...record({}),
          id: "crm-ack",
          conversationId: c.id,
          direction: "inbound",
          senderType: "guest",
          text: a.text,
          externalMessageId: a.externalMessageId,
          deliveryStatus: "received",
          attachments: [],
          source: "crm",
        },
      ],
      nextCursor: undefined,
      hasMore: false,
    });
    await callback(run, c, "completed").expect(200);
    dispatch.mockImplementationOnce(async () => {
      const next = (await repo.list<Run>("agent_runs")).find(
        (r) => r.conversationId === c.id && r.id !== run.id,
      )!;
      await callback(next, c, "completed").expect(200);
      return platform.claims.claim(
        next.dispatchEnvelope!,
        "test-execution-" + next.id,
      );
    });
    await platform.gateway.tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    const runs = (await repo.list<Run>("agent_runs")).filter(
      (r) => r.conversationId === c.id,
    );
    expect(runs.every((r) => r.status === "completed")).toBe(true);
  });
  it("stops unresolved execution and safely replays original keys on recovery", async () => {
    // Studio records each guest message in the CRM Inbox before handing the run to n8n.
    vi.spyOn(platform.integrations, "inbound").mockImplementation(async (conv, _i, attempt) => ({
      messageId: "crm-in-" + attempt.externalMessageId, duplicate: false, aiReplyAllowed: true, allowedActions: [],
      context: { conversation: { id: "crm-" + conv.id }, customer: { id: "crm-customer" } },
    }) as never);
    const c = await newChat();
    await repo.patch("conversation_refs", c.id, { mode: "sandbox" });
    const a = (await send(c).expect(202)).body as Attempt;
    const run = (await repo.get<Run>("agent_runs", a.runId))!;
    await repo.patch("message_attempts", a.id, {
      status: "awaiting_crm",
      tries: 4,
      nextAt: new Date(0).toISOString(),
    });
    await repo.patch("agent_runs", run.id, { status: "awaiting_crm" });
    await platform.gateway.tick();
    expect((await repo.get<Run>("agent_runs", run.id))?.status).toBe(
      "completion_unknown",
    );
    await agent.post("/api/runs/" + run.id + "/retry").expect(200);
    const dispatch = vi
      .spyOn(platform.integrations, "dispatch")
      .mockImplementation(async (_w, _c, _i, a) => {
        const run = (await repo.get<Run>("agent_runs", a.runId))!;
        return platform.claims.claim(
          run.dispatchEnvelope!,
          "test-execution-" + run.id,
        );
      });
    await platform.gateway.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][3].externalMessageId).toBe(
      a.externalMessageId,
    );
    expect(dispatch.mock.calls[0][3].correlationId).toBe(a.correlationId);
  });
});
function requireValueTest<T>(v: T | undefined): T {
  expect(v).toBeDefined();
  return v!;
}
describe("every Studio dialogue reaches the CRM Inbox", () => {
  it("replays guest messages of local-preview and failed chats into CRM once", async () => {
    await db.query("UPDATE workspaces SET mode='preview' WHERE id='les-sandbox'");
    const local = await newChat();
    await send(local, "Хотела забронировать").expect(202);
    await platform.gateway.tick();
    await db.query("UPDATE workspaces SET mode='sandbox' WHERE id='les-sandbox'");
    vi.spyOn(platform.integrations, "capabilities").mockResolvedValue({ crmReady: true, sandboxReady: true } as never);
    const sent: { conversation: string; text: string }[] = [];
    vi.spyOn(platform.integrations, "inbound").mockImplementation(async (conv, _i, attempt) => {
      sent.push({ conversation: conv.id, text: attempt.text });
      return { messageId: "crm-in-" + attempt.externalMessageId, duplicate: false, aiReplyAllowed: true, allowedActions: [],
        context: { conversation: { id: "crm-" + conv.id }, customer: { id: "crm-customer" } } } as never;
    });
    const result = await platform.gateway.backfillCrm();
    expect(sent.filter((m) => m.conversation === local.id)).toEqual([{ conversation: local.id, text: "Хотела забронировать" }]);
    expect(result.messages).toBeGreaterThanOrEqual(1);
    const moved = await repo.get<Conversation>("conversation_refs", local.id);
    expect(moved).toMatchObject({ mode: "sandbox", crmConversationId: "crm-" + local.id });
    sent.length = 0;
    await platform.gateway.backfillCrm();
    expect(sent.filter((m) => m.conversation === local.id)).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
