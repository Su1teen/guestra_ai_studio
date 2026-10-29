import express from "express";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
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
import { Integrations } from "./integrations.js";
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
import { registerOrchestration } from "./orchestration.js";
import { ScenarioFixtures } from "./scenario-setup.js";
import { databaseReadiness } from "./readiness.js";
import { PromptDeployments } from "./prompt-deployments.js";
export function createApp(
  db: Database,
  cfg: Config,
  options: { publisher?: import("./integrations.js").PromptPublisher } = {},
) {
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
    const result = await databaseReadiness(db, cfg);
    res.status(result.ready ? 200 : 503).json({
      status: result.ready ? "ready" : result.status,
      database: db.kind,
    });
  });
  app.get("/api/auth/options", (_req, res) =>
    res.json({ localPreview: cfg.local }),
  );
  const claims = registerOrchestration(app, db, cfg, gateway, media);
  const fixtures = new ScenarioFixtures(db, integrations);
  const promptDeployments = new PromptDeployments(db, cfg, options.publisher);
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
  app.get("/api/integrations/readiness", roles("admin"), async (_req, res) => {
    const dbReady = await databaseReadiness(db, cfg);
    const statuses: string[] = [dbReady.ready ? "DATABASE_READY" : dbReady.status];
    if (dbReady.ready) statuses.push("STUDIO_READY");
    const discovery = await integrations.capabilities();
    for (const connection of discovery.connections) {
      if (connection.name === "n8n" && connection.status === "NOT_CONFIGURED") statuses.push("N8N_NOT_CONFIGURED");
      else if (connection.status === "CONNECTED") statuses.push(connection.name === "crm" ? "CRM_V2_READY" : connection.name === "pms" ? "PMS_V2_READY" : "N8N_READY");
      else statuses.push(connection.name.toUpperCase() + ":" + connection.status);
    }
    res.json({statuses, ready: dbReady.ready && discovery.mappingReady});
  });
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
  app.get("/api/integrations", async (req, res) => {
    const caps = await integrations.capabilities(),
      database = await databaseReadiness(db, cfg);
    res.json({
      ...caps,
      database,
      crmReady: caps.crmReady && database.ready,
      sandboxReady:
        caps.sandboxReady &&
        database.ready &&
        Boolean(
          cfg.orchestratorWorkspaces?.includes(req.principal.workspaceId),
        ),
      mappings: await repo(req).list("integration_mappings"),
      mode: (
        await db.query<{ mode: Mode }>(
          "SELECT mode FROM workspaces WHERE id=$1",
          [req.principal.workspaceId],
        )
      )[0].mode,
      promptSync: "NOT_CONNECTED",
      traceApi: integrations.v2
        ? "CRM_V2_CONFIGURED_NOT_VERIFIED"
        : "LEGACY_V1",
      telephony: "VIRTUAL_ONLY",
    });
  });
  app.put("/api/integrations/mode", roles("admin"), async (req, res) => {
    const { mode } = z
      .object({ mode: z.enum(["preview", "crm", "sandbox"]) })
      .parse(req.body);
    // Local preview kept dialogues outside CRM; it exists only for a loopback developer run.
    if (mode === "preview" && !cfg.local)
      throw new ApiError(
        409,
        "PREVIEW_RETIRED",
        "Локальный режим отключён: все диалоги Studio ведутся через CRM",
      );
    const caps = await integrations.capabilities();
    const database = await databaseReadiness(db, cfg);
    if (mode !== "preview" && !database.ready)
      throw new ApiError(
        409,
        "DATABASE_NOT_ATTESTED",
        "Studio database not attested",
      );
    if (
      mode === "sandbox" &&
      !cfg.orchestratorWorkspaces?.includes(req.principal.workspaceId)
    )
      throw new ApiError(
        409,
        "WORKSPACE_SCOPE_DENIED",
        "N8N_WORKSPACE_IDS must include this workspace",
      );
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
      const selectedAgentId =
        input.agentId ?? (await r.list<Agent>("agent_configurations"))[0]?.id;
      if (input.promptVersionId) {
        const prompt = requireValue(
          await r.get<Prompt>("prompt_versions", input.promptVersionId),
        );
        if (prompt.agentId !== selectedAgentId || prompt.status === "draft")
          throw new ApiError(
            409,
            "IMMUTABLE_VERSION_REQUIRED",
            "Choose a matching immutable test/published prompt",
          );
      }
      const workspace = (
        await tx.query<{ mode: Mode }>(
          "SELECT mode FROM workspaces WHERE id=$1",
          [r.workspaceId],
        )
      )[0];
      if (workspace.mode === "preview" && !cfg.local)
        throw new ApiError(
          409,
          "CRM_MODE_REQUIRED",
          "Подключите CRM: диалоги Studio должны попадать в Inbox CRM",
        );
      const namespace =
        workspace.mode === "preview"
          ? ""
          : `${cfg.environment ?? "production"}:${cfg.crmProperty}:`;
      const externalUserId = `studio:${r.workspaceId}:${workspace.mode}:${namespace}${input.clientId}:${input.channel}`;
      let identity = (await r.list<Identity>("virtual_identities")).find(
        (i) => i.externalUserId === externalUserId,
      );
      if (!identity) {
        identity = record({
          clientId: input.clientId,
          displayChannel: input.channel,
          transportChannel: "simulator" as const,
          externalUserId,
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
        promptVersionId: input.promptVersionId,
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
        ...(workspace.mode !== "preview"
          ? {
              propertyMapping: {
                crmPropertyId: cfg.crmProperty,
                crmTenantId: cfg.crmTenant ?? "",
                pmsPropertyId: cfg.pmsProperty,
                pmsTenantId: cfg.pmsTenant ?? "",
                environment: cfg.environment ?? "production",
              },
            }
          : {}),
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
    const page = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        before: z.string().optional(),
      })
      .parse(req.query);
    const table =
      conv.mode === "preview" ? "preview_messages" : "transcript_snapshots";
    const args: unknown[] = [r.workspaceId, conv.id, page.limit + 1];
    let before = "";
    if (page.before) {
      const anchor = requireValue(await r.get<Message>(table, page.before));
      if (anchor.conversationId !== conv.id)
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "Message cursor belongs to another conversation",
        );
      if (conv.mode === "preview") {
        const row = (
          await db.query<{ sequence: string }>(
            "SELECT sequence FROM preview_messages WHERE workspace_id=$1 AND id=$2",
            [r.workspaceId, anchor.id],
          )
        )[0];
        args.push(row.sequence);
        before = "AND sequence<$4::bigint";
      } else {
        args.push(anchor.createdAt, anchor.id);
        before = "AND (data->>'createdAt',id)<($4::text,$5::text)";
      }
    }
    const rows = await db.query<{ data: Message; sequence?: string }>(
      `SELECT data${conv.mode === "preview" ? ",sequence" : ""} FROM ${table} WHERE workspace_id=$1 AND conversation_id=$2 AND COALESCE(data->>'tombstone','false')<>'true' ${before} ORDER BY ${conv.mode === "preview" ? "sequence DESC" : "data->>'createdAt' DESC,id DESC"} LIMIT $3`,
      args,
    );
    const messages = rows
      .slice(0, page.limit)
      .reverse()
      .map((x) => ({
        ...x.data,
        ...(x.sequence ? { sequence: Number(x.sequence) } : {}),
      }));
    const removedMessageIds = (
      await db.query<{ id: string }>(
        "SELECT id FROM transcript_snapshots WHERE workspace_id=$1 AND conversation_id=$2 AND data->>'tombstone'='true'",
        [r.workspaceId, conv.id],
      )
    ).map((x) => x.id);
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
      olderCursor: messages[0]?.id,
      hasOlder: rows.length > page.limit,
      removedMessageIds,
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
      if (input.targetType === "message" && !valid)
        valid = (await r.list<Attempt>("message_attempts")).some(
          (a) =>
            a.id === input.targetId &&
            a.conversationId === input.conversationId,
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
      if (input.targetType === "operation" || input.targetType === "deployment")
        valid = (await r.list<Run>("agent_runs")).some(
          (v) =>
            v.conversationId === input.conversationId &&
            (input.targetType === "operation"
              ? v.businessOperationId === input.targetId
              : v.deploymentId === input.targetId),
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
  app.patch(
    "/api/annotations/:id/reference",
    roles("admin", "tester", "reviewer"),
    async (req, res) => {
      const { reference } = z
          .object({ reference: z.string().min(1).max(200) })
          .strict()
          .parse(req.body),
        r = repo(req),
        annotation = requireValue(
          await r.get<Annotation>("tester_annotations", String(req.params.id)),
        );
      const attempts = (await r.list<Attempt>("message_attempts")).filter(
        (a) =>
          a.conversationId === annotation.conversationId &&
          a.id === annotation.targetId,
      );
      const runs = (await r.list<Run>("agent_runs")).filter(
        (v) =>
          v.conversationId === annotation.conversationId &&
          v.id === annotation.targetId,
      );
      if (
        !attempts.some((a) => a.crmMessageId === reference) &&
        !runs.some((v) =>
          [v.executionId, v.businessOperationId, v.deploymentId].includes(
            reference,
          ),
        )
      )
        throw new ApiError(
          409,
          "REFERENCE_NOT_VERIFIED",
          "Reference must come from authoritative run/message evidence",
        );
      if (
        annotation.externalReference &&
        annotation.externalReference !== reference
      )
        throw new ApiError(
          409,
          "IDENTITY_CONFLICT",
          "Annotation reference already bound",
        );
      res.json(
        await r.patch("tester_annotations", annotation.id, {
          externalReference: reference,
        }),
      );
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
        flags: z.record(z.string(), z.boolean()).optional(),
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
      await t.patch("prompt_versions", p.id, {
        status: "published",
        deploymentState: "STUDIO_PUBLISHED",
      });
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
    res.json({
      activeVersionId: p.id,
      sync: "NOT_CONNECTED",
      deploymentState: "STUDIO_PUBLISHED",
    });
  });
  app.post("/api/scenarios", roles("admin", "tester"), async (req, res) => {
    const value = record(scenarioSchema.parse(req.body));
    await repo(req).put("test_scenarios", value);
    res.status(201).json(value);
  });
  app.post("/api/prompts/:id/deploy", roles("admin"), async (req, res) =>
    res.json(
      await promptDeployments.deploy(
        req.principal.workspaceId,
        String(req.params.id),
      ),
    ),
  );
  app.post(
    "/api/prompts/:id/rollback-deployment",
    roles("admin"),
    async (req, res) =>
      res.json(
        await promptDeployments.rollback(
          req.principal.workspaceId,
          String(req.params.id),
        ),
      ),
  );
  app.post(
    "/api/prompts/:id/test-version",
    roles("admin"),
    async (req, res) => {
      const r = repo(req),
        p = requireValue(
          await r.get<Prompt>("prompt_versions", String(req.params.id)),
        );
      if (p.status !== "draft")
        throw new ApiError(
          409,
          "IMMUTABLE_VERSION",
          "Test version must be a draft",
        );
      const testVersion = await r.patch(
        "prompt_versions",
        p.id,
        {
          deploymentState: "TEST_VERSION",
          status: "test",
        },
        ["draft"],
      );
      if (!testVersion)
        throw new ApiError(
          409,
          "IMMUTABLE_VERSION",
          "Version already frozen/published",
        );
      res.json(testVersion);
    },
  );
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
              reason: "Local Preview; business state не создавался",
            }
          : {
              status: "SETUP_UNAVAILABLE" as const,
              references: {},
              reason: "Ожидаем проверенный CRM/PMS fixture setup",
            };
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
      if (conv.mode === "sandbox") {
        try {
          await fixtures.prepare(r.workspaceId, run.id);
        } catch (e) {
          await r.patch("scenario_runs", run.id, {
            status: "SETUP_UNAVAILABLE",
            reason: e instanceof ApiError ? e.message : "Setup недоступен",
          });
        }
      }
      res.status(201).json({
        conversation: await r.get<Conversation>("conversation_refs", conv.id),
        run: await r.get<ScenarioRun>("scenario_runs", run.id),
        opening: scenario.opening,
      });
    },
  );
  for (const action of ["setup", "retire", "simulate-payment"] as const)
    app.post(
      "/api/scenario-runs/:id/" + action,
      roles("admin", "tester"),
      async (req, res) => {
        const r = repo(req);
        requireValue(
          await r.get<ScenarioRun>("scenario_runs", String(req.params.id)),
        );
        res.json(
          action === "setup"
            ? await fixtures.prepare(r.workspaceId, String(req.params.id))
            : action === "retire"
              ? await fixtures.retire(r.workspaceId, String(req.params.id))
              : await fixtures.simulatePayment(
                  r.workspaceId,
                  String(req.params.id),
                ),
        );
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
  return {
    app,
    gateway,
    integrations,
    media,
    claims,
    fixtures,
    promptDeployments,
  };
}
