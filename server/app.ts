import express from "express";
import { resolve } from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import {
  authenticate,
  roles,
  session,
  passwordMatches,
  passwordHash,
} from "./auth.js";
import { ApiError, requireValue } from "./errors.js";
import { Repository, record, now } from "./repository.js";
import { Integrations, UnavailableScenarioSetup } from "./integrations.js";
import { MediaService } from "./media.js";
import { Gateway } from "./gateway.js";
import {
  clientSchema,
  conversationSchema,
  messageSchema,
  annotationSchema,
  scenarioSchema,
} from "../shared/domain.js";
import type {
  Client,
  Identity,
  Conversation,
  Attempt,
  Message,
  Annotation,
  Run,
  Agent,
  Prompt,
  Scenario,
  ScenarioRun,
  Call,
  Mode,
} from "../shared/domain.js";
export function createApp(db: Database, cfg: Config) {
  const app = express();
  app.disable("x-powered-by");
  const integrations = new Integrations(cfg);
  const media = new MediaService(cfg);
  const gateway = new Gateway(db, integrations, media);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=()");
    if (process.env.NODE_ENV === "production")
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      );
    req.headers["x-correlation-id"] = crypto.randomUUID();
    next();
  });
  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", service: "guestra-ai-studio" }),
  );
  app.get("/api/ready", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ready", database: db.kind });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.get("/api/auth/options", (_req, res) =>
    res.json({ localPreview: cfg.local }),
  );
  // Signed, short-lived callback. Store a unique event receipt to handle replay safely.
  app.post(
    "/api/integrations/n8n/events",
    express.raw({ type: "application/json", limit: "128kb" }),
    async (req, res) => {
      if (!cfg.sandbox || cfg.callbackSecret.length < 32)
        throw new ApiError(503, "NOT_CONFIGURED", "Callback не настроен");
      const timestamp = String(req.headers["x-studio-timestamp"] ?? "");
      const expected = createHmac("sha256", cfg.callbackSecret)
        .update(timestamp + ".")
        .update(req.body)
        .digest();
      const supplied = Buffer.from(
        String(req.headers["x-studio-signature"] ?? ""),
        "hex",
      );
      if (
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
        !Number.isFinite(Number(timestamp)) ||
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        throw new ApiError(
          401,
          "INVALID_SIGNATURE",
          "Неверная подпись callback",
        );
      let raw: unknown;
      try {
        raw = JSON.parse(req.body.toString());
      } catch {
        throw new ApiError(400, "INVALID_JSON", "Неверный JSON");
      }
      const event = z
        .object({
          eventId: z.string().uuid(),
          workspaceId: z.string(),
          runId: z.string(),
          correlationId: z.string().uuid(),
          crmConversationId: z.string().min(1).optional(),
          state: z.enum([
            "inbound_saved",
            "completed",
            "human_owned",
            "failed",
          ]),
          errorCode: z.string().max(80).optional(),
        })
        .strict()
        .refine(
          (e) => e.state === "failed" || Boolean(e.crmConversationId),
          "CRM conversation required",
        )
        .parse(raw);
      const repo = new Repository(db, event.workspaceId);
      const run = requireValue(await repo.get<Run>("agent_runs", event.runId));
      if (run.correlationId !== event.correlationId)
        throw new ApiError(409, "CORRELATION_CONFLICT", "Correlation mismatch");
      const conv = requireValue(
        await repo.get<Conversation>("conversation_refs", run.conversationId),
      );
      if (conv.mode !== "sandbox")
        throw new ApiError(
          409,
          "MODE_CONFLICT",
          "Callback относится к другой среде",
        );
      await db.transaction(async (tx) => {
        const r = new Repository(tx, event.workspaceId);
        await tx.query(
          "SELECT id FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [event.workspaceId, run.id],
        );
        if (await r.get("integration_configuration", "event:" + event.eventId))
          return;
        const fresh = requireValue(await r.get<Run>("agent_runs", run.id));
        const ranks: Record<string, number> = {
          inbound_saved: 1,
          failed: 2,
          completed: 3,
          human_owned: 3,
        };
        await r.put("integration_configuration", {
          ...record({ state: event.state, runId: run.id }),
          id: "event:" + event.eventId,
        });
        if ((ranks[fresh.status] ?? 0) >= (ranks[event.state] ?? 0)) return;
        await r.patch("conversation_refs", conv.id, {
          ...(event.crmConversationId
            ? { crmConversationId: event.crmConversationId }
            : {}),
          ...(event.state === "human_owned" ? { handoff: true } : {}),
        });
        await r.patch("agent_runs", run.id, {
          status: event.state,
          ...(event.errorCode ? { error: event.errorCode } : {}),
        });
        if (event.state === "failed") {
          for (const a of (await r.list<Attempt>("message_attempts")).filter(
            (a) => a.runId === run.id,
          ))
            await r.patch("message_attempts", a.id, {
              status: "failed",
              error: event.errorCode ?? "Workflow failed",
            });
        }
      });
      // A callback cannot itself mark a guest message delivered. Read authoritative transcript.
      const freshConv = requireValue(
        await repo.get<Conversation>("conversation_refs", conv.id),
      );
      await gateway.reconcile(repo, freshConv);
      res.json({ accepted: true });
    },
  );
  app.use(express.json({ limit: "128kb" }));
  app.use("/api", (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== new URL(cfg.publicUrl).origin)
      return next(
        new ApiError(403, "ORIGIN_REJECTED", "Запрос из другой среды"),
      );
    if (req.headers["sec-fetch-site"] === "cross-site")
      return next(
        new ApiError(403, "ORIGIN_REJECTED", "Cross-site request rejected"),
      );
    next();
  });
  const attempts = new Map<string, { count: number; reset: number }>();
  app.post("/api/auth/login", async (req, res) => {
    const key = req.ip ?? "unknown";
    const existing = attempts.get(key);
    const limit =
      existing && existing.reset > Date.now()
        ? existing
        : { count: 0, reset: Date.now() + 60000 };
    attempts.set(key, limit);
    if (++limit.count > 10)
      throw new ApiError(429, "RATE_LIMITED", "Повторите вход через минуту");
    const input = z
      .object({ email: z.string().email(), password: z.string().max(200) })
      .parse(req.body);
    const user = (
      await db.query<{ id: string; password_hash: string }>(
        "SELECT id,password_hash FROM studio_users WHERE email=$1",
        [input.email.toLowerCase()],
      )
    )[0];
    if (
      !user?.password_hash ||
      !passwordMatches(input.password, user.password_hash)
    )
      throw new ApiError(401, "INVALID_LOGIN", "Неверный email или пароль");
    const membership = (
      await db.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM memberships WHERE user_id=$1 ORDER BY workspace_id LIMIT 1",
        [user.id],
      )
    )[0];
    if (!membership)
      throw new ApiError(403, "NO_WORKSPACE", "Нет доступа к workspace");
    await session(db, res, user.id, membership.workspace_id);
    res.json({ ok: true });
  });
  app.post("/api/auth/local", async (_req, res) => {
    if (!cfg.local)
      throw new ApiError(404, "NOT_FOUND", "Local Preview выключен");
    await session(db, res, "local-tester", "les-sandbox");
    res.json({ ok: true });
  });
  app.get("/api/media/:id/content", async (req, res) => {
    const workspace = String(req.query.w ?? "");
    const purpose = String(req.query.purpose ?? "");
    media.verify(
      workspace,
      String(req.params.id),
      Number(req.query.exp),
      purpose,
      String(req.query.sig ?? ""),
    );
    const asset = await media.authorized(
      new Repository(db, workspace),
      String(req.params.id),
    );
    if (purpose === "workflow" && asset.scanStatus !== "clean")
      throw new ApiError(
        403,
        "SCANNER_REQUIRED",
        "Unscanned media cannot leave preview",
      );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", asset.mimeType);
    res.setHeader(
      "Content-Disposition",
      `${asset.kind === "document" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
    );
    res.send(await media.storage.get(asset.storageKey));
  });
  app.use("/api", authenticate(db));
  app.post("/api/auth/logout", async (req, res) => {
    const token = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("studio_session="))
      ?.split("=")[1];
    if (token)
      await db.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
        createHash("sha256").update(token).digest("hex"),
      ]);
    res.clearCookie("studio_session");
    res.json({ ok: true });
  });
  const repo = (req: express.Request) =>
    new Repository(db, req.principal.workspaceId);
  app.get("/api/users", roles("admin"), async (req, res) =>
    res.json(
      await db.query(
        "SELECT u.id,u.email,u.name,m.role FROM memberships m JOIN studio_users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name",
        [req.principal.workspaceId],
      ),
    ),
  );
  app.post("/api/users", roles("admin"), async (req, res) => {
    const input = z
      .object({
        email: z.string().email(),
        name: z.string().trim().min(1).max(100),
        password: z.string().min(12).max(200),
        role: z.enum(["admin", "tester", "reviewer", "viewer"]),
      })
      .strict()
      .parse(req.body);
    const id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      if (
        (
          await tx.query("SELECT id FROM studio_users WHERE email=$1", [
            input.email.toLowerCase(),
          ])
        ).length
      )
        throw new ApiError(409, "USER_EXISTS", "Email уже зарегистрирован");
      await tx.query(
        "INSERT INTO studio_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
        [
          id,
          input.email.toLowerCase(),
          input.name,
          passwordHash(input.password),
        ],
      );
      await tx.query(
        "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
        [req.principal.workspaceId, id, input.role],
      );
      await new Repository(tx, req.principal.workspaceId).audit(
        req.principal.name,
        "studio_user_created",
        id,
        "Role: " + input.role,
      );
    });
    res
      .status(201)
      .json({ id, email: input.email, name: input.name, role: input.role });
  });
  app.get("/api/bootstrap", async (req, res) => {
    const r = repo(req);
    const workspace = (
      await db.query(
        "SELECT id,name,mode,environment FROM workspaces WHERE id=$1",
        [r.workspaceId],
      )
    )[0];
    const [
      clients,
      conversations,
      agents,
      prompts,
      scenarios,
      calls,
      annotations,
      scenarioRuns,
    ] = await Promise.all([
      r.list<Client>("virtual_clients"),
      r.list<Conversation>("conversation_refs"),
      r.list<Agent>("agent_configurations"),
      r.list<Prompt>("prompt_versions"),
      r.list<Scenario>("test_scenarios"),
      r.list<Call>("call_sessions"),
      r.list<Annotation>("tester_annotations"),
      r.list<ScenarioRun>("scenario_runs"),
    ]);
    res.json({
      user: req.principal,
      workspace,
      clients,
      conversations,
      agents,
      prompts,
      scenarios,
      calls,
      annotations,
      scenarioRuns,
      database: db.kind,
    });
  });
  app.get("/api/integrations", async (req, res) =>
    res.json({
      ...(await integrations.capabilities()),
      mappings: await repo(req).list("integration_mappings"),
      mode: (
        await db.query<{ mode: Mode }>(
          "SELECT mode FROM workspaces WHERE id=$1",
          [req.principal.workspaceId],
        )
      )[0].mode,
      promptSync: "NOT_CONNECTED",
      traceApi: "SETUP_UNAVAILABLE",
      telephony: "VIRTUAL_ONLY",
    }),
  );
  app.put("/api/integrations/mode", roles("admin"), async (req, res) => {
    const { mode } = z
      .object({ mode: z.enum(["preview", "crm", "sandbox"]) })
      .parse(req.body);
    const caps = await integrations.capabilities();
    if (
      (mode === "crm" && !caps.crmReady) ||
      (mode === "sandbox" && !caps.sandboxReady)
    )
      throw new ApiError(
        409,
        "CAPABILITIES_REQUIRED",
        "Соединения, sandbox attestation и property mappings должны быть настроены и проверены",
      );
    await db.query("UPDATE workspaces SET mode=$1 WHERE id=$2", [
      mode,
      req.principal.workspaceId,
    ]);
    await repo(req).audit(
      req.principal.name,
      "mode_changed",
      mode,
      "Режим новых разговоров",
    );
    res.json({ mode });
  });
  app.post("/api/clients", roles("admin", "tester"), async (req, res) => {
    const client = record(clientSchema.parse(req.body));
    await repo(req).put("virtual_clients", client);
    res.status(201).json(client);
  });
  app.patch("/api/clients/:id", roles("admin", "tester"), async (req, res) => {
    const input = clientSchema.partial().parse(req.body);
    res.json(
      await repo(req).update<Client>(
        "virtual_clients",
        String(req.params.id),
        (v) => ({ ...v, ...input }),
      ),
    );
  });
  async function newConversation(
    r: Repository,
    input: z.infer<typeof conversationSchema>,
  ) {
    return db.transaction(async (tx) => {
      r = new Repository(tx, r.workspaceId);
      await tx.query(
        "SELECT id FROM virtual_clients WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [r.workspaceId, input.clientId],
      );
      requireValue(await r.get<Client>("virtual_clients", input.clientId));
      if (input.agentId)
        requireValue(await r.get<Agent>("agent_configurations", input.agentId));
      const workspace = (
        await tx.query<{ mode: Mode }>(
          "SELECT mode FROM workspaces WHERE id=$1",
          [r.workspaceId],
        )
      )[0];
      const externalUserId = `studio:${r.workspaceId}:${workspace.mode}:${input.clientId}:${input.channel}`;
      let identity = (await r.list<Identity>("virtual_identities")).find(
        (i) => i.externalUserId === externalUserId,
      );
      if (!identity) {
        identity = record({
          clientId: input.clientId,
          displayChannel: input.channel,
          transportChannel: "simulator" as const,
          externalUserId: `studio:${r.workspaceId}:${workspace.mode}:${input.clientId}:${input.channel}`,
        });
        await r.put("virtual_identities", identity, {
          client_id: input.clientId,
          external_user_id: identity.externalUserId,
        });
      }
      const setup =
        input.stage === "new_contact"
          ? "READY"
          : workspace.mode === "preview"
            ? "PREVIEW_ONLY"
            : "SETUP_UNAVAILABLE";
      const conv: Conversation = record({
        agentId:
          input.agentId ?? (await r.list<Agent>("agent_configurations"))[0]?.id,
        clientId: input.clientId,
        identityId: identity.id,
        title: input.title,
        externalChatId: "studio:chat:" + crypto.randomUUID(),
        mode: workspace.mode,
        stage: input.stage,
        draft: "",
        verdict: "unreviewed",
        lastText: "Новый разговор",
        unread: 0,
        handoff: false,
        setupStatus: setup,
      });
      await r.put("conversation_refs", conv, {
        client_id: input.clientId,
        identity_id: identity.id,
        external_chat_id: conv.externalChatId,
      });
      await r.put(
        "simulation_sessions",
        record({ conversationId: conv.id, mode: conv.mode, status: setup }),
        { conversation_id: conv.id },
      );
      return conv;
    });
  }
  app.post("/api/conversations", roles("admin", "tester"), async (req, res) =>
    res
      .status(201)
      .json(
        await newConversation(repo(req), conversationSchema.parse(req.body)),
      ),
  );
  app.patch(
    "/api/conversations/:id",
    roles("admin", "tester", "reviewer"),
    async (req, res) => {
      const input = z
        .object({
          draft: z.string().max(8000).optional(),
          verdict: z.enum(["unreviewed", "pass", "fail"]).optional(),
          unread: z.literal(0).optional(),
          handoff: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      if (
        req.principal.role === "reviewer" &&
        (input.draft !== undefined || input.handoff !== undefined)
      )
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Reviewer может оценивать разговор",
        );
      const conv = requireValue(
        await repo(req).get<Conversation>(
          "conversation_refs",
          String(req.params.id),
        ),
      );
      if (input.handoff !== undefined && conv.mode !== "preview")
        throw new ApiError(
          409,
          "CRM_OWNS_HANDOFF",
          "Connected handoff изменяется только authoritative CRM API",
        );
      res.json(await repo(req).patch("conversation_refs", conv.id, input));
    },
  );
  app.get("/api/conversations/:id/timeline", async (req, res) => {
    const r = repo(req);
    let conv = requireValue(
      await r.get<Conversation>("conversation_refs", String(req.params.id)),
    );
    let connectionError: string | undefined;
    if (conv.mode !== "preview") {
      try {
        await gateway.reconcile(r, conv);
        conv = requireValue(
          await r.get<Conversation>("conversation_refs", conv.id),
        );
      } catch (e) {
        connectionError = e instanceof ApiError ? e.message : "CRM недоступна";
      }
    }
    const messages = (
      await r.list<Message>(
        conv.mode === "preview" ? "preview_messages" : "transcript_snapshots",
      )
    )
      .filter((x) => x.conversationId === conv.id)
      .sort((a, b) =>
        conv.mode === "preview"
          ? (a.sequence ?? 0) - (b.sequence ?? 0)
          : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    for (const m of messages)
      for (const a of m.attachments) {
        try {
          await media.authorized(r, a.id);
          a.url = media.sign(r.workspaceId, a.id);
        } catch {
          a.url = undefined;
        }
      }
    res.json({
      conversation: conv,
      messages,
      attempts: (await r.list<Attempt>("message_attempts")).filter(
        (x) => x.conversationId === conv.id,
      ),
      runs: (await r.list<Run>("agent_runs")).filter(
        (x) => x.conversationId === conv.id,
      ),
      annotations: (await r.list<Annotation>("tester_annotations")).filter(
        (x) => x.conversationId === conv.id,
      ),
      calls: (await r.list<Call>("call_sessions")).filter(
        (x) => x.conversationId === conv.id,
      ),
      connectionError,
      cached: Boolean(connectionError),
      nextCursor: messages.at(-1)?.id,
    });
  });
  app.post(
    "/api/conversations/:id/messages",
    roles("admin", "tester"),
    async (req, res) =>
      res
        .status(202)
        .json(
          await gateway.enqueue(
            req.principal.workspaceId,
            String(req.params.id),
            messageSchema.parse(req.body),
          ),
        ),
  );
  app.post(
    "/api/attempts/:id/retry",
    roles("admin", "tester"),
    async (req, res) => {
      const r = repo(req);
      const a = requireValue(
        await r.get<Attempt>("message_attempts", String(req.params.id)),
      );
      if (a.status !== "failed")
        throw new ApiError(
          409,
          "INVALID_STATE",
          "Повтор доступен только для failed",
        );
      await r.put(
        "message_attempts",
        {
          ...a,
          status: "queued",
          error: undefined,
          nextAt: now(),
          updatedAt: now(),
        },
        { status: "queued", next_at: now() },
      );
      await r.patch("agent_runs", a.runId, { status: "retrying" }, [
        "failed",
        "completion_unknown",
      ]);
      res.json({ queued: true });
    },
  );
  app.post(
    "/api/runs/:id/retry",
    roles("admin", "tester"),
    async (req, res) => {
      const r = repo(req),
        run = requireValue(
          await r.get<Run>("agent_runs", String(req.params.id)),
        );
      if (!["failed", "completion_unknown"].includes(run.status))
        throw new ApiError(
          409,
          "INVALID_STATE",
          "Запуск ещё активен или завершён",
        );
      const attempt = requireValue(
        (await r.list<Attempt>("message_attempts")).find(
          (a) => a.runId === run.id,
        ),
      );
      await r.patch("message_attempts", attempt.id, {
        status: "queued",
        tries: 0,
        nextAt: now(),
      });
      await r.patch("agent_runs", run.id, { status: "retrying" });
      await r.audit(
        req.principal.name,
        "run_recovery_replay",
        run.id,
        "Повтор с исходными idempotency/correlation IDs",
      );
      res.json({ queued: true });
    },
  );
  app.post(
    "/api/media",
    roles("admin", "tester"),
    express.raw({ type: "application/octet-stream", limit: "20mb" }),
    async (req, res) => {
      const asset = await media.upload(
        repo(req),
        req.principal.userId,
        decodeURIComponent(String(req.headers["x-file-name"] ?? "attachment")),
        String(req.headers["x-file-type"] ?? ""),
        req.body,
      );
      res.status(201).json({
        ...asset,
        url: media.sign(req.principal.workspaceId, asset.id),
      });
    },
  );
  app.get("/api/media/:id/url", async (req, res) => {
    await media.authorized(repo(req), String(req.params.id));
    res.json({
      url: media.sign(req.principal.workspaceId, String(req.params.id)),
    });
  });
  app.post(
    "/api/annotations",
    roles("admin", "tester", "reviewer"),
    async (req, res) => {
      const input = annotationSchema.parse(req.body),
        r = repo(req);
      requireValue(
        await r.get<Conversation>("conversation_refs", input.conversationId),
      );
      let valid =
        input.targetType === "conversation" &&
        input.targetId === input.conversationId;
      if (input.targetType === "message")
        valid = [
          ...(await r.list<Message>("preview_messages")),
          ...(await r.list<Message>("transcript_snapshots")),
        ].some(
          (v) =>
            v.id === input.targetId &&
            v.conversationId === input.conversationId,
        );
      if (input.targetType === "run")
        valid = (await r.list<Run>("agent_runs")).some(
          (v) =>
            v.id === input.targetId &&
            v.conversationId === input.conversationId,
        );
      if (input.targetType === "tool")
        valid = (await r.list<Run>("agent_runs")).some(
          (v) =>
            v.conversationId === input.conversationId &&
            v.tools.some((t) => t.id === input.targetId),
        );
      if (input.targetType === "call")
        valid = (await r.list<Call>("call_sessions")).some(
          (v) =>
            v.id === input.targetId &&
            v.conversationId === input.conversationId,
        );
      if (!valid)
        throw new ApiError(
          400,
          "INVALID_TARGET",
          "Цель заметки не относится к этому разговору",
        );
      const a = record({
        ...input,
        author: req.principal.name,
        status: "open",
        history: [],
      });
      await r.put("tester_annotations", a, {
        conversation_id: input.conversationId,
      });
      res.status(201).json(a);
    },
  );
  app.patch(
    "/api/annotations/:id",
    roles("admin", "tester", "reviewer"),
    async (req, res) => {
      const input = z
        .object({
          body: z.string().trim().min(1).max(4000).optional(),
          status: z.enum(["open", "resolved"]).optional(),
          severity: z.enum(["info", "warning", "critical"]).optional(),
          flags: z.array(z.string().max(80)).max(10).optional(),
        })
        .strict()
        .parse(req.body);
      const updated = await db.transaction(async (tx) => {
        await tx.query(
          "SELECT id FROM tester_annotations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [req.principal.workspaceId, req.params.id],
        );
        return new Repository(tx, req.principal.workspaceId).update<Annotation>(
          "tester_annotations",
          String(req.params.id),
          (v) => ({
            ...v,
            ...input,
            history: [
              ...v.history,
              {
                at: now(),
                author: req.principal.name,
                body: v.body,
                status: v.status,
              },
            ],
          }),
        );
      });
      res.json(updated);
    },
  );
  app.post("/api/agents", roles("admin"), async (req, res) => {
    const input = z
      .object({
        name: z.string().min(1).max(100),
        description: z.string().max(1000).default(""),
        workflowId: z.string().max(120).default("not-connected"),
        model: z.string().max(120).default("preview-template"),
        body: z.string().min(1).max(50000),
      })
      .strict()
      .parse(req.body);
    const result = await db.transaction(async (tx) => {
      const r = new Repository(tx, req.principal.workspaceId),
        a = record({
          name: input.name,
          description: input.description,
          workflowId: input.workflowId,
          model: input.model,
          timeoutMs: 15000,
          maxRetries: 3,
          tools: [],
          flags: {},
          activeVersionId: "",
        });
      await r.put("agent_configurations", a);
      const p = record({
        agentId: a.id,
        version: 1,
        body: input.body,
        status: "published",
        author: req.principal.name,
      });
      await r.put("prompt_versions", p);
      const active = { ...a, activeVersionId: p.id };
      await r.put("agent_configurations", active);
      await r.audit(
        req.principal.name,
        "agent_created",
        a.id,
        "Studio registry only",
      );
      return active;
    });
    res.status(201).json(result);
  });
  app.patch("/api/agents/:id", roles("admin"), async (req, res) => {
    const input = z
      .object({
        name: z.string().min(1).max(100).optional(),
        workflowId: z.string().max(120).optional(),
        model: z.string().max(120).optional(),
        timeoutMs: z.number().int().min(1000).max(30000).optional(),
        maxRetries: z.number().int().min(0).max(5).optional(),
        tools: z.array(z.string().max(80)).max(40).optional(),
        flags: z.record(z.boolean()).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      await repo(req).update<Agent>(
        "agent_configurations",
        String(req.params.id),
        (v) => ({ ...v, ...input }),
      ),
    );
    await repo(req).audit(
      req.principal.name,
      "agent_updated",
      String(req.params.id),
      "Конфигурация агента обновлена",
    );
  });
  app.post("/api/agents/:id/prompts", roles("admin"), async (req, res) => {
    const input = z
      .object({
        body: z.string().min(1).max(50000),
        parentId: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    const r = repo(req);
    const agent = requireValue(
      await r.get<Agent>("agent_configurations", String(req.params.id)),
    );
    const existing = (await r.list<Prompt>("prompt_versions")).filter(
      (p) => p.agentId === agent.id,
    );
    const p = record({
      agentId: agent.id,
      version: Math.max(0, ...existing.map((p) => p.version)) + 1,
      body: input.body,
      status: "draft",
      author: req.principal.name,
      parentId: input.parentId,
    });
    await r.put("prompt_versions", p, { agent_id: agent.id });
    await r.audit(
      req.principal.name,
      "prompt_draft_created",
      p.id,
      "Черновик сохранён",
    );
    res.status(201).json(p);
  });
  app.patch("/api/prompts/:id", roles("admin"), async (req, res) => {
    const { body } = z
      .object({ body: z.string().min(1).max(50000) })
      .strict()
      .parse(req.body);
    const r = repo(req);
    const p = requireValue(
      await r.get<Prompt>("prompt_versions", String(req.params.id)),
    );
    if (p.status !== "draft")
      throw new ApiError(
        409,
        "IMMUTABLE_VERSION",
        "Опубликованная версия неизменяема. Создайте черновик",
      );
    const updated = await r.patch("prompt_versions", p.id, { body }, ["draft"]);
    if (!updated)
      throw new ApiError(409, "IMMUTABLE_VERSION", "Версия уже опубликована");
    res.json(updated);
    await r.audit(
      req.principal.name,
      "prompt_draft_updated",
      p.id,
      "Черновик изменён",
    );
  });
  app.post("/api/prompts/:id/publish", roles("admin"), async (req, res) => {
    const r = repo(req);
    const p = requireValue(
      await r.get<Prompt>("prompt_versions", String(req.params.id)),
    );
    await db.transaction(async (tx) => {
      const t = new Repository(tx, r.workspaceId);
      await t.patch("prompt_versions", p.id, { status: "published" });
      await t.patch("agent_configurations", p.agentId, {
        activeVersionId: p.id,
      });
      await t.audit(
        req.principal.name,
        "prompt_registry_activated",
        p.id,
        "Активна в Studio registry; n8n sync не подключён",
      );
    });
    res.json({ activeVersionId: p.id, sync: "NOT_CONNECTED" });
  });
  app.post("/api/scenarios", roles("admin", "tester"), async (req, res) => {
    const value = record(scenarioSchema.parse(req.body));
    await repo(req).put("test_scenarios", value);
    res.status(201).json(value);
  });
  app.post(
    "/api/scenarios/:id/run",
    roles("admin", "tester"),
    async (req, res) => {
      const input = z
        .object({
          clientId: z.string(),
          channel: z.enum(["whatsapp", "telegram", "instagram", "web"]),
        })
        .strict()
        .parse(req.body);
      const r = repo(req),
        scenario = requireValue(
          await r.get<Scenario>("test_scenarios", String(req.params.id)),
        );
      const conv = await newConversation(r, {
        ...input,
        title: scenario.name,
        stage: scenario.stage,
      });
      const setup =
        conv.mode === "preview"
          ? {
              status: "PREVIEW_ONLY" as const,
              references: {},
              reason:
                "Локальная симуляция. Бронь, платёж и проживание в CRM/PMS не создавались.",
            }
          : scenario.stage === "new_contact"
            ? {
                status: "READY" as const,
                references: {},
                reason:
                  "Новое обращение создаётся через единственного inbound owner",
              }
            : await new UnavailableScenarioSetup().prepare();
      const run = record({
        scenarioId: scenario.id,
        conversationId: conv.id,
        ...setup,
        assertions: scenario.assertions.map((a) => ({
          name: a.name,
          status: "pending",
          detail: "Оценка ещё не запускалась",
        })),
      });
      await r.put("scenario_runs", run, {
        scenario_id: scenario.id,
        conversation_id: conv.id,
      });
      res
        .status(201)
        .json({ conversation: conv, run, opening: scenario.opening });
    },
  );
  app.post(
    "/api/scenario-runs/:id/evaluate",
    roles("admin", "tester", "reviewer"),
    async (req, res) => {
      const r = repo(req),
        run = requireValue(
          await r.get<ScenarioRun>("scenario_runs", String(req.params.id)),
        ),
        scenario = requireValue(
          await r.get<Scenario>("test_scenarios", run.scenarioId),
        ),
        conv = requireValue(
          await r.get<Conversation>("conversation_refs", run.conversationId),
        );
      const messages = (
        await r.list<Message>(
          conv.mode === "preview" ? "preview_messages" : "transcript_snapshots",
        )
      ).filter((m) => m.conversationId === conv.id);
      const attempts = (await r.list<Attempt>("message_attempts")).filter(
        (a) => a.conversationId === conv.id,
      );
      const assertions = scenario.assertions.map((a) => {
        const applicable =
          messages.length > 0 && run.status !== "SETUP_UNAVAILABLE";
        const pass =
          a.kind === "contains"
            ? messages.some(
                (m) =>
                  m.direction === "outbound" &&
                  m.text.toLowerCase().includes(a.value.toLowerCase()),
              )
            : attempts.every(
                (a) =>
                  a.status !== "delivered" ||
                  messages.some(
                    (m) => m.externalMessageId === a.externalMessageId,
                  ),
              );
        return {
          name: a.name,
          status: applicable
            ? pass
              ? ("pass" as const)
              : ("fail" as const)
            : ("pending" as const),
          detail: applicable
            ? "Проверено по сохранённой переписке"
            : "Нет данных для оценки",
        };
      });
      res.json(
        await r.put("scenario_runs", { ...run, assertions, updatedAt: now() }),
      );
    },
  );
  app.post("/api/calls", roles("admin", "tester"), async (req, res) => {
    const input = z
      .object({
        conversationId: z.string(),
        direction: z.enum(["incoming", "outgoing"]),
        runId: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    const r = repo(req);
    requireValue(
      await r.get<Conversation>("conversation_refs", input.conversationId),
    );
    if (input.runId) {
      const run = requireValue(await r.get<Run>("agent_runs", input.runId));
      if (run.conversationId !== input.conversationId)
        throw new ApiError(
          400,
          "INVALID_RUN",
          "Run принадлежит другому разговору",
        );
    }
    const call = record({
      ...input,
      status: "ringing",
      durationSeconds: 0,
      turns: [],
    });
    await r.put("call_sessions", call, {
      conversation_id: input.conversationId,
    });
    res.status(201).json(call);
  });
  app.post(
    "/api/calls/:id/action",
    roles("admin", "tester"),
    async (req, res) => {
      const { action } = z
        .object({ action: z.enum(["accept", "reject", "end"]) })
        .parse(req.body);
      const r = repo(req);
      const call = requireValue(
        await r.get<Call>("call_sessions", String(req.params.id)),
      );
      if (
        (action === "accept" && call.status !== "ringing") ||
        (action === "reject" && call.status !== "ringing") ||
        (action === "end" && !["active", "ringing"].includes(call.status))
      )
        throw new ApiError(
          409,
          "INVALID_CALL_STATE",
          "Недопустимое действие звонка",
        );
      const updated = {
        ...call,
        status:
          action === "accept"
            ? ("active" as const)
            : action === "reject"
              ? ("rejected" as const)
              : ("ended" as const),
        startedAt: action === "accept" ? now() : call.startedAt,
        endedAt: action !== "accept" ? now() : undefined,
        durationSeconds:
          action === "end" && call.startedAt
            ? Math.floor((Date.now() - Date.parse(call.startedAt)) / 1000)
            : 0,
        updatedAt: now(),
      };
      res.json(await r.put("call_sessions", updated));
    },
  );
  app.post(
    "/api/calls/:id/turns",
    roles("admin", "tester"),
    async (req, res) => {
      const input = z
        .object({
          speaker: z.enum(["guest", "agent"]),
          text: z.string().min(1).max(4000),
          mediaId: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      const r = repo(req);
      if (input.mediaId) {
        const asset = await media.authorized(r, input.mediaId);
        if (asset.kind !== "audio")
          throw new ApiError(400, "AUDIO_REQUIRED", "Прикрепите аудиофайл");
      }
      res.json(
        await r.update<Call>("call_sessions", String(req.params.id), (c) => {
          if (c.status !== "active")
            throw new ApiError(409, "INVALID_CALL_STATE", "Звонок не активен");
          return {
            ...c,
            turns: [
              ...c.turns,
              { id: crypto.randomUUID(), ...input, at: now() },
            ],
          };
        }),
      );
    },
  );
  app.get("/api/audit", roles("admin", "reviewer"), async (req, res) =>
    res.json(await repo(req).list("audit_logs")),
  );
  app.use(express.static(resolve("dist/web")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve("dist/web/index.html")),
  );
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        err instanceof ApiError
          ? err.status
          : err instanceof ZodError
            ? 400
            : (err as { status?: number }).status === 413
              ? 413
              : 500;
      const code =
        err instanceof ApiError
          ? err.code
          : err instanceof ZodError
            ? "VALIDATION_ERROR"
            : status === 413
              ? "BODY_TOO_LARGE"
              : "INTERNAL_ERROR";
      if (status === 500)
        console.error(
          JSON.stringify({
            level: "error",
            event: "request_failed",
            code,
            correlationId: req.headers["x-correlation-id"],
          }),
        );
      res.status(status).json({
        error: {
          code,
          message:
            err instanceof ApiError
              ? err.message
              : err instanceof ZodError
                ? "Проверьте заполненные поля"
                : status === 413
                  ? "Файл или запрос слишком большой"
                  : "Внутренняя ошибка сервера",
          retryable: err instanceof ApiError && err.retryable,
          correlationId: req.headers["x-correlation-id"],
        },
      });
    },
  );
  return { app, gateway, integrations, media };
}
