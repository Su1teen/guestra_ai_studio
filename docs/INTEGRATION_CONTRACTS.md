# Studio ↔ n8n ↔ CRM ↔ PMS

Contract `studio-gateway-v1`, аудит 13 октября 2026. n8n workflow не подключён; ниже контракт следующей интеграционной поставки.

## Ownership / identity

CRM owns Customer/channel identities/conversation/messages/Request/Offer/sales lifecycle/handoff. PMS owns Guest/inventory/rates/Reservation/Stay/services/guest requests/Folio/payment facts. n8n owns execution, context, permitted tools and replies. Studio owns simulation/review/prompt registry/media/calls. Прямые записи Studio/n8n в CRM/PMS PostgreSQL запрещены.

`displayChannel=whatsapp|telegram|instagram|web`; `transportChannel=simulator`. Stable externalUserId: `studio:<workspace>:<mode>:<clientUUID>:<displayChannel>`. Каждый чат получает `studio:chat:<UUID>`, каждое сообщение UUID, immutable payload hash и correlationUUID. CRM channel identity и update ID глобальны — namespace обязателен. Телефон/username остаются визуальными полями и не передаются для автоматического matching. Имена и language передаются allowlist полями. Customer↔Guest links только explicit verified mappings, phone match недостаточен.

Property mapping: Studio label LES Боровое ↔ CRM text `CRM_PROPERTY_ID` ↔ PMS UUID `PMS_PROPERTY_ID`; никаких угадываний ID. Один deployment конфигурирует одну тестовую property; дополнительные credentials требуют environment configuration provider.

## Single inbound owner

| Mode    | Inbound owner             | Reply source                         |
| ------- | ------------------------- | ------------------------------------ |
| preview | Studio preview repository | Явный deterministic template, не LLM |
| crm     | Studio Gateway            | Только CRM transcript, без fake AI   |
| sandbox | n8n                       | CRM transcript после outbound result |

Режим существующего разговора неизменяем. UI допускает sending bubble, но delivered появляется лишь после authoritative read-back; preview показывает local persistence.

## CRM adapter: фактический v1

Base `/api/integrations/agent`, header `x-crm-api-key`. Discovery `GET /capabilities`: agent-api-v1, simulator, conversation polling.

`POST /messages/inbound` передаёт `{channel:'simulator',propertyId,externalUserId,externalChatId,externalMessageId,externalUpdateId:correlationId,firstName,lastName,displayName,language,text,attachments}`. Attachment: `{externalFileId:studioAssetId,kind,mimeType,fileName,fileSize}`. Response `{duplicate,messageId,context:{conversation:{id}},aiReplyAllowed,allowedActions}`. Duplicate сохраняет исходные IDs; changed payload under same key — conflict. Studio не отправляет inbound повторно через параллельный owner.

Transcript `GET /conversations/:id/messages?channel=simulator&propertyId=…&externalUserId=…&after=<messageId>&limit=100` → `{messages,nextCursor}`. Mapper пропускает только in/out, исключает internal note, contact inbound → guest. Null cursor означает drained page. Raw note-only pages также продвигают cursor. CRM sentAt mutable: выполняется полное paged merge by CRM ID, cache — 200 guest messages. Выше 5000 raw records возвращается честный `RECONCILIATION_WINDOW_EXCEEDED`; нужен immutable changes cursor.

`POST /messages/outbound/prepare` оставляет pending и не отправляет simulator автоматически. Workflow обязан вызвать `/messages/outbound/result` с success:true и stable simulator message reference. HTTP200 с success:false — ошибка доставки. Studio не превращает webhook acceptance в guest delivery.

## n8n envelope / callback

`POST N8N_WEBHOOK_URL`, bearer N8N_TOKEN, Idempotency-Key `<workspace>:<conversation>:<externalMessageId>`. Envelope: `{contractVersion:'studio-gateway-v1',environment:'sandbox',workspaceId,conversationId,runId,correlationId,inboundOwner:'n8n',inbound,media,prompt}`. Prompt snapshot includes versionId/body/model/workflowId/configuration(timeout/retries/tools/flags). Annotations исключены.

Workflow durably регистрирует idempotency key **до** scheduling и отвечает `{accepted:true}`. Replay принимает existing execution и повторяет latest callback; business tools не выполняются заново. На timeout Studio повторяет исходный key/envelope. Каждая PMS mutation дополнительно требует native operation idempotency, особенно платежи.

Capability URL возвращает `{contractVersion:'studio-gateway-v1',environment:'sandbox',inboundOwner:'n8n'}`. Workflow проверяет simulator/environment, сохраняет inbound один раз, загружает CRM context (sanitize notes), проверяет aiReplyAllowed/allowedActions, направляет operations в PMS, подготавливает/подтверждает outbound, затем сообщает completion.

Callback `POST /api/integrations/n8n/events`, raw application/json:

```json
{
  "eventId": "UUID",
  "workspaceId": "les-sandbox",
  "runId": "studio-run-id",
  "correlationId": "UUID",
  "crmConversationId": "crm-id",
  "state": "completed"
}
```

States inbound_saved/completed/human_owned/failed. Failed может не иметь CRM conversation; errorCode безопасный code без PII. Header x-studio-timestamp = Unix seconds; x-studio-signature = hex HMAC-SHA256(secret, timestamp + '.' + exact raw JSON). ±300sec window. Уникальные receipts и row locks обеспечивают replay и monotonic terminal states. Completed/human_owned не откатываются inbound_saved. Callback сам не подтверждает guest delivery — далее читается CRM.

Delivery и execution — отдельные durable states. Per-conversation lease сериализует очередь; разные чаты независимы. Lost callbacks приводят к bounded replay с исходными ключами; unresolved acceptance → completion_unknown, блокируя дальнейший execution этого чата до authoritative completion/recovery. Нельзя снять блокировку ради второй потенциальной booking/payment.

## PMS / fixture / future adapters

Base `/api/v1/connect`, x-api-key. Фактическая версия **v1**, integrationContextSupported/idempotencySupported=true. Используйте property-bound key; read-back `/properties` должен подтвердить UUID. Static `/api/v1/health` — liveness, не проверка БД/оплаты/event delivery. PMS booking paymentStatus=authorized не доказывает provider-backed payment fact.

ScenarioSetupAdapter.prepare({workspaceId,stage,externalUserId,crmPropertyId,pmsPropertyId}) → {status,reason,references}. READY требует authoritative read-back identity/property/reservation/payment/stay. Default UnavailableScenarioSetup возвращает SETUP_UNAVAILABLE. Только new_contact подключён без fixtures; advanced preview=PREVIEW_ONLY. Staff JWT/test fixture provider должен быть sandbox-only с стабильным key/cleanup policy. Нельзя исполнять fixtures в production.

CRM attachment metadata не включает binaries. Studio ObjectStorage+metadata validate magic/MIME/20MB, authorizes upload, выдаёт signed URLs с workspace/id/purpose/5min expiry. Workflow требует scanStatus clean. После match externalMessageId mapper использует исходные Studio asset refs; CRM IDs отличаются. Agent-origin outbound media не поддерживается текущим API и не заявлен завершённым.

Prompt publish/rollback — только immutable Studio registry/audit; PromptPublisher future interface должен возвращать deploymentId/readBackHash. TraceReader future interface — sanitized read-only summaries/timings/status/business refs, без keys/tokens/hidden reasoning. Отсутствующие tool calls не выдумываются. Calls: persistent virtual incoming/outgoing sessions, transitions/duration/turns/audio/run/comments; SpeechAdapter STT/TTS interfaces без SIP/PBX/realtime/provider.

## Authentication / errors

Studio error `{error:{code,message,retryable,correlationId}}`. Zod, role и workspace validation применяются server-side. Непредвиденные ошибки не возвращают stack/credential/body. Upstream HTTP summaries сохраняют retryability (включая CRM409). HTTPS host allowlist + explicit sandbox attestation обязательны; redirects запрещены. Credentials никогда не возвращаются frontend/audit/snapshots. Discovery проверяет совместимость контракта, но не заменяет сквозные тесты из gaps-документа.
