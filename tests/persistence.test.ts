import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { database, migrate } from "../server/db";
import { seed } from "../server/seed";
import { Repository, record } from "../server/repository";
import type {
  Annotation,
  Client,
  Conversation,
  Message,
} from "../shared/domain";
it("reopens embedded PostgreSQL with clients, chat, review and prompt drafts intact", async () => {
  const path = resolve(".local", "persistence-tests", randomUUID());
  let db = await database(undefined, path);
  await migrate(db);
  await seed(db, true);
  let r = new Repository(db, "les-sandbox");
  const client = record({
    firstName: "Постоянный",
    lastName: "Гость",
    displayName: "Постоянный гость",
    phone: "",
    telegram: "",
    channel: "whatsapp",
    language: "ru",
    property: "LES Боровое",
    parameters: {},
  });
  await r.put("virtual_clients", client);
  const agent = (await r.list<{ id: string }>("agent_configurations"))[0];
  const prompt = record({
    agentId: agent.id,
    version: 2,
    body: "Сохранённый черновик",
    status: "draft",
    author: "test",
  });
  await r.put("prompt_versions", prompt);
  const conversation = (await r.list<Conversation>("conversation_refs"))[0];
  await r.patch("conversation_refs", conversation.id, {
    draft: "Черновик перед перезапуском",
    verdict: "pass",
  });
  const message = record({
    conversationId: conversation.id,
    text: "Сообщение перед перезапуском",
    direction: "inbound",
    senderType: "guest",
    deliveryStatus: "delivered",
    attachments: [],
    source: "preview",
  });
  await r.put("preview_messages", message);
  const annotation = record({
    conversationId: conversation.id,
    targetType: "message",
    targetId: message.id,
    body: "Сохранённая заметка",
    author: "test",
    severity: "warning",
    type: "quality",
    flags: ["date"],
    status: "resolved",
    history: [
      {
        at: message.createdAt,
        author: "test",
        body: "Первая редакция",
        status: "open",
      },
    ],
  });
  await r.put("tester_annotations", annotation);
  await db.close();
  db = await database(undefined, path);
  await migrate(db);
  r = new Repository(db, "les-sandbox");
  expect((await r.get<Client>("virtual_clients", client.id))?.displayName).toBe(
    "Постоянный гость",
  );
  expect(
    (await r.get<{ body: string }>("prompt_versions", prompt.id))?.body,
  ).toBe("Сохранённый черновик");
  expect(
    await r.get<Conversation>("conversation_refs", conversation.id),
  ).toMatchObject({
    draft: "Черновик перед перезапуском",
    verdict: "pass",
  });
  expect(await r.get<Message>("preview_messages", message.id)).toMatchObject({
    text: message.text,
    deliveryStatus: "delivered",
  });
  expect(
    await r.get<Annotation>("tester_annotations", annotation.id),
  ).toMatchObject({
    body: annotation.body,
    flags: ["date"],
    status: "resolved",
    history: annotation.history,
  });
  await db.close();
});
