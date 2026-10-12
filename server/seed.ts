import type { Database, Sql } from "./db.js";
import { Repository, record, now } from "./repository.js";
import { passwordHash } from "./auth.js";
export async function seed(db: Database, local: boolean) {
  return db.transaction((tx) => seedRecords(tx, local));
}
async function seedRecords(db: Sql, local: boolean) {
  await db.query(
    "INSERT INTO workspaces(id,name,environment) VALUES('les-sandbox','LES Боровое · Test lab',$1) ON CONFLICT DO NOTHING",
    [local ? "local" : "sandbox"],
  );
  if (local) {
    await db.query(
      "INSERT INTO studio_users(id,email,name) VALUES('local-tester','local@studio.invalid','Локальный тестировщик') ON CONFLICT DO NOTHING",
    );
    await db.query(
      "INSERT INTO memberships VALUES('les-sandbox','local-tester','admin') ON CONFLICT DO NOTHING",
    );
  }
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 12)
      throw new Error("ADMIN_PASSWORD minimum 12 characters");
    await db.query(
      "INSERT INTO studio_users(id,email,password_hash,name) VALUES('bootstrap-admin',$1,$2,'Администратор') ON CONFLICT(email) DO NOTHING",
      [
        process.env.ADMIN_EMAIL.toLowerCase(),
        passwordHash(process.env.ADMIN_PASSWORD),
      ],
    );
    await db.query(
      "INSERT INTO memberships SELECT 'les-sandbox',id,'admin' FROM studio_users WHERE email=$1 ON CONFLICT DO NOTHING",
      [process.env.ADMIN_EMAIL.toLowerCase()],
    );
  }
  const repo = new Repository(db, "les-sandbox");
  if ((await repo.list("agent_configurations")).length) return;
  const agent = record({
    name: "LES Guest Assistant",
    description: "Гостевой ассистент LES Боровое",
    workflowId: "not-connected",
    model: "preview-template",
    timeoutMs: 15000,
    maxRetries: 3,
    tools: [
      "get_property_knowledge",
      "check_accommodation_availability",
      "handoff_to_human",
    ],
    flags: { safePricing: true },
    activeVersionId: "",
  });
  await repo.put("agent_configurations", agent);
  const prompt = record({
    agentId: agent.id,
    version: 1,
    body: "Ты гостевой ассистент LES Боровое. Отвечай на языке гостя. Проверяй доступность и цены только через разрешённые authoritative APIs. Не обещай бронирование или оплату без подтверждённого результата PMS. Учитывай aiReplyAllowed и allowedActions. При human takeover прекрати AI-ответы. Никогда не раскрывай ключи и персональные данные других гостей.",
    status: "published",
    author: "Studio bootstrap",
  });
  await repo.put("prompt_versions", prompt, { agent_id: agent.id });
  await repo.put("agent_configurations", {
    ...agent,
    activeVersionId: prompt.id,
  });
  for (const item of [
    {
      name: "Знакомство с LES",
      description: "Первое обращение: состав гостей, даты и вопросы о курорте.",
      stage: "new_contact",
      opening:
        "Здравствуйте! Планируем приехать в LES Боровое с двумя детьми. Какие варианты отдыха есть?",
      assertions: [
        {
          name: "Ответ обработан без ложной доставки",
          kind: "no_unconfirmed_delivery",
          value: "",
        },
      ],
    },
    {
      name: "До заезда · семейный отдых",
      description:
        "Требуется подтверждённая тестовая бронь в PMS. Preview не создаёт её.",
      stage: "pre_arrival",
      opening: "Здравствуйте! Мы приезжаем завтра. Подскажите время заезда.",
      assertions: [
        { name: "Упомянуто время заезда", kind: "contains", value: "заезд" },
      ],
    },
    {
      name: "Во время проживания · запрос",
      description:
        "Требуется активное проживание и verified Customer ↔ Guest mapping.",
      stage: "in_house",
      opening: "Можно принести дополнительное полотенце в наш домик?",
      assertions: [
        {
          name: "Ответ не подменяет PMS операцию",
          kind: "no_unconfirmed_delivery",
          value: "",
        },
      ],
    },
    {
      name: "Готовность оплатить",
      description:
        "Готовность гостя не равна факту оплаты. Нужен sandbox payment fixture.",
      stage: "pending_payment",
      opening: "Мы готовы оплатить. Пришлите ссылку.",
      assertions: [
        {
          name: "Нет неподтверждённой доставки",
          kind: "no_unconfirmed_delivery",
          value: "",
        },
      ],
    },
  ])
    await repo.put("test_scenarios", record(item));
  await repo.put(
    "integration_mappings",
    record({
      studioProperty: "LES Боровое",
      crmPropertyId: process.env.CRM_PROPERTY_ID || null,
      pmsPropertyId: process.env.PMS_PROPERTY_ID || null,
      verified: false,
    }),
  );
  if (!local) return;
  const definitions = [
    ["Алия", "Садыкова", "whatsapp", "Семейные выходные", "new_contact"],
    ["Данияр", "Омаров", "telegram", "Вопрос о заезде", "pre_arrival"],
    ["Мария", "Петрова", "instagram", "Отдых с друзьями", "new_contact"],
  ];
  for (const [firstName, lastName, channel, title, stage] of definitions) {
    const client = record({
      firstName,
      lastName,
      displayName: firstName + " " + lastName,
      phone: "",
      telegram: "",
      channel,
      language: "ru",
      property: "LES Боровое",
      parameters: { fixture: "TEST · вымышленный гость" },
    });
    await repo.put("virtual_clients", client);
    const identity = record({
      clientId: client.id,
      displayChannel: channel,
      transportChannel: "simulator",
      externalUserId: `studio:les-sandbox:preview:${client.id}:${channel}`,
    });
    await repo.put("virtual_identities", identity, {
      client_id: client.id,
      external_user_id: identity.externalUserId,
    });
    const conv = record({
      clientId: client.id,
      identityId: identity.id,
      title,
      externalChatId: "studio:chat:" + crypto.randomUUID(),
      mode: "preview",
      stage,
      draft: "",
      verdict: "unreviewed",
      lastText: "Тестовый разговор готов",
      unread: 0,
      handoff: false,
      setupStatus: stage === "new_contact" ? "READY" : "PREVIEW_ONLY",
    });
    await repo.put("conversation_refs", conv, {
      client_id: client.id,
      identity_id: identity.id,
      external_chat_id: conv.externalChatId,
    });
    if (firstName === "Алия") {
      for (const [direction, text] of [
        [
          "inbound",
          "Здравствуйте! Хотим провести выходные в Боровом. Нас двое взрослых и двое детей.",
        ],
        [
          "outbound",
          "Здравствуйте, Алия! С удовольствием помогу спланировать отдых в LES. На какие даты вы планируете поездку?",
        ],
        [
          "inbound",
          "С 23 по 25 октября. Хотелось бы уютный домик рядом с лесом.",
        ],
      ])
        await repo.put(
          "preview_messages",
          record({
            conversationId: conv.id,
            direction,
            senderType: direction === "inbound" ? "guest" : "agent",
            text,
            deliveryStatus: "local",
            attachments: [],
            source: "preview",
          }),
          { conversation_id: conv.id },
        );
      await repo.put("conversation_refs", {
        ...conv,
        lastText: "С 23 по 25 октября. Хотелось бы уютный домик рядом с лесом.",
        updatedAt: now(),
      });
    }
  }
}
