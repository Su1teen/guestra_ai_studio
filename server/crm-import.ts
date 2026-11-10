import type { Database } from "./db.js";
import type { Config } from "./config.js";
import type { Agent, Client, Conversation, Identity, Mode } from "../shared/domain.js";
import { record, Repository } from "./repository.js";
import type { CrmV2Adapter } from "./crm-v2.js";

type CrmChat = Awaited<ReturnType<CrmV2Adapter["inbox"]>>[number];
export interface ImportResult { imported: number; skipped: number }

/**
 * Brings chats the hotel started in PMS / CRM (a document sent for confirmation, a staff message) into Studio,
 * so the tester can answer as that guest. The CRM stays the owner of the transcript: Studio stores only the
 * reference (CRM conversation id, the guest's simulator identity and chat id) and reads messages through the
 * usual immutable changes feed. Only simulator chats of the attested property are imported; real messenger
 * chats never become simulated ones. Idempotent: a CRM conversation is imported once per workspace.
 */
export async function importCrmChats(db: Database, workspaceId: string, cfg: Config, crm: CrmV2Adapter, mode: Mode): Promise<ImportResult> {
  if (mode === "preview") return { imported: 0, skipped: 0 };
  const chats = (await crm.inbox()).filter((chat) => chat.channel === "simulator" && chat.identity?.externalChatId);
  if (!chats.length) return { imported: 0, skipped: 0 };
  return db.transaction(async (tx) => {
    const r = new Repository(tx, workspaceId);
    // Serialise concurrent imports of the same workspace (two tabs polling bootstrap at once).
    await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
    const conversations = await r.list<Conversation>("conversation_refs");
    const known = new Set(conversations.flatMap((c) => [c.crmConversationId, c.externalChatId].filter(Boolean) as string[]));
    const identities = await r.list<Identity>("virtual_identities");
    const agent = (await r.list<Agent>("agent_configurations"))[0];
    let imported = 0, skipped = 0;
    for (const chat of chats) {
      if (known.has(chat.id) || known.has(chat.identity!.externalChatId!)) { skipped++; continue; }
      let identity = identities.find((i) => i.externalUserId === chat.identity!.externalUserId);
      if (!identity) {
        const client = clientFor(chat);
        await r.put("virtual_clients", client);
        identity = record({ clientId: client.id, displayChannel: "web" as const, transportChannel: "simulator" as const,
          externalUserId: chat.identity!.externalUserId, crmCustomerId: chat.customerId, environment: cfg.environment ?? "production",
          verifiedAt: new Date().toISOString(), verificationSource: "crm_inbox" });
        await r.put("virtual_identities", identity, { client_id: client.id, external_user_id: identity.externalUserId });
        identities.push(identity);
      }
      const conversation: Conversation & { origin: string } = {
        ...record({
          agentId: agent?.id, clientId: identity.clientId, identityId: identity.id,
          title: `${chat.customerName} · чат отеля`.slice(0, 150), externalChatId: chat.identity!.externalChatId!, mode,
          crmConversationId: chat.id, crmCustomerId: chat.customerId,
          propertyMapping: { crmPropertyId: cfg.crmProperty, crmTenantId: cfg.crmTenant ?? "", pmsPropertyId: cfg.pmsProperty,
            pmsTenantId: cfg.pmsTenant ?? "", environment: cfg.environment ?? "production" },
          stage: "known_customer", draft: "", verdict: "unreviewed" as const, lastText: chat.lastMessage?.text?.slice(0, 200) ?? "Чат отеля",
          unread: 1, handoff: false, setupStatus: "READY" as const,
        }),
        origin: "crm",
      };
      await r.put("conversation_refs", conversation, { client_id: identity.clientId, identity_id: identity.id, external_chat_id: conversation.externalChatId });
      await r.put("simulation_sessions", record({ conversationId: conversation.id, mode, status: "READY" }), { conversation_id: conversation.id });
      known.add(chat.id);
      imported++;
    }
    if (imported) await r.audit("crm", "crm_chats_imported", String(imported), "Чаты отеля из CRM");
    return { imported, skipped };
  });
}

function clientFor(chat: CrmChat): Client {
  const [firstName, ...rest] = chat.customerName.trim().split(/\s+/);
  return record({ firstName: (firstName || "Гость").slice(0, 80), lastName: rest.join(" ").slice(0, 80), displayName: chat.customerName.slice(0, 160) || "Гость",
    phone: "", telegram: "", channel: "web" as const, language: "ru", property: "LES Боровое", parameters: { source: "crm", crmCustomerId: chat.customerId } });
}
