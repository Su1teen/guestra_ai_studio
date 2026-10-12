import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { Repository, record, now } from "./repository.js";
import type {
  Conversation,
  Identity,
  Message,
  Attempt,
  Run,
  Agent,
  Prompt,
  Attachment,
  Client,
} from "../shared/domain.js";
import { Integrations } from "./integrations.js";
import { MediaService } from "./media.js";
import { ApiError, requireValue } from "./errors.js";
export class Gateway {
  private running = false;
  constructor(
    public db: Database,
    public integrations: Integrations,
    public media: MediaService,
  ) {}
  async enqueue(
    workspace: string,
    conversationId: string,
    input: {
      externalMessageId: string;
      text: string;
      attachmentIds: string[];
      replyTo?: string;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const repo = new Repository(tx, workspace);
      await tx.query(
        "SELECT id FROM conversation_refs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspace, conversationId],
      );
      const conv = requireValue(
        await repo.get<Conversation>("conversation_refs", conversationId),
      );
      if (conv.setupStatus === "SETUP_UNAVAILABLE")
        throw new ApiError(
          409,
          "SETUP_UNAVAILABLE",
          "Для сценария необходимо подготовить состояние в CRM/PMS",
        );
      const payloadHash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const existing = (await repo.list<Attempt>("message_attempts")).find(
        (a) =>
          a.conversationId === conversationId &&
          a.externalMessageId === input.externalMessageId,
      );
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Ключ сообщения уже использован для другого содержимого",
          );
        return existing;
      }
      if (input.replyTo) {
        const known = [
          ...(await repo.list<Message>("preview_messages")),
          ...(await repo.list<Message>("transcript_snapshots")),
        ].find((m) => m.id === input.replyTo && m.conversationId === conv.id);
        if (!known)
          throw new ApiError(
            400,
            "INVALID_REPLY",
            "Исходное сообщение не найдено",
          );
      }
      const attachments: Attachment[] = [];
      for (const id of input.attachmentIds) {
        const a = await this.media.authorized(repo, id);
        if (conv.mode !== "preview" && a.scanStatus !== "clean")
          throw new ApiError(
            409,
            "SCANNER_REQUIRED",
            "Непроверенный файл доступен только в Local Preview",
          );
        attachments.push({
          id: a.id,
          fileName: a.fileName,
          mimeType: a.mimeType,
          size: a.size,
          kind: a.kind,
          scanStatus: a.scanStatus,
        });
      }
      const agent = requireValue(
        conv.agentId
          ? await repo.get<Agent>("agent_configurations", conv.agentId)
          : (await repo.list<Agent>("agent_configurations"))[0],
      );
      const prompt = requireValue(
        await repo.get<Prompt>("prompt_versions", agent.activeVersionId),
      );
      const correlationId = crypto.randomUUID();
      const run = record({
        conversationId,
        correlationId,
        status: "queued",
        promptVersionId: prompt.id,
        promptSnapshot: prompt.body,
        model: agent.model,
        workflowId: agent.workflowId,
        configuration: {
          timeoutMs: agent.timeoutMs,
          maxRetries: agent.maxRetries,
          tools: agent.tools,
          flags: agent.flags,
        },
        tools: [],
        durationMs: 0,
      });
      await repo.put("agent_runs", run, { conversation_id: conversationId });
      const attempt = record({
        conversationId,
        correlationId,
        externalMessageId: input.externalMessageId,
        text: input.text,
        attachments,
        replyTo: input.replyTo,
        status: "queued" as const,
        tries: 0,
        nextAt: now(),
        sequence: 0,
        payloadHash,
        runId: run.id,
      });
      await repo.put("message_attempts", attempt, {
        conversation_id: conversationId,
        external_message_id: input.externalMessageId,
        status: attempt.status,
        next_at: attempt.nextAt,
      });
      const seq = (
        await tx.query<{ sequence: string }>(
          "SELECT sequence FROM message_attempts WHERE workspace_id=$1 AND id=$2",
          [workspace, attempt.id],
        )
      )[0].sequence;
      attempt.sequence = Number(seq);
      await repo.put("message_attempts", attempt);
      await repo.patch("conversation_refs", conv.id, {
        draft: "",
        lastText: input.text || "Вложение",
      });
      return attempt;
    });
  }
  async reconcile(repo: Repository, conv: Conversation) {
    if (conv.mode === "preview" || !conv.crmConversationId) return;
    const identity = requireValue(
      await repo.get<Identity>("virtual_identities", conv.identityId),
    );
    // Complete paged read, merge by authoritative ID. Required while CRM has a mutable time cursor.
    let after: string | undefined;
    let last: string | undefined;
    const attempts = (await repo.list<Attempt>("message_attempts")).filter(
      (a) => a.conversationId === conv.id,
    );
    for (let page = 0; page < 50; page++) {
      const result = await this.integrations.transcript(conv, identity, after);
      for (const m of result.messages) {
        const attempt = attempts.find(
          (a) => a.externalMessageId === m.externalMessageId,
        );
        if (attempt) {
          m.attachments = attempt.attachments;
          await repo.patch("message_attempts", attempt.id, {
            status: "delivered",
            crmMessageId: m.id,
          });
        }
        await repo.put("transcript_snapshots", m, { conversation_id: conv.id });
      }
      last = result.nextCursor ?? last;
      if (!result.hasMore || !result.nextCursor || result.nextCursor === after)
        break;
      if (page === 49)
        throw new ApiError(
          503,
          "RECONCILIATION_WINDOW_EXCEEDED",
          "История превышает 5000 записей. Для полного reconciliation требуется CRM changes cursor",
        );
      after = result.nextCursor;
    }
    const all = (await repo.list<Message>("transcript_snapshots"))
      .filter((m) => m.conversationId === conv.id)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    // Bounded read-only cache; never insert connected messages into preview_messages.
    for (const m of all.slice(0, -200))
      await repo.sql.query(
        "DELETE FROM transcript_snapshots WHERE workspace_id=$1 AND id=$2",
        [repo.workspaceId, m.id],
      );
    const latest = all.at(-1);
    await repo.patch("conversation_refs", conv.id, {
      cursor: last,
      lastText: latest?.text ?? conv.lastText,
    });
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    let claim:
      { workspace_id: string; id: string; conversation_id: string } | undefined;
    try {
      claim = await this.db.transaction(async (tx) => {
        const rows = await tx.query<{
          workspace_id: string;
          id: string;
          conversation_id: string;
        }>(
          `SELECT a.workspace_id,a.id,a.conversation_id FROM message_attempts a JOIN conversation_refs c ON c.id=a.conversation_id AND c.workspace_id=a.workspace_id JOIN agent_runs r ON r.id=a.data->>'runId' AND r.workspace_id=a.workspace_id WHERE (a.status IN ('queued','processing','awaiting_crm') OR (a.status='delivered' AND r.data->>'status' IN ('queued','processing','retrying','awaiting_crm','inbound_saved'))) AND a.next_at<=now() AND r.data->>'status' NOT IN ('completion_unknown') AND (c.lease_until IS NULL OR c.lease_until<now()) AND NOT EXISTS(SELECT 1 FROM message_attempts p JOIN agent_runs pr ON pr.id=p.data->>'runId' AND pr.workspace_id=p.workspace_id WHERE p.workspace_id=a.workspace_id AND p.conversation_id=a.conversation_id AND p.sequence<a.sequence AND (p.status IN ('queued','processing','awaiting_crm') OR pr.data->>'status' IN ('awaiting_crm','inbound_saved','completion_unknown'))) ORDER BY a.sequence LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,
        );
        const row = rows[0];
        if (row)
          await tx.query(
            "UPDATE conversation_refs SET lease_until=now()+interval '90 seconds' WHERE workspace_id=$1 AND id=$2",
            [row.workspace_id, row.conversation_id],
          );
        return row;
      });
      if (!claim) return;
      const repo = new Repository(this.db, claim.workspace_id);
      let attempt = requireValue(
        await repo.get<Attempt>("message_attempts", claim.id),
      );
      const conv = requireValue(
        await repo.get<Conversation>(
          "conversation_refs",
          claim.conversation_id,
        ),
      );
      const run = requireValue(
        await repo.get<Run>("agent_runs", attempt.runId),
      );
      if (["completed", "human_owned"].includes(run.status)) {
        try {
          await this.reconcile(repo, conv);
        } catch {}
        await repo.patch("message_attempts", attempt.id, {
          nextAt: new Date(Date.now() + 5000).toISOString(),
        });
        return;
      }
      const start = Date.now();
      const client = requireValue(
        await repo.get<Client>("virtual_clients", conv.clientId),
      );
      if (
        ["awaiting_crm", "delivered"].includes(attempt.status) &&
        attempt.tries >= 1 + (run.configuration?.maxRetries ?? 3)
      ) {
        await repo.patch("agent_runs", run.id, {
          status: "completion_unknown",
          error:
            "Подтверждение завершения не получено. Очередь этого чата приостановлена до signed callback; повтор безопасен с тем же ключом.",
        });
        if (attempt.status !== "delivered")
          await repo.patch("message_attempts", attempt.id, {
            status: "failed",
            error: "Истёк срок подтверждения n8n/CRM",
          });
        return;
      }
      const knownDelivered = attempt.status === "delivered";
      attempt = {
        ...attempt,
        status: knownDelivered ? "delivered" : "processing",
        tries: attempt.tries + 1,
        updatedAt: now(),
      };
      await repo.patch(
        "message_attempts",
        attempt.id,
        { status: attempt.status, tries: attempt.tries },
        ["queued", "processing", "awaiting_crm", "delivered"],
      );
      await repo.patch("agent_runs", run.id, { status: "processing" }, [
        "queued",
        "retrying",
        "awaiting_crm",
        "inbound_saved",
        "processing",
      ]);
      try {
        if (conv.mode === "preview") {
          const inbound: Message = {
            ...record({}),
            id: conv.id + ":" + attempt.externalMessageId,
            conversationId: conv.id,
            direction: "inbound",
            senderType: "guest",
            text: attempt.text,
            externalMessageId: attempt.externalMessageId,
            deliveryStatus: "local",
            attachments: attempt.attachments,
            replyTo: attempt.replyTo,
            source: "preview",
          };
          await repo.put("preview_messages", inbound, {
            conversation_id: conv.id,
          });
          if (!conv.handoff) {
            const text = attempt.text.toLowerCase().includes("заезд")
              ? "В локальном примере можно обсудить детали заезда. Точное время и условия должен подтвердить подключённый агент по данным гостиницы."
              : attempt.text.toLowerCase().includes("оплат")
                ? "Для оплаты нужна подтверждённая ссылка из тестовой интеграции. Local Preview не создаёт платежи или бронирования."
                : "Спасибо! Это пример ответа Local Preview. Как только подключим тестового агента, он сможет проверить информацию через CRM и PMS. Расскажите подробнее о вашем запросе.";
            const msg: Message = {
              ...record({}),
              id: conv.id + ":preview-reply:" + attempt.externalMessageId,
              conversationId: conv.id,
              direction: "outbound",
              senderType: "agent",
              text,
              deliveryStatus: "local",
              attachments: [],
              source: "preview",
            };
            await repo.put("preview_messages", msg, {
              conversation_id: conv.id,
            });
          }
          await repo.put(
            "message_attempts",
            { ...attempt, status: "delivered", updatedAt: now() },
            { status: "delivered" },
          );
          await repo.put("agent_runs", {
            ...run,
            status: conv.handoff ? "human_owned" : "preview_completed",
            durationMs: Date.now() - start,
            updatedAt: now(),
          });
        } else {
          const identity = requireValue(
            await repo.get<Identity>("virtual_identities", conv.identityId),
          );
          if (conv.mode === "crm") {
            const result = await this.integrations.inbound(
              conv,
              identity,
              attempt,
              client,
            );
            const crmConv = result.context?.conversation?.id;
            if (!crmConv)
              throw new ApiError(
                502,
                "INVALID_CRM_RESPONSE",
                "CRM не вернула conversation ID",
                true,
              );
            const mapped = requireValue(
              await repo.patch<Conversation>("conversation_refs", conv.id, {
                crmConversationId: crmConv,
                handoff: !result.aiReplyAllowed,
              }),
            );
            await repo.patch("message_attempts", attempt.id, {
              status: "awaiting_crm",
              crmMessageId: result.messageId,
            });
            await repo.patch("agent_runs", run.id, {
              status: "inbound_saved_no_orchestrator",
              durationMs: Date.now() - start,
            });
            await this.reconcile(repo, mapped);
          } else {
            const media = attempt.attachments.map((a) => ({
              ...a,
              url: new URL(
                this.media.sign(repo.workspaceId, a.id, "workflow"),
                this.integrations.cfg.publicUrl,
              ).toString(),
            }));
            const result = await this.integrations.dispatch(
              repo.workspaceId,
              conv,
              identity,
              attempt,
              client,
              {
                versionId: run.promptVersionId,
                body: run.promptSnapshot,
                model: run.model,
                workflowId: run.workflowId,
                configuration: run.configuration,
              },
              media,
              run.configuration?.timeoutMs ?? 15000,
            );
            if (!result.accepted)
              throw new ApiError(
                502,
                "WORKFLOW_REJECTED",
                "n8n не подтвердила приём",
                true,
              );
            await repo.patch(
              "message_attempts",
              attempt.id,
              {
                status: knownDelivered ? "delivered" : "awaiting_crm",
                nextAt: new Date(
                  Date.now() + (run.configuration?.timeoutMs ?? 15000),
                ).toISOString(),
              },
              ["queued", "processing", "awaiting_crm", "delivered"],
            );
            await repo.patch(
              "agent_runs",
              run.id,
              { status: "awaiting_crm", durationMs: Date.now() - start },
              ["queued", "processing", "retrying"],
            );
          }
        }
      } catch (e) {
        const retryable = e instanceof ApiError && e.retryable;
        const retry =
          retryable && attempt.tries < 1 + (run.configuration?.maxRetries ?? 3);
        const error =
          e instanceof ApiError ? e.message : "Ошибка обработки сообщения";
        await repo.patch(
          "message_attempts",
          attempt.id,
          {
            status: retry ? "queued" : "failed",
            error,
            nextAt: new Date(
              Date.now() + Math.min(30000, 1000 * 2 ** attempt.tries),
            ).toISOString(),
          },
          ["queued", "processing", "awaiting_crm"],
        );
        await repo.patch(
          "agent_runs",
          run.id,
          {
            status: retry
              ? "retrying"
              : conv.mode === "sandbox" && retryable
                ? "completion_unknown"
                : "failed",
            error,
            durationMs: Date.now() - start,
          },
          ["queued", "processing", "retrying", "awaiting_crm"],
        );
      }
    } finally {
      if (claim)
        await this.db.query(
          "UPDATE conversation_refs SET lease_until=NULL WHERE workspace_id=$1 AND id=$2",
          [claim.workspace_id, claim.conversation_id],
        );
      this.running = false;
    }
  }
}
