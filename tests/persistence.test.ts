import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { database, migrate } from "../server/db";
import { seed } from "../server/seed";
import { Repository, record } from "../server/repository";
import type { Client } from "../shared/domain";
it("reopens embedded PostgreSQL with clients and prompt drafts intact", async () => {
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
  await db.close();
  db = await database(undefined, path);
  r = new Repository(db, "les-sandbox");
  expect((await r.get<Client>("virtual_clients", client.id))?.displayName).toBe(
    "Постоянный гость",
  );
  expect(
    (await r.get<{ body: string }>("prompt_versions", prompt.id))?.body,
  ).toBe("Сохранённый черновик");
  await db.close();
});
