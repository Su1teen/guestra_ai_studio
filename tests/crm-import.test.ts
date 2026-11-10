import { describe, expect, it } from "vitest";
import { migrate } from "../server/db";
import { seed } from "../server/seed";
import { Repository, record } from "../server/repository";
import { importCrmChats } from "../server/crm-import";
import { testDatabase } from "./test-database";
import type { Config } from "../server/config";
import type { Conversation, Identity } from "../shared/domain";

const cfg = { crmProperty: "sandbox_les", crmTenant: "org_les", pmsProperty: "b4d34b21-e0fb-47b4-9b53-72f4e2ba7d2a", pmsTenant: "b4d34b21-e0fb-47b4-9b53-72f4e2ba7d2a",
  environment: "sandbox" } as Config;
const chat = (id: string, externalUserId: string, channel = "simulator") => ({ id, customerId: "customer_1", customerName: "Алия Серикова", channel,
  status: "pending", automationMode: "human", lastMessageAt: "2027-01-01T10:00:00.000Z", lastMessage: { text: "Проверьте документ", direction: "out" },
  identity: channel === "simulator" ? { externalUserId, externalChatId: `crm:chat:${id}` } : null });

describe("hotel chats from CRM in Studio", () => {
  it("imports simulator chats once, as the guest's own simulated identity, and ignores real messengers", async () => {
    const db = await testDatabase();
    await migrate(db);
    await seed(db, true);
    const r = new Repository(db, "les-sandbox");
    const before = (await r.list<Conversation>("conversation_refs")).length;
    const crm = { inbox: async () => [chat("conv-1", "crm:customer:customer_1"), chat("conv-2", "crm:customer:customer_1"), chat("conv-tg", "x", "telegram")] };
    const first = await importCrmChats(db, "les-sandbox", cfg, crm as never, "sandbox");
    expect(first).toEqual({ imported: 2, skipped: 0 });
    const again = await importCrmChats(db, "les-sandbox", cfg, crm as never, "sandbox");
    expect(again).toEqual({ imported: 0, skipped: 2 });
    const conversations = await r.list<Conversation & { origin?: string }>("conversation_refs");
    expect(conversations.length).toBe(before + 2);
    const imported = conversations.filter((c) => c.origin === "crm");
    expect(imported.map((c) => c.crmConversationId).sort()).toEqual(["conv-1", "conv-2"]);
    expect(imported[0]).toMatchObject({ externalChatId: expect.stringMatching(/^crm:chat:/), mode: "sandbox", setupStatus: "READY",
      propertyMapping: { crmPropertyId: "sandbox_les", environment: "sandbox" } });
    // Both chats belong to one simulated guest: the CRM identity is reused, not duplicated.
    const identities = (await r.list<Identity>("virtual_identities")).filter((i) => i.externalUserId === "crm:customer:customer_1");
    expect(identities).toHaveLength(1);
    expect(new Set(imported.map((c) => c.identityId))).toEqual(new Set([identities[0]!.id]));
    await db.close();
  });

  it("attaches a chat to an existing Studio guest with the same identity and does nothing in preview", async () => {
    const db = await testDatabase();
    await migrate(db);
    await seed(db, true);
    const r = new Repository(db, "les-sandbox");
    const client = record({ firstName: "Тест", lastName: "", displayName: "Тест", phone: "", telegram: "", channel: "web" as const, language: "ru",
      property: "LES Боровое", parameters: {} });
    await r.put("virtual_clients", client);
    const identity = record({ clientId: client.id, displayChannel: "web" as const, transportChannel: "simulator" as const, externalUserId: "studio:existing" });
    await r.put("virtual_identities", identity, { client_id: client.id, external_user_id: identity.externalUserId });
    const crm = { inbox: async () => [chat("conv-9", "studio:existing")] };
    expect(await importCrmChats(db, "les-sandbox", cfg, crm as never, "preview")).toEqual({ imported: 0, skipped: 0 });
    expect(await importCrmChats(db, "les-sandbox", cfg, crm as never, "crm")).toEqual({ imported: 1, skipped: 0 });
    const conversation = (await r.list<Conversation>("conversation_refs")).find((c) => c.crmConversationId === "conv-9");
    expect(conversation).toMatchObject({ clientId: client.id, identityId: identity.id });
    await db.close();
  });
});
