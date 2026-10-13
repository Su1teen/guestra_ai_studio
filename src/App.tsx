import { useEffect, useState, useRef, useCallback } from "react";
import {
  MessagesSquare,
  Users,
  FlaskConical,
  Bot,
  Plug,
  Search,
  Plus,
  ChevronDown,
  ArrowUpRight,
  PanelRight,
  Code2,
  MessageSquare,
  Phone,
  PhoneIncoming,
  Paperclip,
  Send,
  Smile,
  X,
  ArrowLeft,
  Check,
  Clock,
  AlertCircle,
  RotateCcw,
  LogOut,
  TreePine,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import type { Bootstrap, Timeline } from "./api";
import { api, upload, modeLabels, stageLabels, time } from "./api";
import type { Attachment, Conversation, Attempt } from "../shared/domain";
import { Avatar, Modal, Empty, MessageBubble } from "./components";
import {
  ClientsPanel,
  ClientForm,
  ConversationForm,
  ScenarioPanel,
  AgentPanel,
  IntegrationsPanel,
  NotesPane,
  InspectorPane,
  CallModal,
  type NoteTarget,
} from "./panels";
type Page = "chats" | "clients" | "scenarios" | "agents" | "integrations";
type UploadItem = {
  id: string;
  conversationId: string;
  file: File;
  progress: number;
  asset?: Attachment;
  error?: string;
};
function mergeTimeline(
  old: Timeline | undefined,
  value: Timeline,
  older = false,
): Timeline {
  if (!old || old.conversation.id !== value.conversation.id) return value;
  const removed = new Set(value.removedMessageIds ?? []),
    messages = new Map(
      old.messages.filter((m) => !removed.has(m.id)).map((m) => [m.id, m]),
    );
  for (const message of value.messages) messages.set(message.id, message);
  const ordered = [...messages.values()].sort((a, b) =>
    value.conversation.mode === "preview"
      ? (a.sequence ?? 0) - (b.sequence ?? 0)
      : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return {
    ...value,
    messages: ordered,
    olderCursor: ordered[0]?.id,
    hasOlder: older
      ? value.hasOlder
      : old.messages.length > value.messages.length
        ? old.hasOlder
        : value.hasOlder,
  };
}
export default function App() {
  const [data, setData] = useState<Bootstrap>(),
    [auth, setAuth] = useState<boolean | undefined>(),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState<Page>("chats"),
    [timeline, setTimeline] = useState<Timeline>(),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [newClient, setNewClient] = useState(false),
    [newChat, setNewChat] = useState(false),
    [pane, setPane] = useState<"notes" | "inspector" | null>(null),
    [target, setTarget] = useState<NoteTarget>(),
    [draft, setDraft] = useState(""),
    [replyId, setReplyId] = useState<string>(),
    [uploads, setUploads] = useState<UploadItem[]>([]),
    [lightbox, setLightbox] = useState(""),
    [callId, setCallId] = useState(""),
    [sending, setSending] = useState(false),
    [optimistic, setOptimistic] = useState<Attempt[]>([]),
    [showEmoji, setShowEmoji] = useState(false),
    [mobileChat, setMobileChat] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const drafts = useRef(new Map<string, string>()),
    draftRef = useRef(""),
    searchRef = useRef<HTMLInputElement>(null),
    fileRef = useRef<HTMLInputElement>(null),
    composerRef = useRef<HTMLTextAreaElement>(null),
    scrollRef = useRef<HTMLDivElement>(null),
    lastScrollKey = useRef(""),
    nearBottom = useRef(true),
    toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const notice = useCallback((s: string) => {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const d = await api<Bootstrap>("/bootstrap");
      setData(d);
      setAuth(true);
      const remembered = sessionStorage.getItem(
        "studio:selected:" + d.workspace.id,
      );
      setSelected((s) =>
        d.conversations.some((c) => c.id === s)
          ? s
          : d.conversations.some((c) => c.id === remembered)
            ? remembered!
            : d.conversations[0]?.id || "",
      );
      setError("");
    } catch (e) {
      setAuth(false);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => clearTimeout(toastTimer.current);
  }, [refresh]);
  useEffect(() => {
    if (!auth) return;
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [auth, refresh]);
  const refreshTimeline = useCallback(async () => {
    if (!selected) return;
    try {
      const value = await api<Timeline>(
        "/conversations/" + selected + "/timeline",
      );
      if (selectedRef.current === selected)
        setTimeline((old) => mergeTimeline(old, value));
    } catch (e) {
      notice((e as Error).message);
    }
  }, [selected, notice]);
  useEffect(() => {
    if (!selected || !auth) return;
    let cancelled = false;
    setTimeline(undefined);
    lastScrollKey.current = "";
    const get = async () => {
      try {
        const value = await api<Timeline>(
          "/conversations/" + selected + "/timeline",
        );
        if (!cancelled) setTimeline((old) => mergeTimeline(old, value));
      } catch (e) {
        if (!cancelled) notice((e as Error).message);
      }
    };
    void get();
    const timer = setInterval(() => void get(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected, auth, notice]);
  useEffect(() => {
    const c = data?.conversations.find((c) => c.id === selected);
    const text = drafts.current.get(selected) ?? c?.draft ?? "";
    setDraft(text);
    draftRef.current = text;
    setReplyId(undefined);
    setTarget({ type: "conversation", id: selected, label: "Всему разговору" });
    if (selected && data)
      sessionStorage.setItem("studio:selected:" + data.workspace.id, selected);
  }, [selected]);
  useEffect(() => {
    draftRef.current = draft;
    drafts.current.set(selected, draft);
    if (
      !selected ||
      !auth ||
      !data ||
      !["admin", "tester"].includes(data.user.role)
    )
      return;
    const timer = setTimeout(() => {
      void api("/conversations/" + selected, "PATCH", { draft }).catch((e) =>
        notice((e as Error).message),
      );
    }, 550);
    return () => clearTimeout(timer);
  }, [draft, selected, auth]);
  useEffect(() => {
    const key =
      selected +
      ":" +
      (timeline?.messages.at(-1)?.id ?? "") +
      ":" +
      (timeline?.attempts.at(-1)?.status ?? "");
    if (lastScrollKey.current !== key) {
      if (nearBottom.current || !lastScrollKey.current) {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: lastScrollKey.current ? "smooth" : "instant",
        });
      }
      lastScrollKey.current = key;
    }
  }, [timeline, selected, optimistic]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setPage("chats");
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        setLightbox("");
        setNewChat(false);
        setNewClient(false);
        setShowEmoji(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const selectConversation = async (id: string) => {
    if (data && ["admin", "tester"].includes(data.user.role) && selected)
      try {
        await api("/conversations/" + selected, "PATCH", {
          draft: draftRef.current,
        });
      } catch (e) {
        notice((e as Error).message);
      }
    setSelected(id);
    setPage("chats");
    setMobileChat(true);
    nearBottom.current = true;
  };
  const send = async (existing?: Attempt) => {
    if (!selected || sending) return;
    const current = uploads.filter((u) => u.conversationId === selected),
      assets = current.filter((u) => u.asset).map((u) => u.asset!);
    if (
      !existing &&
      ((!draft.trim() && !assets.length) || current.some((u) => !u.asset))
    )
      return;
    setSending(true);
    const attempt = existing ?? {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      conversationId: selected,
      correlationId: "pending",
      externalMessageId: crypto.randomUUID(),
      text: draft.trim(),
      attachments: assets,
      replyTo: replyId,
      status: "queued" as const,
      tries: 0,
      nextAt: new Date().toISOString(),
      sequence: 0,
      payloadHash: "",
      runId: "",
    };
    setOptimistic((v) => [
      ...v.filter((a) => a.externalMessageId !== attempt.externalMessageId),
      attempt,
    ]);
    try {
      await api(
        "/conversations/" + attempt.conversationId + "/messages",
        "POST",
        {
          externalMessageId: attempt.externalMessageId,
          text: attempt.text,
          attachmentIds: attempt.attachments.map((a) => a.id),
          ...(attempt.replyTo ? { replyTo: attempt.replyTo } : {}),
        },
      );
      if (!existing) {
        drafts.current.set(attempt.conversationId, "");
        if (selectedRef.current === attempt.conversationId) {
          setDraft("");
          setReplyId(undefined);
        }
        setUploads((v) =>
          v.filter((u) => u.conversationId !== attempt.conversationId),
        );
      }
      await refreshTimeline();
      setOptimistic((v) =>
        v.filter((a) => a.externalMessageId !== attempt.externalMessageId),
      );
      nearBottom.current = true;
      void refresh();
    } catch (e) {
      setOptimistic((v) =>
        v.map((a) =>
          a.externalMessageId === attempt.externalMessageId
            ? { ...a, status: "failed", error: (e as Error).message }
            : a,
        ),
      );
      notice((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const startUpload = async (item: UploadItem) => {
    setUploads((v) => [
      ...v.filter((u) => u.id !== item.id),
      { ...item, error: undefined, progress: 0 },
    ]);
    try {
      const asset = await upload(item.file, (p) =>
        setUploads((v) =>
          v.map((u) => (u.id === item.id ? { ...u, progress: p } : u)),
        ),
      );
      setUploads((v) =>
        v.map((u) => (u.id === item.id ? { ...u, progress: 100, asset } : u)),
      );
    } catch (e) {
      setUploads((v) =>
        v.map((u) =>
          u.id === item.id ? { ...u, error: (e as Error).message } : u,
        ),
      );
    }
  };
  if (loading)
    return (
      <div className="loading-screen">
        <div className="brand-mark">g</div>
        <Loader2 className="spin" />
        <p>Открываем Guestra AI Studio…</p>
      </div>
    );
  if (!auth || !data) return <Login onLogin={refresh} error={error} />;
  const conv =
      timeline?.conversation ??
      data.conversations.find((c) => c.id === selected),
    client = data.clients.find((c) => c.id === conv?.clientId),
    writable = ["admin", "tester"].includes(data.user.role),
    reviewer = ["admin", "tester", "reviewer"].includes(data.user.role);
  const conversations = data.conversations
    .filter((c) => {
      const guest = data.clients.find((x) => x.id === c.clientId);
      const matches = (guest?.displayName + " " + c.title + " " + c.lastText)
        .toLowerCase()
        .includes(query.toLowerCase());
      return (
        matches &&
        (filter === "all" ||
          (filter === "notes" &&
            data.annotations.some((a) => a.conversationId === c.id)) ||
          guest?.channel === filter)
      );
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pending = [
    ...(timeline?.attempts ?? []).filter(
      (a) =>
        !timeline?.messages.some(
          (m) => m.externalMessageId === a.externalMessageId,
        ),
    ),
    ...optimistic.filter(
      (a) =>
        a.conversationId === selected &&
        !(timeline?.attempts ?? []).some(
          (b) => a.externalMessageId === b.externalMessageId,
        ),
    ),
  ];
  const processing = timeline?.runs.some((r) =>
    [
      "queued",
      "processing",
      "retrying",
      "awaiting_crm",
      "dispatch_accepted",
      "inbound_saved",
      "agent_processing",
      "tool_execution",
      "business_pending",
      "business_completed",
      "reply_prepared",
      "reply_delivered",
    ].includes(r.status),
  );
  const activeUploads = uploads.filter((u) => u.conversationId === selected),
    reply = timeline?.messages.find((m) => m.id === replyId),
    call =
      timeline?.calls.find((c) => c.id === callId) ??
      data.calls.find((c) => c.id === callId);
  const openNote = (t: NoteTarget) => {
    setTarget(t);
    setPane("notes");
  };
  const nav = [
    { id: "chats" as const, label: "Чаты", icon: MessagesSquare },
    { id: "clients" as const, label: "Клиенты", icon: Users },
    { id: "scenarios" as const, label: "Сценарии", icon: FlaskConical },
    { id: "agents" as const, label: "Агенты", icon: Bot },
    { id: "integrations" as const, label: "Связи", icon: Plug },
  ];
  return (
    <div className="app-shell">
      <aside className="rail">
        <button
          className="brand-mark"
          aria-label="Guestra AI Studio"
          onClick={() => setPage("chats")}
        >
          g<span />
        </button>
        <div className="rail-nav">
          {nav.map((n) => (
            <button
              className={page === n.id ? "active" : ""}
              key={n.id}
              onClick={() => {
                setPage(n.id);
                setMobileChat(false);
              }}
              title={n.label}
            >
              <n.icon size={22} />
              <span>{n.label}</span>
            </button>
          ))}
        </div>
        <div className="rail-bottom">
          <span className="env-symbol" title="Изолированная тестовая среда">
            <ShieldCheck size={20} />
          </span>
          <button
            className="user-dot"
            title={data.user.name + " · " + data.user.role}
            onClick={async () => {
              await api("/auth/logout", "POST");
              setAuth(false);
              setData(undefined);
            }}
          >
            ST
          </button>
        </div>
      </aside>
      <main className="main-shell">
        <header className="global-header">
          <div className="product-title">
            Guestra <span>AI Studio</span>
            <i>LAB</i>
          </div>
          <div className="workspace-label">
            <TreePine size={18} />
            <span>LES Боровое</span>
            <span className="test-tag">TEST ENV</span>
          </div>
          <button
            className="environment-button"
            onClick={() => setPage("integrations")}
          >
            <span
              className={
                "status-dot " +
                (data.workspace.mode === "preview" ? "preview" : "online")
              }
            />
            {modeLabels[data.workspace.mode]}
            <ChevronDown size={14} />
          </button>
        </header>
        {page === "chats" ? (
          <div
            className={
              "messenger " +
              (mobileChat ? "mobile-chat" : "") +
              (pane ? " with-pane" : "")
            }
          >
            <aside className="conversation-list">
              <header>
                <div>
                  <h1>Разговоры</h1>
                  <span>{data.conversations.length}</span>
                </div>
                {writable && (
                  <button
                    className="new-chat-button"
                    aria-label="Новый разговор"
                    onClick={() =>
                      data.clients.length
                        ? setNewChat(true)
                        : setNewClient(true)
                    }
                  >
                    <Plus size={19} />
                  </button>
                )}
              </header>
              <div className="search-field">
                <Search size={17} />
                <input
                  ref={searchRef}
                  aria-label="Поиск разговоров"
                  placeholder="Найти клиента или разговор"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>⌘ K</kbd>
              </div>
              <div className="conversation-filters">
                {[
                  ["all", "Все"],
                  ["whatsapp", "WhatsApp"],
                  ["telegram", "Telegram"],
                  ["notes", "Заметки"],
                ].map(([v, label]) => (
                  <button
                    key={v}
                    className={filter === v ? "active" : ""}
                    onClick={() => setFilter(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="conversation-scroll">
                {conversations.length === 0 ? (
                  <Empty
                    title="Разговоров нет"
                    body={
                      query
                        ? "Попробуйте другой запрос"
                        : "Создайте первый тестовый чат"
                    }
                  />
                ) : (
                  conversations.map((c, i) => {
                    const guest = data.clients.find((v) => v.id === c.clientId);
                    return (
                      <button
                        className={
                          "conversation-item " +
                          (selected === c.id ? "selected" : "")
                        }
                        key={c.id}
                        onClick={() => void selectConversation(c.id)}
                      >
                        <div className="conversation-avatar">
                          <Avatar
                            name={guest?.displayName ?? "Гость"}
                            index={i}
                          />
                          <span className={"channel-dot " + guest?.channel}>
                            {guest?.channel === "telegram"
                              ? "➤"
                              : guest?.channel === "instagram"
                                ? "◎"
                                : "◉"}
                          </span>
                        </div>
                        <div className="conversation-summary">
                          <div>
                            <b>{guest?.displayName ?? "Гость"}</b>
                            <small>{time(c.updatedAt)}</small>
                          </div>
                          <span className="conversation-title">{c.title}</span>
                          <p>{c.lastText}</p>
                          <div className="conversation-item-tags">
                            <span>{guest?.channel}</span>
                            {c.mode === "preview" && <span>preview</span>}
                            {data.annotations.some(
                              (a) => a.conversationId === c.id,
                            ) && <MessageSquare size={11} />}
                          </div>
                        </div>
                        {c.unread > 0 && (
                          <span className="unread">{c.unread}</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
              <footer className="conversation-list-footer">
                <span>
                  <span className="status-dot preview" /> {data.clients.length}{" "}
                  виртуальных клиентов
                </span>
                {writable && (
                  <button
                    className="icon-button"
                    aria-label="Добавить клиента"
                    onClick={() => setNewClient(true)}
                  >
                    <Users size={17} />
                    <Plus size={12} />
                  </button>
                )}
              </footer>
            </aside>
            <section className="chat-main">
              {!conv ? (
                <Empty
                  title="Начните новый разговор"
                  body="Создайте виртуального гостя и протестируйте его общение с агентом гостиницы."
                />
              ) : (
                <>
                  <header className="chat-header">
                    <button
                      className="icon-button back-button"
                      aria-label="Назад к разговорам"
                      onClick={() => setMobileChat(false)}
                    >
                      <ArrowLeft size={20} />
                    </button>
                    <Avatar name={client?.displayName ?? "Гость"} small />
                    <div className="chat-person">
                      <h2>{client?.displayName}</h2>
                      <p>
                        <span className={"channel " + client?.channel}>
                          {client?.channel}
                        </span>
                        <span>{conv.title}</span>
                      </p>
                    </div>
                    <div className="chat-tools">
                      <button
                        className="icon-button"
                        disabled={!writable}
                        aria-label="Входящий виртуальный звонок"
                        title="Симулировать входящий звонок"
                        onClick={async () => {
                          try {
                            const c = await api<{ id: string }>(
                              "/calls",
                              "POST",
                              {
                                conversationId: conv.id,
                                direction: "incoming",
                              },
                            );
                            setCallId(c.id);
                            await refreshTimeline();
                          } catch (e) {
                            notice((e as Error).message);
                          }
                        }}
                      >
                        <PhoneIncoming size={18} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={!writable}
                        aria-label="Исходящий виртуальный звонок"
                        title="Виртуальный звонок"
                        onClick={async () => {
                          try {
                            const c = await api<{ id: string }>(
                              "/calls",
                              "POST",
                              {
                                conversationId: conv.id,
                                direction: "outgoing",
                                ...(timeline?.runs.at(-1)
                                  ? { runId: timeline.runs.at(-1)!.id }
                                  : {}),
                              },
                            );
                            setCallId(c.id);
                            await refreshTimeline();
                          } catch (e) {
                            notice((e as Error).message);
                          }
                        }}
                      >
                        <Phone size={19} />
                      </button>
                      <button
                        className={
                          "icon-button " + (pane === "notes" ? "active" : "")
                        }
                        aria-label="Заметки и оценка"
                        title="Заметки и оценка"
                        onClick={() =>
                          setPane(pane === "notes" ? null : "notes")
                        }
                      >
                        <MessageSquare size={19} />
                        {(timeline?.annotations.length ?? 0) > 0 && (
                          <span className="tiny-count">
                            {timeline?.annotations.length}
                          </span>
                        )}
                      </button>
                      <button
                        className={
                          "icon-button " +
                          (pane === "inspector" ? "active" : "")
                        }
                        aria-label="Developer Inspector"
                        title="Developer Inspector"
                        onClick={() =>
                          setPane(pane === "inspector" ? null : "inspector")
                        }
                      >
                        <Code2 size={20} />
                      </button>
                    </div>
                  </header>
                  <div className="chat-context">
                    <span>{stageLabels[conv.stage]}</span>
                    <span className="context-divider" />
                    <span>{client?.property}</span>
                    <span className="context-mode">
                      {modeLabels[conv.mode]}
                    </span>
                  </div>
                  {conv.mode === "preview" && (
                    <div className="preview-notice">
                      <FlaskConical size={15} />
                      <span>
                        Локальная симуляция. Ответы — примеры; брони и платежи
                        не создаются.
                      </span>
                    </div>
                  )}
                  {conv.setupStatus === "SETUP_UNAVAILABLE" && (
                    <div className="error-banner">
                      SETUP_UNAVAILABLE · Сначала подготовьте допустимое
                      тестовое состояние в CRM/PMS.
                    </div>
                  )}
                  {timeline?.connectionError && (
                    <div className="error-banner">
                      CRM недоступна. Показан сохранённый снимок.{" "}
                      <button onClick={() => void refreshTimeline()}>
                        Повторить
                      </button>
                    </div>
                  )}
                  <div
                    className="message-scroll"
                    ref={scrollRef}
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      nearBottom.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                    }}
                  >
                    {!timeline ? (
                      <div className="timeline-loading">
                        <Loader2 className="spin" size={22} />
                        Загружаем историю…
                      </div>
                    ) : (
                      <>
                        {timeline.hasOlder && (
                          <button
                            className="button secondary"
                            onClick={async () => {
                              try {
                                const value = await api<Timeline>(
                                  "/conversations/" +
                                    selected +
                                    "/timeline?before=" +
                                    encodeURIComponent(
                                      timeline.olderCursor ?? "",
                                    ),
                                );
                                if (selectedRef.current === selected)
                                  setTimeline((old) =>
                                    mergeTimeline(old, value, true),
                                  );
                              } catch (e) {
                                notice((e as Error).message);
                              }
                            }}
                          >
                            Загрузить предыдущие сообщения
                          </button>
                        )}
                        <div className="chat-day">
                          {new Date(
                            timeline.messages[0]?.createdAt ?? conv.createdAt,
                          ).toLocaleDateString("ru-RU", {
                            day: "numeric",
                            month: "long",
                          })}
                          <span>Тестовый разговор</span>
                        </div>
                        {timeline.messages.length === 0 &&
                          pending.length === 0 && (
                            <Empty
                              title="История начинается здесь"
                              body="Напишите от лица гостя. Контекст этого разговора сохранится после перезапуска."
                            />
                          )}
                        {timeline.messages.map((m, i) => {
                          const date = new Date(m.createdAt).toDateString(),
                            prev = timeline.messages[i - 1];
                          return (
                            <div key={m.id}>
                              {prev &&
                                new Date(prev.createdAt).toDateString() !==
                                  date && (
                                  <div className="chat-day">
                                    {new Date(m.createdAt).toLocaleDateString(
                                      "ru-RU",
                                    )}
                                  </div>
                                )}
                              <MessageBubble
                                message={m}
                                reply={timeline.messages.find(
                                  (x) => x.id === m.replyTo,
                                )}
                                notes={
                                  timeline.annotations.filter(
                                    (a) =>
                                      a.targetId === m.id ||
                                      a.externalReference === m.id,
                                  ).length
                                }
                                onReply={() => {
                                  setReplyId(m.id);
                                  composerRef.current?.focus();
                                }}
                                onNote={() =>
                                  openNote({
                                    type: "message",
                                    id: m.id,
                                    label: "Сообщению · " + time(m.createdAt),
                                  })
                                }
                                onImage={setLightbox}
                              />
                            </div>
                          );
                        })}
                        {pending.map((a) => (
                          <div
                            className="message-row guest"
                            key={a.externalMessageId}
                          >
                            <div
                              className={
                                "bubble pending-bubble " +
                                (a.status === "failed" ? "failed" : "")
                              }
                            >
                              <p>{a.text || "Вложение"}</p>
                              {a.attachments.map((x) => (
                                <span className="pending-file" key={x.id}>
                                  <Paperclip size={13} />
                                  {x.fileName}
                                </span>
                              ))}
                              <div className="pending-status">
                                {a.status === "failed" ? (
                                  <AlertCircle size={13} />
                                ) : (
                                  <Clock size={13} />
                                )}
                                <span>
                                  {a.status === "failed"
                                    ? "Не отправлено"
                                    : a.status === "awaiting_crm"
                                      ? "Ожидаем подтверждение CRM"
                                      : "Отправляется…"}
                                </span>
                                {a.status === "failed" && (
                                  <button
                                    onClick={() => {
                                      if (
                                        optimistic.some(
                                          (o) =>
                                            o.externalMessageId ===
                                            a.externalMessageId,
                                        )
                                      )
                                        void send(a);
                                      else
                                        void api(
                                          "/attempts/" + a.id + "/retry",
                                          "POST",
                                        )
                                          .then(refreshTimeline)
                                          .catch((e) =>
                                            notice((e as Error).message),
                                          );
                                    }}
                                  >
                                    <RotateCcw size={12} />
                                    Повторить
                                  </button>
                                )}
                              </div>
                              {a.error && <small>{a.error}</small>}
                            </div>
                          </div>
                        ))}
                        {processing && (
                          <div className="processing-state">
                            <Loader2 size={14} className="spin" />
                            Сообщение обрабатывается
                          </div>
                        )}
                        {timeline.calls.map((c) => (
                          <button
                            className="call-log"
                            key={c.id}
                            onClick={() => setCallId(c.id)}
                          >
                            <Phone size={15} />
                            <span>
                              Виртуальный{" "}
                              {c.direction === "incoming"
                                ? "входящий"
                                : "исходящий"}{" "}
                              звонок
                            </span>
                            <small>
                              {c.status} · {c.durationSeconds}с
                            </small>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="composer-area">
                    {reply && (
                      <div className="composer-reply">
                        <span>
                          Ответ на сообщение<b>{reply.text.slice(0, 110)}</b>
                        </span>
                        <button
                          className="icon-button"
                          aria-label="Отменить ответ"
                          onClick={() => setReplyId(undefined)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    )}
                    {activeUploads.length > 0 && (
                      <div className="upload-list">
                        {activeUploads.map((u) => (
                          <div
                            className={
                              "upload-item " + (u.error ? "error" : "")
                            }
                            key={u.id}
                          >
                            <Paperclip size={15} />
                            <div>
                              <b>{u.file.name}</b>
                              <small>
                                {u.error ??
                                  (u.asset ? "Готово" : u.progress + "%")}
                              </small>
                            </div>
                            {u.error && (
                              <button
                                className="icon-button"
                                aria-label="Повторить загрузку"
                                onClick={() => void startUpload(u)}
                              >
                                <RotateCcw size={14} />
                              </button>
                            )}
                            <button
                              className="icon-button"
                              aria-label="Убрать вложение"
                              onClick={() =>
                                setUploads((v) =>
                                  v.filter((x) => x.id !== u.id),
                                )
                              }
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {showEmoji && (
                      <div className="emoji-picker">
                        {["😊", "🌲", "🙌", "👍", "❤️", "☀️", "🙏", "✨"].map(
                          (e) => (
                            <button
                              key={e}
                              onClick={() => {
                                setDraft((v) => v + e);
                                setShowEmoji(false);
                                composerRef.current?.focus();
                              }}
                            >
                              {e}
                            </button>
                          ),
                        )}
                      </div>
                    )}
                    <div className="composer">
                      <button
                        className="icon-button"
                        aria-label="Прикрепить файл"
                        disabled={!writable}
                        onClick={() => fileRef.current?.click()}
                      >
                        <Paperclip size={21} />
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        hidden
                        multiple
                        accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,audio/mpeg,audio/wav,audio/ogg,audio/webm,video/mp4,video/webm,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        onChange={(e) => {
                          for (const file of Array.from(
                            e.target.files ?? [],
                          ).slice(0, Math.max(0, 5 - activeUploads.length)))
                            void startUpload({
                              id: crypto.randomUUID(),
                              file,
                              conversationId: selected,
                              progress: 0,
                            });
                          e.target.value = "";
                        }}
                      />
                      <textarea
                        ref={composerRef}
                        aria-label="Сообщение гостя"
                        placeholder={
                          writable
                            ? "Написать сообщение от лица гостя…"
                            : "Режим просмотра"
                        }
                        value={draft}
                        disabled={
                          !writable || conv.setupStatus === "SETUP_UNAVAILABLE"
                        }
                        onChange={(e) => setDraft(e.target.value)}
                        rows={1}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                      />
                      <button
                        className="icon-button emoji-toggle"
                        disabled={!writable}
                        aria-label="Выбрать эмодзи"
                        onClick={() => setShowEmoji(!showEmoji)}
                      >
                        <Smile size={20} />
                      </button>
                      <button
                        className="send-button"
                        aria-label="Отправить сообщение"
                        disabled={
                          sending ||
                          !writable ||
                          conv.setupStatus === "SETUP_UNAVAILABLE" ||
                          (!draft.trim() &&
                            !activeUploads.some((u) => u.asset)) ||
                          activeUploads.some((u) => !u.asset)
                        }
                        onClick={() => void send()}
                      >
                        {sending ? (
                          <Loader2 size={19} className="spin" />
                        ) : (
                          <Send size={19} />
                        )}
                      </button>
                    </div>
                    <div className="composer-footer">
                      <span>
                        Вы пишете от лица <b>{client?.firstName}</b>
                      </span>
                      <span>
                        Enter — отправить · Shift + Enter — новая строка
                      </span>
                    </div>
                  </div>
                </>
              )}
            </section>
            {pane && timeline && (
              <aside className="review-pane">
                <header>
                  <h2>
                    {pane === "notes"
                      ? "Заметки и оценка"
                      : "Developer Inspector"}
                  </h2>
                  <button
                    className="icon-button"
                    aria-label="Закрыть панель"
                    onClick={() => setPane(null)}
                  >
                    <X size={18} />
                  </button>
                </header>
                <div className="pane-tabs">
                  <button
                    className={pane === "notes" ? "active" : ""}
                    onClick={() => setPane("notes")}
                  >
                    Review
                  </button>
                  <button
                    className={pane === "inspector" ? "active" : ""}
                    onClick={() => setPane("inspector")}
                  >
                    Inspector
                  </button>
                </div>
                <div className="pane-scroll">
                  {pane === "notes" ? (
                    <NotesPane
                      key={selected}
                      timeline={timeline}
                      target={
                        target ?? {
                          type: "conversation",
                          id: selected,
                          label: "Всему разговору",
                        }
                      }
                      setTarget={setTarget}
                      refresh={refreshTimeline}
                      notice={notice}
                      writable={reviewer}
                    />
                  ) : (
                    <InspectorPane timeline={timeline} onNote={openNote} />
                  )}
                </div>
              </aside>
            )}
          </div>
        ) : page === "clients" ? (
          <ClientsPanel
            data={data}
            refresh={refresh}
            notice={notice}
            onChat={() => setNewChat(true)}
          />
        ) : page === "scenarios" ? (
          <ScenarioPanel
            data={data}
            refresh={refresh}
            notice={notice}
            onStart={(id) => void selectConversation(id)}
          />
        ) : page === "agents" ? (
          <AgentPanel data={data} refresh={refresh} notice={notice} />
        ) : (
          <IntegrationsPanel data={data} refresh={refresh} notice={notice} />
        )}
      </main>
      {newClient && (
        <ClientForm
          onClose={() => setNewClient(false)}
          onDone={async () => {
            setNewClient(false);
            await refresh();
            notice("Виртуальный клиент создан");
          }}
        />
      )}
      {newChat && (
        <ConversationForm
          data={data}
          onClose={() => setNewChat(false)}
          onDone={async (c) => {
            setNewChat(false);
            await refresh();
            void selectConversation(c.id);
          }}
        />
      )}
      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-label="Просмотр изображения"
          aria-modal="true"
          onClick={() => setLightbox("")}
        >
          <button className="icon-button" aria-label="Закрыть изображение">
            <X size={26} />
          </button>
          <img src={lightbox} alt="Вложение в разговоре" />
        </div>
      )}
      {call && (
        <CallModal
          call={call}
          onClose={() => setCallId("")}
          refresh={async () => {
            await refreshTimeline();
            await refresh();
          }}
          notice={notice}
          onNote={() => {
            setCallId("");
            openNote({
              type: "call",
              id: call.id,
              label: "Виртуальному звонку",
            });
          }}
        />
      )}
      {toast && (
        <div role="status" className="toast">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Login({
  onLogin,
  error,
}: {
  onLogin: () => Promise<void>;
  error: string;
}) {
  const [local, setLocal] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const options = await api<{ localPreview: boolean }>("/auth/options");
        if (!stopped) {
          setLocal(options.localPreview);
          setMessage("");
        }
      } catch {
        if (!stopped) {
          setMessage("Ожидаем подключения к студии…");
          timer = setTimeout(() => void connect(), 2000);
        }
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="login-screen">
      <div className="login-brand">
        <div className="brand-mark">g</div>
        <span>Guestra AI Studio</span>
      </div>
      <div className="login-card">
        <div className="eyebrow">GUEST SIMULATION & AI TESTING</div>
        <h1>
          Каждый разговор.
          <br />
          Каждый шаг гостя.
        </h1>
        <p>Рабочее пространство для тестирования гостевых AI-агентов.</p>
        {local ? (
          <>
            <div className="form-hint">
              <FlaskConical size={20} />
              Local Preview · изолированные учебные данные
            </div>
            <button
              className="button full"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/auth/local", "POST");
                  await onLogin();
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Открываем…" : "Открыть локальную студию"}
              <ArrowUpRight size={18} />
            </button>
          </>
        ) : (
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const f = new FormData(e.currentTarget);
              try {
                await api("/auth/login", "POST", Object.fromEntries(f));
                await onLogin();
              } catch (err) {
                setMessage((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Email
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
              />
            </label>
            <label>
              Пароль
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </label>
            <button className="button full" disabled={busy}>
              Войти
            </button>
          </form>
        )}
        {message && <p className="error">{message}</p>}
      </div>
      <small className="login-foot">
        Virtual guests. Real conversations. Better hospitality.
      </small>
    </div>
  );
}
