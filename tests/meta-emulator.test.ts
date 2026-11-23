import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { MetaEmulator, metaEmulatorConfig, registerMetaEmulatorCallback, signMeta, whatsappPayload, instagramPayload } from "../server/meta-emulator";
import { ApiError } from "../server/errors";

const cfg = { webhookUrl: "https://crm.invalid/api/webhooks/meta", secret: "shared-emulator-secret", callbackToken: "studio-callback-token-at-least-32-chars",
  whatsappPhoneNumberId: "studio-wa-1", instagramAccountId: "studio-ig-1" };

describe("Meta emulator («как WhatsApp / как Instagram»)", () => {
  it("is off unless the webhook, the shared secret, the reply token and an account are set", () => {
    expect(metaEmulatorConfig({})).toBeNull();
    expect(metaEmulatorConfig({ STUDIO_META_EMULATOR_WEBHOOK_URL: cfg.webhookUrl, STUDIO_META_EMULATOR_SECRET: cfg.secret, STUDIO_META_CALLBACK_TOKEN: "short" })).toBeNull();
    expect(metaEmulatorConfig({ STUDIO_META_EMULATOR_WEBHOOK_URL: cfg.webhookUrl, STUDIO_META_EMULATOR_SECRET: cfg.secret,
      STUDIO_META_CALLBACK_TOKEN: cfg.callbackToken, STUDIO_META_WA_PHONE_NUMBER_ID: "wa" })).toMatchObject({ whatsappPhoneNumberId: "wa" });
  });

  it("builds Meta-format bodies the CRM webhook reads", () => {
    const wa = whatsappPayload("wa-1", { from: "77015550001", text: "Здравствуйте", id: "wamid.x", at: new Date(1_800_000_000_000) });
    expect(wa).toMatchObject({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "wa-1" },
      messages: [{ from: "77015550001", id: "wamid.x", timestamp: "1800000000", type: "text", text: { body: "Здравствуйте" } }] } }] }] });
    const ig = instagramPayload("ig-1", { from: "igsid-1", text: "Привет", id: "mid.x" });
    expect(ig).toMatchObject({ object: "instagram", entry: [{ id: "ig-1", messaging: [{ sender: { id: "igsid-1" }, recipient: { id: "ig-1" }, message: { mid: "mid.x", text: "Привет" } }] }] });
  });

  it("signs the exact bytes like Meta and keeps the guest message in the thread", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const emulator = new MetaEmulator(cfg, fetchImpl as never);
    const sent = await emulator.send({ channel: "whatsapp", guest: "77015550001", text: "Есть номер на выходные?", sentMinutesAgo: 180 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(cfg.webhookUrl);
    expect(init.headers["x-hub-signature-256"]).toBe(`sha256=${createHmac("sha256", cfg.secret).update(init.body).digest("hex")}`);
    expect(init.headers["x-hub-signature-256"]).toBe(signMeta(init.body, cfg.secret));
    expect(sent).toMatchObject({ direction: "in", channel: "whatsapp", text: "Есть номер на выходные?" });
    expect(Date.now() - Date.parse((sent as { at: string }).at)).toBeGreaterThan(170 * 60_000);
    await expect(new MetaEmulator(null).send({ channel: "whatsapp", guest: "77015550001", text: "x" })).rejects.toBeInstanceOf(ApiError);
  });

  it("accepts hotel replies only with the reply token and shows delivery statuses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const emulator = new MetaEmulator(cfg, fetchImpl as never);
    const app = express(); registerMetaEmulatorCallback(app, emulator);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(error instanceof ApiError ? error.status : 400).json({}));
    const reply = { externalMessageId: "studio:msg-1", channel: "whatsapp", to: "77015550001", text: "Да, есть", senderType: "ai" };
    await request(app).post("/api/integrations/meta-emulator/replies").send(reply).expect(401);
    await request(app).post("/api/integrations/meta-emulator/replies").set("authorization", `Bearer ${cfg.callbackToken}`).send(reply).expect(200);
    expect(emulator.thread.at(-1)).toMatchObject({ id: "studio:msg-1", direction: "out", text: "Да, есть", status: "sent" });
    await emulator.send({ channel: "whatsapp", guest: "77015550001", status: { messageId: "studio:msg-1", status: "read" } });
    expect(emulator.thread.at(-1)).toMatchObject({ status: "read" });
    const body = JSON.parse(fetchImpl.mock.calls.at(-1)![1].body);
    expect(body.entry[0].changes[0].value.statuses[0]).toMatchObject({ id: "studio:msg-1", status: "read" });
  });
});
