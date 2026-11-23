import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { ApiError } from "./errors.js";

/**
 * «Как WhatsApp / как Instagram»: Studio sends guest messages to the CRM Meta webhook in Meta's own format,
 * signed like Meta signs them, and receives the hotel's replies through the CRM Studio transport.
 * It is on only when the environment sets the CRM webhook address, the shared signing secret (the CRM's
 * META_APP_SECRET of a test environment) and the reply token; otherwise Studio works as before.
 * The thread lives in memory: it is a demo channel, not a record.
 */
export interface MetaEmulatorConfig { webhookUrl: string; secret: string; callbackToken: string; whatsappPhoneNumberId: string; instagramAccountId: string }

export const metaEmulatorConfig = (env: NodeJS.ProcessEnv = process.env): MetaEmulatorConfig | null => {
  const value = { webhookUrl: env.STUDIO_META_EMULATOR_WEBHOOK_URL ?? "", secret: env.STUDIO_META_EMULATOR_SECRET ?? "",
    callbackToken: env.STUDIO_META_CALLBACK_TOKEN ?? "", whatsappPhoneNumberId: env.STUDIO_META_WA_PHONE_NUMBER_ID ?? "",
    instagramAccountId: env.STUDIO_META_IG_ACCOUNT_ID ?? "" };
  if (!value.webhookUrl || value.secret.length < 16 || value.callbackToken.length < 32 || (!value.whatsappPhoneNumberId && !value.instagramAccountId)) return null;
  return value;
};

export const signMeta = (raw: string, secret: string) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

/** WhatsApp Cloud API webhook body: one inbound text message, or one delivery status of a hotel message. */
export const whatsappPayload = (phoneNumberId: string, input: { from: string; name?: string; text?: string; id?: string; at?: Date;
  status?: { id: string; status: "sent" | "delivered" | "read" }; reaction?: { messageId: string; emoji: string } }) => {
  const timestamp = String(Math.floor((input.at ?? new Date()).getTime() / 1000));
  const messages = input.text ? [{ from: input.from, id: input.id ?? `wamid.studio.${randomUUID()}`, timestamp, type: "text", text: { body: input.text } }]
    : input.reaction ? [{ from: input.from, id: input.id ?? `wamid.studio.${randomUUID()}`, timestamp, type: "reaction", reaction: { message_id: input.reaction.messageId, emoji: input.reaction.emoji } }] : [];
  const statuses = input.status ? [{ id: input.status.id, status: input.status.status, timestamp, recipient_id: input.from }] : [];
  return { object: "whatsapp_business_account", entry: [{ id: "studio-waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp",
    metadata: { display_phone_number: phoneNumberId, phone_number_id: phoneNumberId }, contacts: [{ profile: { name: input.name ?? "Гость Studio" }, wa_id: input.from }],
    messages, statuses } }] }] };
};

/** Instagram messaging webhook body: one inbound text message or a reaction to a hotel message. */
export const instagramPayload = (accountId: string, input: { from: string; text?: string; id?: string; at?: Date; reaction?: { messageId: string; emoji: string } }) => {
  const timestamp = (input.at ?? new Date()).getTime();
  const item = input.text ? { sender: { id: input.from }, recipient: { id: accountId }, timestamp, message: { mid: input.id ?? `mid.studio.${randomUUID()}`, text: input.text } }
    : { sender: { id: input.from }, recipient: { id: accountId }, timestamp, reaction: { mid: input.reaction?.messageId ?? "", action: "react", reaction: input.reaction?.emoji ?? "love" } };
  return { object: "instagram", entry: [{ id: accountId, time: timestamp, messaging: [item] }] };
};

export interface EmulatorMessage { id: string; direction: "in" | "out"; channel: "whatsapp" | "instagram"; guest: string; text: string;
  at: string; status?: string; template?: unknown; senderType?: string }

const sendSchema = z.object({ channel: z.enum(["whatsapp", "instagram"]), guest: z.string().trim().min(3).max(40).regex(/^[\w.+-]+$/),
  name: z.string().trim().max(80).optional(), text: z.string().trim().min(1).max(4000).optional(),
  status: z.object({ messageId: z.string().min(1).max(200), status: z.enum(["delivered", "read"]) }).optional(),
  reaction: z.object({ messageId: z.string().min(1).max(200), emoji: z.string().min(1).max(8) }).optional(),
  /** Unix time the guest «sent» it, for showing a late delivery. */
  sentMinutesAgo: z.number().int().min(0).max(7 * 24 * 60).optional() }).refine((v) => Boolean(v.text || v.status || v.reaction), "Нужен текст, статус или реакция");

const callbackSchema = z.object({ externalMessageId: z.string().min(1).max(200), channel: z.string(), to: z.string().min(1).max(200),
  text: z.string().nullable().optional(), template: z.unknown().optional(), senderType: z.string().optional() }).passthrough();

export class MetaEmulator {
  readonly thread: EmulatorMessage[] = [];
  constructor(readonly cfg: MetaEmulatorConfig | null, private readonly fetchImpl: typeof fetch = fetch) {}

  private remember(message: EmulatorMessage) { this.thread.push(message); if (this.thread.length > 500) this.thread.splice(0, this.thread.length - 500); return message; }

  async send(raw: unknown) {
    if (!this.cfg) throw new ApiError(409, "META_EMULATOR_OFF", "Режим «как WhatsApp / Instagram» выключен на этом окружении");
    const input = sendSchema.parse(raw);
    const at = new Date(Date.now() - (input.sentMinutesAgo ?? 0) * 60_000);
    const accountId = input.channel === "whatsapp" ? this.cfg.whatsappPhoneNumberId : this.cfg.instagramAccountId;
    if (!accountId) throw new ApiError(409, "META_EMULATOR_CHANNEL_OFF", "Для этого канала не задан номер или аккаунт эмулятора");
    const id = input.channel === "whatsapp" ? `wamid.studio.${randomUUID()}` : `mid.studio.${randomUUID()}`;
    const reaction = input.reaction ? { messageId: input.reaction.messageId, emoji: input.reaction.emoji } : undefined;
    const body = input.channel === "whatsapp"
      ? whatsappPayload(accountId, { from: input.guest, name: input.name, text: input.text, id, at, reaction,
        status: input.status ? { id: input.status.messageId, status: input.status.status } : undefined })
      : instagramPayload(accountId, { from: input.guest, text: input.text, id, at, reaction });
    const rawBody = JSON.stringify(body);
    const response = await this.fetchImpl(this.cfg.webhookUrl, { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "x-hub-signature-256": signMeta(rawBody, this.cfg.secret) }, body: rawBody });
    if (!response.ok) throw new ApiError(502, "CRM_WEBHOOK_FAILED", `CRM ответила ${response.status}`);
    if (input.status) {
      const target = this.thread.find((message) => message.id === input.status!.messageId);
      if (target) target.status = input.status.status;
      return { sent: true };
    }
    return this.remember({ id, direction: "in", channel: input.channel, guest: input.guest, at: at.toISOString(),
      text: input.text ?? `Реакция ${input.reaction?.emoji ?? ""}` });
  }

  /** A hotel reply from the CRM Studio transport. */
  receive(authorization: string | undefined, raw: unknown) {
    if (!this.cfg) throw new ApiError(404, "NOT_FOUND", "Not found");
    const expected = Buffer.from(`Bearer ${this.cfg.callbackToken}`), provided = Buffer.from(authorization ?? "");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new ApiError(401, "AUTH_FAILED", "Invalid callback credentials");
    const input = callbackSchema.parse(raw);
    const channel = input.channel === "instagram" ? "instagram" : "whatsapp";
    const template = input.template as { name?: string } | undefined;
    return this.remember({ id: input.externalMessageId, direction: "out", channel, guest: input.to, at: new Date().toISOString(), status: "sent",
      text: input.text ?? (template?.name ? `[Шаблон ${template.name}]` : ""), template: input.template, senderType: input.senderType });
  }
}

/** The reply callback is public (bearer-protected); reading and sending need a signed-in tester. */
export function registerMetaEmulatorCallback(app: express.Express, emulator: MetaEmulator) {
  app.post("/api/integrations/meta-emulator/replies", express.json({ limit: "128kb" }), (req, res) => {
    emulator.receive(req.header("authorization"), req.body);
    res.json({ received: true });
  });
}
