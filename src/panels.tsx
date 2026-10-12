import { useState, useEffect } from "react";
import {
  Plus,
  ArrowUpRight,
  Check,
  Clock,
  Save,
  GitBranch,
  RotateCcw,
  Play,
  Wifi,
  ShieldCheck,
  ChevronRight,
  Phone,
  PhoneIncoming,
  PhoneOff,
  FileText,
} from "lucide-react";
import type { Bootstrap, Timeline } from "./api";
import { api, stageLabels, modeLabels, time, upload } from "./api";
import type {
  Client,
  Conversation,
  Scenario,
  Prompt,
  Agent,
  Annotation,
  Call,
  Run,
} from "../shared/domain";
import { stages } from "../shared/domain";
import { Modal, Avatar, Empty } from "./components";
type Common = {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notice: (s: string) => void;
};
export function ClientForm({
  onClose,
  onDone,
  client,
}: {
  onClose: () => void;
  onDone: (v: Client) => void;
  client?: Client;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={client ? "Редактировать клиента" : "Новый виртуальный клиент"}
      onClose={onClose}
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            const v = await api<Client>(
              client ? "/clients/" + client.id : "/clients",
              client ? "PATCH" : "POST",
              {
                firstName: f.get("firstName"),
                lastName: f.get("lastName"),
                displayName: f.get("displayName"),
                phone: f.get("phone"),
                telegram: f.get("telegram"),
                channel: f.get("channel"),
                language: f.get("language"),
                property: "LES Боровое",
                parameters: { notes: String(f.get("notes") ?? "") },
              },
            );
            onDone(v);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-hint">
          <ShieldCheck size={18} />
          Вымышленная личность для тестов. Телефон не используется для
          объединения с реальными гостями.
        </div>
        <div className="field-grid">
          <label>
            Имя
            <input
              name="firstName"
              required
              defaultValue={client?.firstName}
              placeholder="Алия"
            />
          </label>
          <label>
            Фамилия
            <input
              name="lastName"
              defaultValue={client?.lastName}
              placeholder="Садыкова"
            />
          </label>
        </div>
        <label>
          Имя в чате
          <input
            name="displayName"
            required
            defaultValue={client?.displayName}
            placeholder="Алия Садыкова"
          />
        </label>
        <div className="field-grid">
          <label>
            Виртуальный телефон
            <input
              name="phone"
              defaultValue={client?.phone}
              placeholder="+7 …"
            />
          </label>
          <label>
            Telegram ID / username
            <input
              name="telegram"
              defaultValue={client?.telegram}
              placeholder="@test_guest"
            />
          </label>
        </div>
        <div className="field-grid">
          <label>
            Визуальный канал
            <select name="channel" defaultValue={client?.channel ?? "whatsapp"}>
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
              <option value="instagram">Instagram</option>
              <option value="web">Web chat</option>
            </select>
          </label>
          <label>
            Язык
            <select name="language" defaultValue={client?.language ?? "ru"}>
              <option value="ru">Русский</option>
              <option value="kk">Қазақша</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <label>
          Тестовые параметры
          <textarea
            name="notes"
            defaultValue={client?.parameters.notes}
            placeholder="Например: семья с детьми, впервые в Боровом"
            rows={3}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="button" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить клиента"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function ConversationForm({
  data,
  onClose,
  onDone,
}: {
  data: Bootstrap;
  onClose: () => void;
  onDone: (v: Conversation) => void;
}) {
  const [error, setError] = useState("");
  return (
    <Modal title="Новый разговор" onClose={onClose}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            onDone(
              await api<Conversation>(
                "/conversations",
                "POST",
                Object.fromEntries(f),
              ),
            );
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>
          Виртуальный клиент
          <select name="clientId" required>
            {data.clients.map((c) => (
              <option value={c.id} key={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Название
          <input
            name="title"
            placeholder="Например: семейные выходные"
            required
          />
        </label>
        <label>
          Агент
          <select name="agentId">
            {data.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field-grid">
          <label>
            Канал
            <select name="channel">
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
              <option value="instagram">Instagram</option>
              <option value="web">Web chat</option>
            </select>
          </label>
          <label>
            Начальная стадия
            <select name="stage">
              {stages.map((s) => (
                <option key={s} value={s}>
                  {stageLabels[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="form-hint">
          Режим: {modeLabels[data.workspace.mode]}. Для стадий с бронью или
          проживанием нужны подтверждённые CRM/PMS fixtures. В Local Preview
          состояние остаётся учебным.
        </p>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="button">Создать разговор</button>
        </footer>
      </form>
    </Modal>
  );
}
export function ClientsPanel({
  data,
  refresh,
  notice,
  onChat,
}: Common & { onChat: () => void }) {
  const [edit, setEdit] = useState<Client | null | undefined>();
  const writable = ["admin", "tester"].includes(data.user.role);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">TEST IDENTITIES</div>
          <h1>Виртуальные клиенты</h1>
          <p>Независимые личности. Постоянный контекст. Любой канал.</p>
        </div>
        {writable && (
          <button className="button" onClick={() => setEdit(null)}>
            <Plus size={17} />
            Новый клиент
          </button>
        )}
      </div>
      <div className="client-grid">
        {data.clients.map((c, i) => (
          <article className="client-card" key={c.id}>
            <Avatar name={c.displayName} index={i} />
            <h3>{c.displayName}</h3>
            <p>{c.property}</p>
            <div className="chips">
              <span className={"channel " + c.channel}>{c.channel}</span>
              <span>{c.language.toUpperCase()}</span>
              <span>TEST</span>
            </div>
            <dl>
              <div>
                <dt>Телефон</dt>
                <dd>{c.phone || "Не задан"}</dd>
              </div>
              <div>
                <dt>Telegram</dt>
                <dd>{c.telegram || "Не задан"}</dd>
              </div>
              <div>
                <dt>Разговоры</dt>
                <dd>
                  {data.conversations.filter((v) => v.clientId === c.id).length}
                </dd>
              </div>
            </dl>
            {writable && (
              <div className="card-footer">
                <button onClick={() => setEdit(c)}>Редактировать</button>
                <button onClick={onChat}>
                  Начать разговор <ArrowUpRight size={15} />
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {edit !== undefined && (
        <ClientForm
          client={edit ?? undefined}
          onClose={() => setEdit(undefined)}
          onDone={() => {
            setEdit(undefined);
            void refresh();
            notice("Клиент сохранён");
          }}
        />
      )}
    </div>
  );
}
export function ScenarioPanel({
  data,
  refresh,
  notice,
  onStart,
}: Common & { onStart: (id: string) => void }) {
  const [create, setCreate] = useState(false),
    [run, setRun] = useState<Scenario>();
  const [error, setError] = useState("");
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CUSTOMER JOURNEY</div>
          <h1>Сценарии тестирования</h1>
          <p>От первого обращения до следующего визита.</p>
        </div>
        {["admin", "tester"].includes(data.user.role) && (
          <button className="button" onClick={() => setCreate(true)}>
            <Plus size={17} />
            Новый сценарий
          </button>
        )}
      </div>
      <div className="scenario-grid">
        {data.scenarios.map((s) => (
          <article className="scenario-card" key={s.id}>
            <div className="scenario-top">
              <span className="scenario-icon">
                <Play size={19} />
              </span>
              <span className="badge neutral">{stageLabels[s.stage]}</span>
            </div>
            <h3>{s.name}</h3>
            <p>{s.description}</p>
            <div className="scenario-opening">«{s.opening}»</div>
            <footer>
              <span>{s.assertions.length} assertions</span>
              <button
                className="text-button"
                disabled={!["admin", "tester"].includes(data.user.role)}
                onClick={() => setRun(s)}
              >
                Запустить <ChevronRight size={16} />
              </button>
            </footer>
          </article>
        ))}
      </div>
      {data.scenarioRuns.length > 0 && (
        <>
          <h2 className="section-title">Последние запуски</h2>
          <div className="list-table">
            {data.scenarioRuns
              .slice()
              .reverse()
              .map((r) => (
                <div className="table-row" key={r.id}>
                  <div>
                    <b>
                      {data.scenarios.find((s) => s.id === r.scenarioId)?.name}
                    </b>
                    <small>{r.reason}</small>
                  </div>
                  <span className="badge neutral">{r.status}</span>
                  <span>
                    {r.assertions.filter((a) => a.status === "pass").length}/
                    {r.assertions.length}
                  </span>
                  <button
                    className="button secondary compact"
                    onClick={async () => {
                      try {
                        await api(
                          "/scenario-runs/" + r.id + "/evaluate",
                          "POST",
                        );
                        await refresh();
                        notice("Assertions обновлены");
                      } catch (e) {
                        notice((e as Error).message);
                      }
                    }}
                  >
                    Проверить
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Открыть разговор сценария"
                    onClick={() => onStart(r.conversationId)}
                  >
                    <ArrowUpRight size={18} />
                  </button>
                </div>
              ))}
          </div>
        </>
      )}
      {run && (
        <Modal
          title={"Запустить: " + run.name}
          onClose={() => setRun(undefined)}
        >
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                const result = await api<{
                  conversation: Conversation;
                  opening: string;
                }>(
                  "/scenarios/" + run.id + "/run",
                  "POST",
                  Object.fromEntries(f),
                );
                await api("/conversations/" + result.conversation.id, "PATCH", {
                  draft: result.opening,
                });
                await refresh();
                setRun(undefined);
                onStart(result.conversation.id);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label>
              Клиент
              <select name="clientId">
                {data.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Канал
              <select name="channel">
                <option value="whatsapp">WhatsApp</option>
                <option value="telegram">Telegram</option>
                <option value="instagram">Instagram</option>
                <option value="web">Web chat</option>
              </select>
            </label>
            <div className="form-hint">
              Сценарий создаст отдельный чат.{" "}
              {run.stage === "new_contact"
                ? "Для нового гостя setup не требуется."
                : "Без fixture API реальная интеграция вернёт SETUP_UNAVAILABLE."}
            </div>
            {error && <p className="error">{error}</p>}
            <footer>
              <button className="button">Создать тестовый чат</button>
            </footer>
          </form>
        </Modal>
      )}
      {create && (
        <Modal title="Новый сценарий" onClose={() => setCreate(false)}>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                await api("/scenarios", "POST", {
                  ...Object.fromEntries(f),
                  assertions: [
                    {
                      name: "Нет ложной доставки",
                      kind: "no_unconfirmed_delivery",
                      value: "",
                    },
                  ],
                });
                setCreate(false);
                await refresh();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label>
              Название
              <input name="name" required />
            </label>
            <label>
              Описание
              <textarea name="description" rows={2} />
            </label>
            <label>
              Начальная стадия
              <select name="stage">
                {stages.map((s) => (
                  <option key={s} value={s}>
                    {stageLabels[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Первое сообщение
              <textarea name="opening" rows={3} />
            </label>
            {error && <p className="error">{error}</p>}
            <footer>
              <button className="button">Сохранить сценарий</button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
function PromptDiff({ before, after }: { before: string; after: string }) {
  const old = before.split("\n"),
    updated = after.split("\n");
  return (
    <div className="prompt-diff">
      {Array.from({ length: Math.max(old.length, updated.length) }, (_, i) => (
        <div key={i}>
          {old[i] !== updated[i] && old[i] !== undefined && (
            <pre className="removed">− {old[i]}</pre>
          )}
          {updated[i] !== undefined && (
            <pre className={old[i] === updated[i] ? "unchanged" : "added"}>
              {old[i] === updated[i] ? "  " : "+ "}
              {updated[i]}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
export function AgentPanel({ data, refresh, notice }: Common) {
  const [agentId, setAgentId] = useState(data.agents[0]?.id),
    [createAgent, setCreateAgent] = useState(false),
    [versionId, setVersionId] = useState(""),
    [body, setBody] = useState(""),
    [diff, setDiff] = useState(false),
    [settings, setSettings] = useState(false),
    [busy, setBusy] = useState(false);
  const agent = data.agents.find((a) => a.id === agentId),
    versions = data.prompts
      .filter((p) => p.agentId === agentId)
      .sort((a, b) => b.version - a.version),
    selected =
      versions.find((p) => p.id === versionId) ??
      versions.find((p) => p.id === agent?.activeVersionId);
  useEffect(() => {
    setBody(selected?.body ?? "");
  }, [selected?.id, selected?.updatedAt]);
  if (!agent) return <Empty title="Нет агента" body="Registry ещё пуст" />;
  const active = versions.find((p) => p.id === agent.activeVersionId);
  const save = async () => {
    setBusy(true);
    try {
      const value =
        selected?.status === "draft"
          ? await api<Prompt>("/prompts/" + selected.id, "PATCH", { body })
          : await api<Prompt>("/agents/" + agent.id + "/prompts", "POST", {
              body,
              parentId: selected?.id,
            });
      setVersionId(value.id);
      await refresh();
      notice("Черновик сохранён в PostgreSQL");
    } catch (e) {
      notice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page agent-page">
      {createAgent && (
        <Modal title="Новый агент" onClose={() => setCreateAgent(false)}>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const a = await api<Agent>(
                  "/agents",
                  "POST",
                  Object.fromEntries(new FormData(e.currentTarget)),
                );
                await refresh();
                setAgentId(a.id);
                setVersionId("");
                setCreateAgent(false);
              } catch (e) {
                notice((e as Error).message);
              }
            }}
          >
            <label>
              Название
              <input name="name" required />
            </label>
            <label>
              Описание
              <input name="description" />
            </label>
            <label>
              Model metadata
              <input name="model" defaultValue="preview-template" />
            </label>
            <label>
              Workflow mapping
              <input name="workflowId" defaultValue="not-connected" />
            </label>
            <label>
              Первый системный промпт
              <textarea
                name="body"
                rows={5}
                required
                defaultValue={active?.body ?? ""}
              />
            </label>
            <p className="form-hint">
              Создание активирует первую версию только в Studio registry. n8n
              sync не подключён.
            </p>
            <footer>
              <button className="button">Создать агента</button>
            </footer>
          </form>
        </Modal>
      )}
      <div className="page-heading">
        <div>
          <div className="eyebrow">AGENT PLAYGROUND</div>
          <h1>Агенты и промпты</h1>
          <p>Редактируйте, сравнивайте и сохраняйте каждую версию.</p>
        </div>
        <button className="button secondary" onClick={() => setSettings(true)}>
          Настройки агента
        </button>
        {data.user.role === "admin" && (
          <button className="button" onClick={() => setCreateAgent(true)}>
            <Plus size={16} />
            Новый агент
          </button>
        )}
      </div>
      <div className="agent-registry">
        {data.agents.map((a) => (
          <button
            key={a.id}
            className={a.id === agentId ? "active" : ""}
            onClick={() => {
              setAgentId(a.id);
              setVersionId("");
            }}
          >
            <span className="agent-symbol">✳</span>
            <div>
              <b>{a.name}</b>
              <small>
                {a.model} ·{" "}
                {a.workflowId === "not-connected"
                  ? "Workflow не подключён"
                  : a.workflowId}
              </small>
            </div>
            <span className="badge green">Registry</span>
          </button>
        ))}
      </div>
      <div className="prompt-layout">
        <div className="prompt-editor">
          <header>
            <div>
              <FileText size={18} />
              <b>Системный промпт</b>
              <span className="badge neutral">
                v{selected?.version} · {selected?.status}
              </span>
            </div>
            <button className="text-button" onClick={() => setDiff(!diff)}>
              <GitBranch size={16} />
              {diff ? "Редактор" : "Сравнить с активным"}
            </button>
          </header>
          {diff ? (
            <PromptDiff before={active?.body ?? ""} after={body} />
          ) : (
            <textarea
              aria-label="Системный промпт"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              readOnly={data.user.role !== "admin"}
            />
          )}
          <footer>
            <small>
              Publish активирует Studio registry. Синхронизация с n8n не
              подключена.
            </small>
            <button
              className="button"
              disabled={busy || !body || data.user.role !== "admin"}
              onClick={() => void save()}
            >
              <Save size={16} />
              {busy
                ? "Сохраняем…"
                : selected?.status === "draft"
                  ? "Сохранить черновик"
                  : "Сохранить как черновик"}
            </button>
          </footer>
        </div>
        <aside className="version-list">
          <div className="section-eyebrow">ИСТОРИЯ ВЕРСИЙ</div>
          {versions.map((v) => (
            <button
              className={selected?.id === v.id ? "active" : ""}
              key={v.id}
              onClick={() => setVersionId(v.id)}
            >
              <div>
                <b>Версия {v.version}</b>
                {v.id === agent.activeVersionId && (
                  <span className="badge green">active</span>
                )}
              </div>
              <small>
                {v.status === "draft" ? "Черновик" : "Опубликована"} ·{" "}
                {v.author}
              </small>
              <small>
                {new Date(v.createdAt).toLocaleDateString("ru-RU")} ·{" "}
                {time(v.createdAt)}
              </small>
            </button>
          ))}
          {data.user.role === "admin" && selected && (
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  await api("/prompts/" + selected.id + "/publish", "POST");
                  await refresh();
                  notice("Версия активна в Studio. n8n sync не подключён.");
                } catch (e) {
                  notice((e as Error).message);
                }
              }}
            >
              {selected.status === "draft" ? (
                <Check size={16} />
              ) : (
                <RotateCcw size={16} />
              )}{" "}
              {selected.status === "draft"
                ? "Publish в Studio"
                : "Rollback к версии"}
            </button>
          )}
        </aside>
      </div>
      {settings && (
        <Modal title="Конфигурация агента" onClose={() => setSettings(false)}>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                await api("/agents/" + agent.id, "PATCH", {
                  model: f.get("model"),
                  workflowId: f.get("workflowId"),
                  timeoutMs: Number(f.get("timeoutMs")),
                  maxRetries: Number(f.get("maxRetries")),
                  tools: String(f.get("tools"))
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                  flags: { safePricing: f.get("safePricing") === "on" },
                });
                await refresh();
                setSettings(false);
              } catch (e) {
                notice((e as Error).message);
              }
            }}
          >
            <label>
              Model metadata
              <input name="model" defaultValue={agent.model} />
            </label>
            <label>
              n8n workflow mapping
              <input name="workflowId" defaultValue={agent.workflowId} />
            </label>
            <div className="field-grid">
              <label>
                Timeout, ms
                <input
                  name="timeoutMs"
                  type="number"
                  min={1000}
                  max={30000}
                  defaultValue={agent.timeoutMs}
                />
              </label>
              <label>
                Retries
                <input
                  name="maxRetries"
                  type="number"
                  min={0}
                  max={5}
                  defaultValue={agent.maxRetries}
                />
              </label>
            </div>
            <label>
              Разрешённые инструменты
              <textarea
                name="tools"
                defaultValue={agent.tools.join(", ")}
                rows={3}
              />
            </label>
            <label className="checkbox-label">
              <input
                name="safePricing"
                type="checkbox"
                defaultChecked={agent.flags.safePricing}
              />
              Только authoritative цены
            </label>
            <p className="form-hint">
              Настройки передаются как snapshot каждого run. В Local Preview
              используется шаблон, без LLM.
            </p>
            <footer>
              <button className="button" disabled={data.user.role !== "admin"}>
                Сохранить настройки
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
export function IntegrationsPanel({ data, refresh, notice }: Common) {
  const [state, setState] = useState<{
      connections: {
        name: string;
        status: string;
        detail: string;
        capabilities: unknown;
      }[];
      crmReady: boolean;
      sandboxReady: boolean;
      sandboxAttested: boolean;
      mappingReady: boolean;
      promptSync: string;
      mappings: unknown[];
    }>(),
    [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      setState(await api("/integrations"));
    } catch (e) {
      notice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void check();
  }, []);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ENVIRONMENT & CONNECTIONS</div>
          <h1>Интеграции</h1>
          <p>Тестовая среда с явными границами ответственности.</p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void check()}
        >
          <RotateCcw size={16} />
          {busy ? "Проверяем…" : "Проверить соединения"}
        </button>
      </div>
      <div className="architecture-flow">
        {["AI Studio", "Gateway", "n8n", "CRM / PMS"].map((s, i) => (
          <span key={s}>
            {s}
            {i < 3 && <ChevronRight size={17} />}
          </span>
        ))}
      </div>
      <div className="integration-grid">
        {(
          state?.connections ??
          ["crm", "pms", "n8n"].map((name) => ({
            name,
            status: "checking",
            detail: "Проверка конфигурации",
            capabilities: null,
          }))
        ).map((c) => (
          <article className="integration-card" key={c.name}>
            <div className="connection-icon">
              <Wifi size={22} />
            </div>
            <div className="connection-title">
              <h3>{c.name.toUpperCase()}</h3>
              <span
                className={
                  "status-dot " + (c.status === "ready" ? "online" : "")
                }
              />
            </div>
            <span className="badge neutral">{c.status}</span>
            <p>{c.detail}</p>
            <small>
              {c.name === "crm"
                ? "Customer · conversation · messages"
                : c.name === "pms"
                  ? "Inventory · reservation · folio"
                  : "Agent execution · orchestration"}
            </small>
            {c.capabilities !== null && (
              <details>
                <summary>Capabilities</summary>
                <pre>{JSON.stringify(c.capabilities, null, 2)}</pre>
              </details>
            )}
          </article>
        ))}
      </div>
      <h2 className="section-title">Режим новых разговоров</h2>
      <div className="mode-options">
        {(["preview", "crm", "sandbox"] as const).map((mode) => (
          <button
            key={mode}
            className={data.workspace.mode === mode ? "selected" : ""}
            disabled={
              data.user.role !== "admin" ||
              (mode === "crm" && !state?.crmReady) ||
              (mode === "sandbox" && !state?.sandboxReady)
            }
            onClick={async () => {
              try {
                await api("/integrations/mode", "PUT", { mode });
                await refresh();
                notice("Режим новых разговоров обновлён");
              } catch (e) {
                notice((e as Error).message);
              }
            }}
          >
            <div>
              <b>{modeLabels[mode]}</b>
              {data.workspace.mode === mode && <Check size={19} />}
            </div>
            <p>
              {mode === "preview"
                ? "Локальная PostgreSQL, тестовые данные и явно обозначенные ответы-шаблоны."
                : mode === "crm"
                  ? "Реальный CRM simulator transcript. Без n8n ответы AI не создаются."
                  : "n8n + CRM + PMS. Требуются sandbox endpoints, keys, mapping и capability discovery."}
            </p>
          </button>
        ))}
      </div>
      <div className="integration-notes">
        <ShieldCheck size={22} />
        <div>
          <h3>Sandbox only</h3>
          <p>
            Endpoints и секреты задаются на сервере через переменные окружения.
            Перед включением подключений подтвердите изолированную среду и
            разрешённые HTTPS hosts. Режим существующих чатов сохраняется.
          </p>
          <p>
            Prompt sync · Trace reader · STT/TTS · SIP/PBX: <b>не подключены</b>
          </p>
          <details>
            <summary>Property mapping</summary>
            <pre>{JSON.stringify(state?.mappings ?? [], null, 2)}</pre>
          </details>
        </div>
      </div>
    </div>
  );
}
export type NoteTarget = {
  type: Annotation["targetType"];
  id: string;
  label: string;
};
export function NotesPane({
  timeline,
  target,
  setTarget,
  refresh,
  notice,
  writable,
}: {
  timeline: Timeline;
  target: NoteTarget;
  setTarget: (v: NoteTarget) => void;
  refresh: () => Promise<void>;
  notice: (s: string) => void;
  writable: boolean;
}) {
  const [body, setBody] = useState(""),
    [severity, setSeverity] = useState("warning"),
    [filter, setFilter] = useState("all"),
    [type, setType] = useState("quality"),
    [flags, setFlags] = useState(""),
    [edit, setEdit] = useState<string>();
  const items = timeline.annotations.filter(
    (a) => filter === "all" || a.status === filter,
  );
  return (
    <div className="notes-pane">
      <div className="review-verdict">
        <div className="section-eyebrow">CONVERSATION VERDICT</div>
        <div>
          {[
            ["unreviewed", "Без оценки"],
            ["pass", "Pass"],
            ["fail", "Fail"],
          ].map(([v, label]) => (
            <button
              key={v}
              className={
                timeline.conversation.verdict === v ? "active " + v : ""
              }
              disabled={!writable}
              onClick={async () => {
                await api(
                  "/conversations/" + timeline.conversation.id,
                  "PATCH",
                  { verdict: v },
                );
                await refresh();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="note-target">
        <span>Заметка к:</span>
        <b>{target.label}</b>
        {target.type !== "conversation" && (
          <button
            className="text-button"
            onClick={() =>
              setTarget({
                type: "conversation",
                id: timeline.conversation.id,
                label: "Всему разговору",
              })
            }
          >
            Ко всему разговору
          </button>
        )}
      </div>
      {writable && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              if (edit)
                await api("/annotations/" + edit, "PATCH", {
                  body,
                  severity,
                  flags: flags
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                });
              else
                await api("/annotations", "POST", {
                  conversationId: timeline.conversation.id,
                  targetType: target.type,
                  targetId: target.id,
                  body,
                  severity,
                  type,
                  flags: flags
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                });
              setBody("");
              setEdit(undefined);
              await refresh();
            } catch (e) {
              notice((e as Error).message);
            }
          }}
        >
          <textarea
            aria-label="Комментарий тестировщика"
            placeholder="Что стоит улучшить в ответе агента?"
            rows={4}
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="field-grid">
            <select
              aria-label="Severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
            <select
              aria-label="Тип замечания"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="quality">Качество</option>
              <option value="hallucination">Галлюцинация</option>
              <option value="tool">Инструмент</option>
              <option value="identity">Идентификация</option>
            </select>
          </div>
          <input
            aria-label="Flags"
            placeholder="Flags через запятую"
            value={flags}
            onChange={(e) => setFlags(e.target.value)}
          />
          <button className="button full">
            <Plus size={15} />
            {edit ? "Сохранить изменения" : "Добавить заметку"}
          </button>
        </form>
      )}
      <div className="notes-filter">
        <b>{items.length} заметок</b>
        <select
          aria-label="Фильтр заметок"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">Все</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>
      {items.length === 0 ? (
        <p className="muted">
          Здесь появятся замечания к ответам, звонкам и действиям агента.
        </p>
      ) : (
        items.map((a) => (
          <article className={"note-card " + a.severity} key={a.id}>
            <header>
              <span className="badge neutral">{a.severity}</span>
              <span>{a.targetType}</span>
            </header>
            <p>{a.body}</p>
            <div className="chips">
              {a.flags.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </div>
            <small>
              {a.author} · {time(a.createdAt)}
            </small>
            {writable && (
              <footer>
                <button
                  onClick={() => {
                    setEdit(a.id);
                    setBody(a.body);
                    setSeverity(a.severity);
                    setFlags(a.flags.join(", "));
                  }}
                >
                  Изменить
                </button>
                <button
                  onClick={async () => {
                    await api("/annotations/" + a.id, "PATCH", {
                      status: a.status === "open" ? "resolved" : "open",
                    });
                    await refresh();
                  }}
                >
                  {a.status === "open" ? "Resolve" : "Reopen"}
                </button>
              </footer>
            )}
            {a.history.length > 0 && (
              <details>
                <summary>История изменений ({a.history.length})</summary>
                {a.history.map((h, i) => (
                  <p key={i}>
                    <small>
                      {h.author} · {time(h.at)} · {h.status}
                    </small>
                    {h.body}
                  </p>
                ))}
              </details>
            )}
          </article>
        ))
      )}
    </div>
  );
}
export function InspectorPane({
  timeline,
  onNote,
}: {
  timeline: Timeline;
  onNote: (t: NoteTarget) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const c = timeline.conversation;
  const run =
    timeline.runs.find((r) => r.id === selected) ?? timeline.runs.at(-1);
  return (
    <div className="inspector">
      <div className="section-eyebrow">READ-ONLY INSPECTOR</div>
      <dl>
        <div>
          <dt>Transport</dt>
          <dd>CRM simulator</dd>
        </div>
        <div>
          <dt>Источник</dt>
          <dd>{modeLabels[c.mode]}</dd>
        </div>
        <div>
          <dt>Conversation</dt>
          <dd className="mono">
            {c.crmConversationId ?? "Локальная · " + c.id.slice(0, 8)}
          </dd>
        </div>
        <div>
          <dt>Setup</dt>
          <dd>{c.setupStatus}</dd>
        </div>
        <div>
          <dt>Human takeover</dt>
          <dd>{c.handoff ? "Active" : "Нет"}</dd>
        </div>
      </dl>
      <h3>
        Agent runs <span>{timeline.runs.length}</span>
      </h3>
      {timeline.runs.length > 0 ? (
        <>
          <select
            aria-label="Agent run"
            value={run?.id ?? ""}
            onChange={(e) => setSelected(e.target.value)}
          >
            {timeline.runs
              .slice()
              .reverse()
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {time(r.createdAt)} · {r.status}
                </option>
              ))}
          </select>
          {run && (
            <>
              <div className="run-status">
                <span className="status-dot" />
                {run.status}
              </div>
              <dl>
                <div>
                  <dt>Correlation ID</dt>
                  <dd className="mono">{run.correlationId}</dd>
                </div>
                <div>
                  <dt>Workflow</dt>
                  <dd>{run.workflowId}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{run.model}</dd>
                </div>
                <div>
                  <dt>Prompt version</dt>
                  <dd className="mono">{run.promptVersionId}</dd>
                </div>
                <div>
                  <dt>Длительность</dt>
                  <dd>{run.durationMs} ms</dd>
                </div>
              </dl>
              {run.error && <p className="error">{run.error}</p>}
              {["failed", "completion_unknown"].includes(run.status) && (
                <button
                  className="button secondary full"
                  onClick={() => void api("/runs/" + run.id + "/retry", "POST")}
                >
                  Повторить восстановление
                </button>
              )}
              <button
                className="button secondary full"
                onClick={() =>
                  onNote({
                    type: "run",
                    id: run.id,
                    label: "Agent run " + run.id.slice(0, 8),
                  })
                }
              >
                Заметка к запуску
              </button>
              <details>
                <summary>Prompt snapshot</summary>
                <pre>{run.promptSnapshot}</pre>
              </details>
              <h3>Tool calls</h3>
              {run.tools.length === 0 ? (
                <p className="muted">
                  Подтверждённых вызовов нет. Read-only trace API не подключён.
                </p>
              ) : (
                run.tools.map((t) => (
                  <div className="tool-card" key={t.id}>
                    <b>{t.name}</b>
                    <p>{t.summary}</p>
                    <small>
                      {t.status} · {t.durationMs}ms
                    </small>
                    {t.businessReference && <code>{t.businessReference}</code>}
                    <button
                      onClick={() =>
                        onNote({ type: "tool", id: t.id, label: t.name })
                      }
                    >
                      Заметка
                    </button>
                  </div>
                ))
              )}
            </>
          )}
        </>
      ) : (
        <p className="muted">
          Отправьте сообщение, чтобы увидеть run и snapshot промпта.
        </p>
      )}
      <h3>Delivery attempts</h3>
      {timeline.attempts
        .slice()
        .reverse()
        .map((a) => (
          <div className="attempt-card" key={a.id}>
            <b>{a.status}</b>
            <small>
              #{a.sequence} · {a.tries} попыток
            </small>
            <code>{a.externalMessageId}</code>
            {a.error && <p>{a.error}</p>}
          </div>
        ))}
    </div>
  );
}
export function CallModal({
  call,
  onClose,
  refresh,
  notice,
  onNote,
}: {
  call: Call;
  onClose: () => void;
  refresh: () => Promise<void>;
  notice: (s: string) => void;
  onNote: () => void;
}) {
  const [elapsed, setElapsed] = useState(0),
    [mediaId, setMediaId] = useState("");
  useEffect(() => {
    const tick = () =>
      setElapsed(
        call.startedAt
          ? Math.max(
              0,
              Math.floor((Date.now() - Date.parse(call.startedAt)) / 1000),
            )
          : 0,
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [call.startedAt]);
  const action = async (action: string) => {
    try {
      await api("/calls/" + call.id + "/action", "POST", { action });
      await refresh();
    } catch (e) {
      notice((e as Error).message);
    }
  };
  return (
    <Modal title="Виртуальный звонок" onClose={onClose}>
      <div className="call-surface">
        <span className="call-orbit">
          <Phone size={35} />
        </span>
        <h2>LES Guest Assistant</h2>
        <p>
          {call.direction === "incoming" ? "Входящий" : "Исходящий"} ·{" "}
          {call.status === "ringing"
            ? "Ожидает ответа"
            : call.status === "active"
              ? "Сессия активна"
              : call.status === "rejected"
                ? "Отклонён"
                : "Завершён"}
        </p>
        <span className="call-duration">
          {String(
            Math.floor(
              (call.status === "active" ? elapsed : call.durationSeconds) / 60,
            ),
          ).padStart(2, "0")}
          :
          {String(
            (call.status === "active" ? elapsed : call.durationSeconds) % 60,
          ).padStart(2, "0")}
        </span>
        <span className="badge neutral">
          SIMULATION · без SIP и realtime audio
        </span>
        <div className="call-actions">
          {call.status === "ringing" && (
            <>
              <button
                className="call-action reject"
                aria-label="Отклонить"
                onClick={() => void action("reject")}
              >
                <PhoneOff size={24} />
              </button>
              <button
                className="call-action accept"
                aria-label="Принять"
                onClick={() => void action("accept")}
              >
                <PhoneIncoming size={24} />
              </button>
            </>
          )}
          {call.status === "active" && (
            <button
              className="call-action reject"
              aria-label="Завершить звонок"
              onClick={() => void action("end")}
            >
              <PhoneOff size={24} />
            </button>
          )}
        </div>
      </div>
      <div className="call-transcript">
        <h3>Транскрипт сессии</h3>
        {call.turns.map((t) => (
          <div key={t.id}>
            <b>{t.speaker === "guest" ? "Гость" : "Агент"}</b>
            <p>{t.text}</p>
            <small>
              {time(t.at)}
              {t.mediaId && " · audio attachment"}
            </small>
          </div>
        ))}
        {call.status === "active" && (
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                await api("/calls/" + call.id + "/turns", "POST", {
                  speaker: f.get("speaker"),
                  text: f.get("text"),
                  ...(mediaId ? { mediaId } : {}),
                });
                e.currentTarget.reset();
                setMediaId("");
                await refresh();
              } catch (err) {
                notice((err as Error).message);
              }
            }}
          >
            <select name="speaker" aria-label="Участник звонка">
              <option value="guest">Гость</option>
              <option value="agent">Агент</option>
            </select>
            <textarea
              name="text"
              aria-label="Реплика звонка"
              placeholder="Добавить реплику в тестовый транскрипт"
              required
              rows={2}
            />
            <label>
              Аудио к реплике
              <input
                type="file"
                accept="audio/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    try {
                      const a = await upload(file, () => {});
                      setMediaId(a.id);
                      notice("Аудио прикреплено");
                    } catch (e) {
                      notice((e as Error).message);
                    }
                  }
                }}
              />
            </label>
            <button className="button">Добавить реплику</button>
          </form>
        )}
        <button className="text-button" onClick={onNote}>
          Оставить заметку к звонку
        </button>
      </div>
    </Modal>
  );
}
