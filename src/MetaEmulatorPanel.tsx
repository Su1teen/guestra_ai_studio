import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

interface EmulatorMessage { id: string; direction: "in" | "out"; channel: "whatsapp" | "instagram"; guest: string; text: string; at: string; status?: string; senderType?: string }
interface EmulatorState { enabled: boolean; channels: { whatsapp: boolean; instagram: boolean }; thread: EmulatorMessage[] }

/**
 * «Как WhatsApp / как Instagram»: the guest writes here, Studio sends the message to the CRM as Meta would,
 * the hotel's reply (AI or staff) comes back here. The 24-hour window, templates, delivery statuses and
 * reactions behave as on the real channel.
 */
export function MetaEmulatorPanel({ writable, notice }: { writable: boolean; notice: (text: string) => void }) {
  const [state, setState] = useState<EmulatorState>();
  const [channel, setChannel] = useState<"whatsapp" | "instagram">("whatsapp");
  const [guest, setGuest] = useState("77015550001");
  const [text, setText] = useState("");
  const [late, setLate] = useState(0);
  const load = useCallback(() => { api<EmulatorState>("/meta-emulator").then(setState).catch(() => setState(undefined)); }, []);
  useEffect(() => { load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, [load]);
  const send = async (body: Record<string, unknown>) => {
    try { await api("/meta-emulator/messages", "POST", { channel, guest, ...body }); setText(""); load(); }
    catch (error) { notice(error instanceof Error ? error.message : String(error)); }
  };
  if (!state) return <section className="panel"><p>Загрузка…</p></section>;
  if (!state.enabled) return <section className="panel"><h2>Как WhatsApp / Instagram</h2>
    <p>Режим выключен на этом окружении. Он включается на тестовом окружении, когда заданы адрес вебхука CRM, общий секрет подписи,
      токен ответов и номер WhatsApp или аккаунт Instagram эмулятора (см. docs/META_EMULATOR.md).</p></section>;
  const thread = state.thread.filter((message) => message.channel === channel && message.guest === guest);
  return <section className="panel">
    <h2>Как WhatsApp / Instagram</h2>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      <select aria-label="Канал" value={channel} onChange={(event) => setChannel(event.target.value as "whatsapp" | "instagram")}>
        {state.channels.whatsapp && <option value="whatsapp">WhatsApp</option>}
        {state.channels.instagram && <option value="instagram">Instagram</option>}
      </select>
      <input aria-label="Гость" value={guest} onChange={(event) => setGuest(event.target.value.replace(/[^\w.+-]/g, ""))} placeholder={channel === "whatsapp" ? "Номер гостя" : "ID гостя Instagram"} />
      <label>Отправлено минут назад <input aria-label="Отправлено минут назад" type="number" min={0} value={late} onChange={(event) => setLate(Number(event.target.value) || 0)} style={{ width: 80 }} /></label>
    </div>
    <ol className="emulator-thread" style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
      {thread.map((message) => <li key={message.id} style={{ justifySelf: message.direction === "in" ? "start" : "end", maxWidth: "70%", padding: "8px 12px", borderRadius: 12,
        background: message.direction === "in" ? "var(--surface-2, #f1f5f9)" : "var(--accent-soft, #dcfce7)" }}>
        <div>{message.text}</div>
        <small>{new Date(message.at).toLocaleTimeString()}{message.direction === "out" && <> · {message.senderType === "ai" ? "ИИ" : "отель"} · {message.status}</>}</small>
        {message.direction === "out" && writable && <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          {channel === "whatsapp" && <button onClick={() => void send({ status: { messageId: message.id, status: "delivered" } })}>Доставлено</button>}
          {channel === "whatsapp" && <button onClick={() => void send({ status: { messageId: message.id, status: "read" } })}>Прочитано</button>}
          <button onClick={() => void send({ reaction: { messageId: message.id, emoji: "👍" } })}>👍</button>
        </div>}
      </li>)}
      {!thread.length && <li>Сообщений пока нет.</li>}
    </ol>
    {writable && <form onSubmit={(event) => { event.preventDefault(); if (text.trim()) void send({ text: text.trim(), sentMinutesAgo: late || undefined }); }} style={{ display: "flex", gap: 8 }}>
      <input aria-label="Сообщение гостя" style={{ flex: 1 }} value={text} onChange={(event) => setText(event.target.value)} placeholder="Сообщение от гостя" />
      <button type="submit" disabled={!text.trim()}>Отправить</button>
    </form>}
  </section>;
}
