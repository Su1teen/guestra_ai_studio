import {
  X,
  FileText,
  Download,
  Image as ImageIcon,
  MessageSquare,
  MoreHorizontal,
  Copy,
  CornerUpLeft,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  RotateCcw,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import type { Attachment, Message } from "../shared/domain";
import { time } from "./api";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current
      ?.querySelector<HTMLElement>("input,textarea,select,button")
      ?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={"modal " + (wide ? "wide" : "")}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            const items = Array.from(
              ref.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]",
              ) ?? [],
            );
            const first = items[0],
              last = items.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Закрыть"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Avatar({
  name,
  index = 0,
  small = false,
}: {
  name: string;
  index?: number;
  small?: boolean;
}) {
  return (
    <div className={"avatar color-" + (index % 5) + (small ? " small" : "")}>
      {name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((n) => n[0])
        .join("")}
    </div>
  );
}
export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <MessageSquare size={30} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
export function SafeText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!/^https?:\/\//.test(p)) return <span key={i}>{p}</span>;
        try {
          const url = new URL(p);
          return (
            <a
              key={i}
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {p}
            </a>
          );
        } catch {
          return <span key={i}>{p}</span>;
        }
      })}
    </>
  );
}
export function MediaView({
  asset,
  onImage,
}: {
  asset: Attachment;
  onImage: (url: string) => void;
}) {
  if (!asset.url)
    return (
      <div className="file-card">
        <FileText size={22} />
        <div>
          <b>{asset.fileName}</b>
          <small>
            {asset.processingStatus === "processing"
              ? "Файл обрабатывается"
              : asset.processingStatus === "failed"
                ? "Не удалось подготовить файл"
                : "Файл пока недоступен"}
          </small>
        </div>
      </div>
    );
  if (asset.kind === "image")
    return (
      <button
        className="media-image"
        onClick={() => onImage(asset.url!)}
        aria-label={"Открыть " + asset.fileName}
      >
        <img src={asset.url} alt={asset.fileName} loading="lazy" />
      </button>
    );
  if (asset.kind === "audio")
    return (
      <div className="audio-message">
        <audio controls preload="metadata" src={asset.url} />
        <small>{asset.fileName}</small>
      </div>
    );
  if (asset.kind === "video")
    return (
      <video
        controls
        preload="metadata"
        src={asset.url}
        className="media-video"
      />
    );
  return (
    <a className="file-card" href={asset.url} download={asset.fileName}>
      <FileText size={25} />
      <div>
        <b>{asset.fileName}</b>
        <small>{(asset.size / 1024).toFixed(0)} КБ</small>
      </div>
      <Download size={17} />
    </a>
  );
}
export function MessageBubble({
  message,
  reply,
  notes,
  onReply,
  onNote,
  onImage,
}: {
  message: Message;
  reply?: Message;
  notes: number;
  onReply: () => void;
  onNote: () => void;
  onImage: (url: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const guest = message.direction === "inbound";
  return (
    <div
      className={"message-row " + (guest ? "guest" : "agent")}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      <div className="bubble-wrap">
        <div className={"bubble " + (guest ? "guest-bubble" : "agent-bubble")}>
          {!guest && (
            <div className="bubble-author">
              {message.senderType === "human" ? "Сотрудник" : "LES Assistant"}
              {message.source === "preview" && <span>preview</span>}
            </div>
          )}
          {reply && (
            <div className="reply-reference">
              {reply.senderType === "guest" ? "Вы" : "LES Assistant"}
              <span>{reply.text.slice(0, 100)}</span>
            </div>
          )}
          {message.attachments.map((a) => (
            <MediaView key={a.id} asset={a} onImage={onImage} />
          ))}
          {message.text && (
            <p>
              <SafeText text={message.text} />
            </p>
          )}
          <div className="message-meta">
            <span>{time(message.createdAt)}</span>
            {guest &&
              (message.source === "preview" ? (
                <Check size={13} aria-label="Сохранено локально" />
              ) : message.deliveryStatus === "failed" ? (
                <AlertCircle size={13} />
              ) : ["sent", "delivered", "read", "received"].includes(
                  message.deliveryStatus,
                ) ? (
                <CheckCheck size={14} aria-label="CRM подтверждено" />
              ) : (
                <Clock size={13} />
              ))}
          </div>
        </div>
        <div className="message-actions">
          <button
            className="icon-button"
            aria-label="Действия сообщения"
            onClick={() => setMenu(!menu)}
          >
            <MoreHorizontal size={17} />
          </button>
          {notes > 0 && (
            <button
              className="note-count"
              aria-label="Комментарии к сообщению"
              onClick={onNote}
            >
              <MessageSquare size={13} />
              {notes}
            </button>
          )}
        </div>
        {menu && (
          <div className="message-menu">
            <button
              onClick={() => {
                onReply();
                setMenu(false);
              }}
            >
              <CornerUpLeft size={15} />
              Ответить
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(message.text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
                setMenu(false);
              }}
            >
              <Copy size={15} />
              {copied ? "Скопировано" : "Копировать"}
            </button>
            <button
              onClick={() => {
                onNote();
                setMenu(false);
              }}
            >
              <MessageSquare size={15} />
              Оставить заметку
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
