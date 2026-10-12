# Guestra PMS — аудит интеграции AI Studio

Дата проверки: **13 октября 2026**, Asia/Qyzylorda. Проверен фактический код локального `C:/paterhaus/guestra_PMS`, только чтение. Зафиксирован `HEAD`: **`0dbc7f80893a0846dd3d419f2bd822620b3d4092`**. Код Connect/auth/guest/reservation/service/payment/webhook прочитан вместе с контрактами и схемами; это статический аудит, а не подтверждение работающего remote endpoint. Credentials, sandbox URL и доступ к тестовой БД не предоставлены; API-запросы и PMS-тесты не запускались.

В PMS уже есть незакоммиченная работа другого агента: reports/management-inputs, dashboard workspace и связанные shared/schema файлы. Она не изменялась и не оценивалась. Все PMS-файлы оставлены без изменений. Следовали корневым `AGENTS.md` и `CLAUDE.md`: доменная логика не придумывалась, данные других пользователей не использовались.

## 1. Вывод для Studio

PMS подходит как authoritative API для поиска, подтверждённого проживания, operational services, гостевых запросов, фолио и платёжных фактов. Основной чат Studio остаётся гостевой стороной: бизнес-операции выполняет n8n через PMS, результаты видны в PMS/CRM. Studio хранит только ссылки и проверенные snapshots для сценария/Inspector, не собственный PMS.

На этом снимке можно реализовать честную проверку подключения и read adapters. **End-to-End Sandbox нельзя объявить готовым только по `health` и `capabilities`.** Есть существенные расхождения фактического кода с документированным контрактом: новый customer-link проживания, платёжный статус ответа Connect, повторяемость modify/cancel, типы polling событий и тест webhook. Для стадий, требующих проживания, оплаты или существующей identity, нужен разрешённый setup-provider и read-back. Пока он не настроен, результат — `SETUP_UNAVAILABLE` с причиной.

## 2. Источники и закреплённый снимок

База исходников: [PMS commit](https://github.com/Su1teen/guestra_PMS/tree/0dbc7f80893a0846dd3d419f2bd822620b3d4092). Ниже пути относительно корня PMS и проверенные точки входа:

| ID | Источник | Что проверено |
| --- | --- | --- |
| S1 | `apps/api/src/main.ts:43` | prefix `/api/v1`; ValidationPipe `whitelist`, `forbidNonWhitelisted`, `transform` |
| S2 | `apps/api/src/modules/connect/connect.controller.ts:49` | все Connect routes, scope pinning, capabilities |
| S3 | `apps/api/src/modules/auth/api-key.guard.ts:61` | API-key hash lookup, revocation, platform fallback |
| S4 | `apps/api/src/modules/auth/connect-scope.guard.ts:58` | property isolation, service scopes, confirmation ownership |
| S5 | `apps/api/src/modules/auth/property-scope.guard.ts`; `auth.module.ts:57`; `permissions.guard.ts` | JWT/property/local permissions для staff REST |
| S6 | `apps/api/src/modules/connect/dto/agent-{search,book,modify,service,service-request,event-subscription}.dto.ts`; `dto/integration-context.dto.ts`; `dto/service-operations.dto.ts` | payload validation |
| S7 | `apps/api/src/modules/connect/connect-search.service.ts:28,319`; `connect-content.service.ts:13` | response shapes, canonical search price, content |
| S8 | `apps/api/src/modules/connect/connect-booking.service.ts:44,301,372,540,612,687,730` | booking transaction, verify, modify/cancel, identity, replay |
| S9 | `apps/api/src/modules/connect/connect-service-booking.service.ts:23,76,99,192,207,468,492` | service capacity, accepted price, lifecycle, guest mapping |
| S10 | `apps/api/src/modules/service-requests/service-requests.service.ts:142` | operational request creation/replay/output |
| S11 | `apps/api/src/modules/connect/connect-events.service.ts:31,97,139,177` | subscription/test/poll/fan-out |
| S12 | `apps/api/src/modules/webhook/webhook-delivery.service.ts:19,118,218,463`; `webhook.service.ts:42`; `domain-event-outbox.service.ts:17` | HMAC, queue, audit/outbox, retry |
| S13 | `apps/api/src/modules/reservation/reservation.controller.ts:214,285,297,452,465`; `reservation.service.ts:231,591,816`; `reservation-state-machine.ts` | staff lifecycle and money preconditions |
| S14 | `apps/api/src/modules/guest/guest.controller.ts`; `guest.service.ts`; `dto/create-guest.dto.ts` | property guest access, Guest 360, merge, service-only guests |
| S15 | `apps/api/src/modules/folio/folio.controller.ts`; `dto/create-folio.dto.ts`; `apps/api/src/modules/payment/payment.controller.ts`; `dto/create-payment.dto.ts`; `dto/authorize-payment.dto.ts` | authoritative finances |
| S16 | `packages/database/src/schema/integration.ts`; `schema/reservation.ts:96,111`; `schema/ops.ts:130,135`; `migrations/0029_guestra_unified_integration.sql` | durable links and idempotency uniqueness |
| S17 | `docs/integrations/guestra-unified-architecture.md`; `pms-agent-api-v1.md`; `pms-agent-api-v1.contract.json`; `connect-api-key.md`; `service-principal.md`; `docs/webhooks.md` | declared contracts, compared against code |
| S18 | `apps/api/src/modules/health/health.controller.ts:9` | liveness response |

Локальные исходники S2–S18 относятся к указанному снимку. Повторить аудит после завершения M3/M4 и зафиксировать новый commit при включении Sandbox. При расхождении документа и кода адаптер следует фактическому контракту, а ожидаемое изменение фиксируется в разделе gaps.

## 3. Authentication и discovery

### Connect

Все перечисленные далее Connect paths имеют базу `/api/v1/connect`. Header: `x-api-key: <secret>`. JWT не используется на Connect: controller помечен `@Public()` для обхода глобального JWT, затем применяет `ApiKeyGuard` и `ConnectScopeGuard` [S2–S4].

- Property key: SHA-256(raw key) ищется в `connect_credentials`. Server хранит hash. `isActive === false` или `revokedAt` дают terminal 401, даже при совпадении с platform env key. Principal содержит `scope: property`, `propertyId`, `credentialId`, непустые `scopes`.
- Platform key: constant-time comparison с непустыми comma-separated `CONNECT_API_KEY`; principal `scope: platform`, cross-property. Studio Sandbox должен использовать property credential.
- `AUTH_ENABLED=false` полностью обходит ключи и прикрепляет platform principal. Успех такого окружения не доказывает tenant isolation.
- Property guard отклоняет чужой/non-scalar `query.propertyId` или `body.propertyId`; confirmationNumber разрешается через bookings и проверяется его property. Для неизвестной/чужой confirmation одинаковый 403. `/properties/:id` отдельно сравнивает ID в controller.
- `/search` с property credential всегда принудительно использует credential property, даже если body propertyId опущен. `/properties` возвращает массив только своего property detail; platform list возвращает краткие rows. Форматы отличаются.
- Только service handlers имеют `@ServiceCapability`. Для scopes, содержащих `pms:scoped:v1`, `services.read` или `services.write`, нужны соответствующие `services.read`/`services.write`. Маркер без action scopes запрещает все service tools. Empty/opaque legacy scopes и platform keys сохраняют широкий доступ. Другие Connect handlers не имеют общего granular capability enforcement.

Создание ключей — **staff admin API**, не Connect: `POST /api/v1/admin/connect/credentials?propertyId=<uuid>` с `{name, scopes?}`, JWT + `@Roles('admin')` + `settings.manage`; raw key возвращается один раз. `GET` list скрывает secret/hash; `POST /:id/rotate?propertyId=` и `DELETE /:id?propertyId=` имеют те же guards [S3, ConnectCredentialsController]. Studio не должна автоматически выпускать ключи PMS.

### Проверка подключения

| Запрос | Точный смысл результата | Чего он не доказывает |
| --- | --- | --- |
| `GET /api/v1/health` без auth | `{status:"ok",service:"haip-api",version:"0.0.1",timestamp}` | Это статический liveness, без DB/Redis/orchestration/environment проверок [S18] |
| `GET /api/v1/connect/capabilities` + key | `contractVersion:"v1"`, `integrationContextSupported:true`, `idempotencySupported:true`, booking modes и массив tools/events | Ответ не зависит от scopes, не возвращает environment, credential property или действительное разрешение каждого tool [S2] |
| `GET /api/v1/connect/properties/<configuredPropertyId>` + key | Property exists/access works; ответ имеет `sourcePropertyId`, timezone/currency/content | Не подтверждает n8n/CRM, доступность rooms/services, отсутствие production |
| `POST /api/v1/connect/search` с разрешёнными датами | Проверка чтения inventory/rates без бизнес-записи | Не резервирует inventory и не гарантирует неизменность цены при booking |

Точный `supportedTools`: `search_accommodation`, `book_accommodation`, `get_booking`, `modify_booking`, `cancel_booking`, `get_service_options`, `check_service_availability`, `book_service`, `get_service_booking`, `modify_service_booking`, `cancel_service_booking`. Фактические `get_property` и `create_guest_request` не перечислены, хотя routes существуют. `supportedBookingModes`: `live_booking`, `request_only`, `info_only`, `disabled` — это глобальные enum, а не обещание, что конкретная service bookable. Webhook types в discovery: `reservation.created`, `reservation.checked_in`, `reservation.checked_out`, `service_booking.created`, `service_booking.rescheduled`, `service_booking.cancelled`, `service_booking.completed`, `service_request.created` [S2].

Gateway должен хранить отдельно configured environment attestation, verified property ID, проверенный commit/contract и время discovery. Не делать автоматический mutation probe для readiness.

## 4. Фактические Connect payload и ответы

Все UUID ниже должны быть получены из PMS или setup-provider. Примеры обозначают структуру, не готовые гостиничные данные. Unknown DTO fields дают 400, поэтому добавлять непредусмотренные `idempotencyKey`, `guestId`, `expectedRevision` к accommodation modify нельзя [S1]. Успешный POST без `@HttpCode` по умолчанию Nest возвращает 201, даже там, где Swagger аннотирует 200; адаптер должен принимать ожидаемые успешные 2xx.

### Accommodation search/content

`POST /search`: обязательны `checkIn`, `checkOut`; использовать `YYYY-MM-DD`. Optional: `propertyId`, `city`, `latitude`, `longitude`, `radiusKm`, `rooms >=1`, `adults >=1`, `children >=0`, `rateType`, `amenities:string[]`, `accessibleOnly:boolean`, `limit:1..100`, `offset>=0` [S6].

Ответ: `{source:"haip",sourceVersion:"1.0.0",searchId,timestamp,results,totalResults,responseTimeMs}`. В `results[]`: `sourcePropertyId`, property content, `roomTypes[]` с `roomTypeId`, name/occupancy/amenities, `available`, `totalInventory`, `rates[]`. Rate: `ratePlanId`, name/code/type, `totalAmount:number`, `currencyCode`, `nightlyBreakdown[{date,baseRate,taxAmount,totalRate}]`, cancellation policy и restrictions. Поиск использует `calculateCanonicalRoomPricing` для actual rates/taxes [S7].

`GET /properties?limit=&offset=`: platform summary list, property credential singleton detail list. `GET /properties/:id`: full content `{sourcePropertyId,propertyName,propertyCode,description,starRating,address,contact,timezone,currencyCode,totalRooms,roomTypes,checkInTime,checkOutTime,guestInfo,policies}`. Ни rooms, ни price не создаются Studio [S2, S7].

### Accommodation booking/lifecycle

`POST /book` required body:

```json
{
  "propertyId": "<PMS-property-uuid>",
  "roomTypeId": "<from-search>",
  "ratePlanId": "<from-search>",
  "checkIn": "2026-11-01",
  "checkOut": "2026-11-03",
  "guestFirstName": "Тестовый",
  "adults": 1,
  "idempotencyKey": "<stable-operation-id>",
  "integrationContext": {
    "sourceSystem": "guestra_crm",
    "customerId": "<CRM-customer-id>",
    "requestId": "<CRM-request-id>",
    "offerId": "<CRM-offer-id>",
    "reservationId": "<CRM-reservation-mirror-id>",
    "conversationId": "<CRM-conversation-id>",
    "operationId": "<correlation-operation-id>"
  }
}
```

Optional fields: `guestLastName`, `guestEmail`, `guestPhone`, `loyaltyNumber`, `children`, `specialRequests`, `paymentMethod` (`pay_at_property|prepaid|virtual_card`), `paymentToken`, `agentId`, `externalReference`, `roomId`. Последний технически принимается, но гостевой агент должен продавать room category и не выбирать physical room. DTO делает `idempotencyKey` optional; Studio/n8n должны всегда передавать стабильный key. `integrationContext` optional, opaque to PMS, все идентификаторы строковые [S6].

Фактическая операция: lock inventory/category rooms, ownership/activity/occupancy/rate sellability, overlap recheck, deterministic internal room assignment; transaction создаёт guest/property link, booking, reservation `status:"assigned"`, primary reservation guest и correlation links [S8]. **Не создаёт folio и реальный payment**. Total рассчитывается `ratePlan.baseAmount * nights`, не тем canonical pricing, которым пользуется search. Это gap; сравнение цен должно происходить на PMS, не в Studio.

Первый ответ включает `success`, `confirmationNumber`, `bookingId`, `reservationId`, category IDs/names, dates/occupancy, `status:"assigned"`, `roomAssigned:true`, internal room ID/number, amount/currency/nightly breakdown/cancellation policy, `paymentStatus`, `depositAmount?`, `bookedAt`, `integrationContext`. Room number не выводить в обычный pre-arrival chat. **`paymentStatus:"authorized"` для prepaid/virtual_card сейчас вычисляется без gateway call: это не платёжный факт.**

При существующем property+key: одинаковый canonical body возвращает replay, изменённый — 409 `IDEMPOTENCY_CONFLICT`. Replay имеет сокращённый ответ, текущий reservation state и `integrationContext` из записи, включая внутренний fingerprint; нормализовать минимальный DTO и скрывать fingerprint. Replay не выдаёт `guestId` [S8]. Concurrent retry не имеет повторной receipt-проверки внутри transaction: unique constraint защищает от второй строки, но результат второго concurrent запроса может быть error, а не стабильный replay.

`GET /bookings/:confirmationNumber/verify` output: `{status,confirmationNumber,reservationId,guestName,checkIn,checkOut,roomType,rateAmount,currencyCode,roomAssigned,roomNumber?,folioExists,folioBalance?,lastModified,verifiedAt}`. Нет `guestId`, `bookingId`, `folioId`, полного payment state. Confirmation ownership выполняет guard [S4, S8].

`PATCH /bookings/:confirmationNumber` optional body: `guestFirstName`, `guestLastName`, `specialRequests`, `adults`, `children`, `checkIn`, `checkOut`, `roomTypeId`, `ratePlanId`. Output: `{success,confirmationNumber,reservationId,status,previousAmount,newAmount,costDifference,modifiedAt}`. **Нет idempotency/revision/quote token**, изменённая цена опять baseAmount*nights. Financial/inventory amendments нельзя считать эквивалентом transactional staff modification. После uncertain outcome — read-back, review; не слепой автоматический retry [S8].

`DELETE /bookings/:confirmationNumber` body `{reason?}`. Вызывает `ReservationService.cancel` и existing cancellation settlement. Output: `{cancelled,confirmationNumber,cancellationNumber,penaltyApplied,penaltyAmount,refundAmount,cancellationPolicy}`. Terminal reservation повторно отменить нельзя (400), ключ/revision не принимаются. `refundAmount` ответа — calculated reservation amount minus penalty, не квитанция refund gateway. Проверять actual payment/settlement отдельно [S8].

### Service-only и услуги проживания

| Endpoint | Payload / ответ |
| --- | --- |
| `GET /services?propertyId=` | Active catalog rows `{id,code,name,description,price,currencyCode,taxMode,agentBookingMode,durationMinutes}` |
| `POST /services/availability` | Required `propertyId,serviceId,startAt,endAt`; optional `guestId,quantity,participants` (positive integers, <=10000). Times с явным `Z`/offset, positive interval <=7 days. Response `{serviceId,serviceCode?,available,bookingMode,startAt?,endAt?,participants?,authoritativePrice?,currencyCode?,pricing?,code?}` |
| `POST /services/book` | Availability body + **required** nonempty `idempotencyKey` <=200; optional `expectedTotal:decimal string`, `reservationId`, guest names/email/phone, notes, integrationContext. Existing property-linked guestId или new service guest name. Response `{success,idempotentReplay,serviceBookingId,status,revision,serviceId,serviceCode,folioId,totalAmount:number,currencyCode}` |
| `GET /services/bookings/:id?propertyId=` | Safe detail `{serviceBookingId,serviceId,guestId,reservationId?,status,revision,startAt,endAt,participants,quantity,totalAmount:decimal string,currencyCode,folioId}` |
| `PATCH /services/bookings/:id` | Required `propertyId,idempotencyKey,expectedRevision>=1`; optional `startAt,endAt,participants`. DTO resourceId существует для staff, Connect его явно отклоняет 403 |
| `POST /services/bookings/:id/cancel` | Required `propertyId,idempotencyKey,expectedRevision`; releases capacity, financial review manual |

Service availability is not a hold. `quantity` определяет price; `participants` — capacity demand. Для льгот guest должен быть property-linked. Booking требует active `live_booking`, configured `taxMode:none|exclusive|inclusive`, подходящий resource/schedule/capacity. Expected total mismatch → 409 `PRICE_CHANGED` с полным rollback, включая guest/folio/charge [S9].

В service transaction сериализованы operation key и external customer identity, фиксируются accepted pricing/tax snapshot, allocation buffers, folio charge и durable outbox events. Для service-only создаётся `guest_property_links`, service booking и standalone folio; accommodation stay не придумывается. Для связанного проживания проверяются same property/guest и status `confirmed|assigned|checked_in|stayover|due_out`; переиспользуется compatible open folio. Service cancellation не reverse/refund и не no-show penalty. Move сохраняет duration/quantity/currency/accepted price/ledger и проверяет capacity/revision [S9].

Recovery/close операции существуют под staff `/api/v1/services/booking-request` и `/booking-request/close`, не Connect. Закрытие сериализовано с creation; 404 recovery сам по себе не разрешает бросить исходный operation key. Staff consumption `/services/consumption/quote` и `/consumption` требует `services.read` + `folios.manage`, actual `provided:true`, explicit property business date <=today и `postingRule:on_consumption`. Это staff financial operation, не guest-agent tool [S9, S17].

### Гостевые operational requests

`POST /guest-requests` required: `propertyId`, `guestId`, `type`, `title`, `idempotencyKey`. Optional: `reservationId`, `roomId`, `description`, `department`, `priority:0..3`, `integrationContext`. Types: `maintenance`, `turndown`, `deep_clean`, `checkout`, `stayover`, `inspection`, `service_request`, `housekeeping`, `late_checkout`, `early_checkin`, `extra_towel`, `extra_blanket`, `spa_booking`, `restaurant_request`, `transfer`, `breakfast`, `technical_problem`, `other` [S6].

Same-property ownership проверяется для guest/room/reservation. Статус `open`, source `ai_guest_agent`; это PMS request, не CRM lead. **Фактический response — serviceRequests row с `id`, а не обещанный `serviceRequestId` wrapper**. Replay добавляет `idempotentReplay`; row содержит внутренний integrationContext fingerprint. В событии `service_request.created` есть `data.serviceRequestId`. Нормализовать response.id; внутренние fields не попадут в guest chat. Fingerprint обычный JSON.stringify, чувствителен к порядку полей; проверки receipt и insert не в одной сериализованной transaction [S10].

## 5. Durable identity links

`integration_links` unique key: `(propertyId,sourceSystem,externalEntityType,externalEntityId)`; значения local entity type/UUID, opaque metadata. Accommodation mappings: customer→guest, request→booking, offer→booking, reservation→reservation, metadata conversationId/operationId. Service customer→guest, context.reservationId→service_reservation→service_booking. PMS не интерпретирует sales lifecycle [S8, S9, S16–S17].

Критичный дефект этого снимка: accommodation `findOrCreateGuest` делает `if (link?.localEntityType !== 'guest') throw IDENTITY_CONFLICT` до проверки наличия link. Для **нового** CRM customer absent link даёт conflict. Existing корректный link работает. У service resolver absent link допустим и новый guest/link создаётся transactionally. В Connect нет отдельного lookup/create link endpoint; staff create guest тоже не создаёт CRM integration link. Не обходить дефект удалением customerId или поиском по телефону — это уничтожит устойчивую identity [S8:622, S9:478].

При отсутствии integration context accommodation fallback может reuse email-match, если guest уже связан с property. У Studio профили независимы даже при одинаковом телефоне/email: PMS booking следует явному CRM customer link. Guest merges могут перенести integration links внутри PMS; Studio mapping должен принимать подтверждённую authoritative reconciliation, не сливать profiles по display data [S14].

## 6. Events, HMAC и reconciliation

Create subscription: `POST /subscriptions` body `{propertyId,subscriberId,subscriberName?,callbackUrl,events:string[],secret?}`. Callback URL требует safe HTTPS; повторно проверяется перед delivery, private/localhost/metadata addresses и redirects не допускаются. Для локальной песочницы нужен разрешённый reachable callback, не случайное ослабление URL guard. Secret optional в PMS, но sandbox receiver должен требовать configured HMAC secret и reject `unsigned` [S6, S11–S12].

Routes: `GET /subscriptions?propertyId=`, `DELETE /subscriptions/:id?propertyId=`, `POST /subscriptions/:id/test?propertyId=`, `GET /subscriptions/:id/deliveries?propertyId=&limit=`, `GET /events?propertyId=&since=<ISO>&types=<comma-patterns>&limit=`. Subscription responses redacted secret; runtime delivery rows содержат payload и diagnostics, требуют Inspector sanitization. Подписки property-scoped [S11].

Фактический HTTP delivery body:

```json
{
  "eventType": "service_booking.created",
  "propertyId": "<uuid>",
  "entityType": "service_booking",
  "entityId": "<uuid>",
  "data": { "serviceBookingId": "<uuid>", "schemaVersion": 1 },
  "timestamp": "<ISO datetime>"
}
```

`X-HAIP-Signature: sha256=<HMAC-SHA256(secret, exact JSON body bytes)>`, `X-HAIP-Event-Id: logicalEventId || deliveryId`, `X-HAIP-Event-Type: eventType`. Verify raw bytes **до** JSON parse; then dedup per event ID + property. Stable logical IDs у persisted outbox events, retained after retry; no guarantee of ordering. BullMQ+Redis queues/retry и `webhook_deliveries` дают durable attempts. Код: max 5 total attempts, initial backoff 30 seconds, exponential ×2 (30/60/120/240 seconds между оставшимися попытками), HTTP timeout 5 seconds. В старой `docs/webhooks.md` другое расписание (30s/2m/10m/1h/6h) — не использовать его как SLA [S12].

**`POST .../test` фактического HTTP не посылает**, только ставит `lastDeliveryStatus:test_logged`, хотя возвращает `testSent:true`. Readiness должно опираться на действительно полученный подписанный callback, не это поле [S11:126].

**Polling не является точным webhook transcript/cursor**: `pollEvents` читает последние audit rows по `occurredAt DESC`, `since` inclusive, фильтрует types после SQL limit, строит `type = entityType + '.' + action`. `WebhookService.emit` и outbox audit имеют `action:"create"` и `newValue` с nested actual `event`, поэтому row.type может быть `reservation.create`/`service_booking.create`; `types=reservation.*` совпадёт, exact `reservation.checked_in` — нет. Нет cursor, keyset pagination или stable common ID с webhook. Ограниченное окно может пропустить события при нагрузке. До PMS cursor API: bounded overlap polling, различать auditId/logicalEventId, нормализовать nested payload.event, read-back linked entities; не заявлять lossless reconciliation [S11–S12].

Accommodation Connect emits `connect.booking_created`, `connect.booking_modified`, `connect.booking_cancelled` после commit, а discovery advertising `reservation.created` не означает, что Connect book его излучит. Он напрямую insert reservation и не вызывает `ReservationService.create`. Для accommodation и guest requests emit/audit не в одной transaction, в отличие transactional service outbox. Подписка только `reservation.*` не покрывает `connect.booking_*` [S8, S10–S12].

## 7. Служебные API и реальные стадии сценария

Staff routes используют `Authorization: Bearer <Keycloak service-account JWT>`, audience/azp allow-list, `property_ids` membership и linked local user permissions. Для интеграции local principal создаёт PMS owner через `pnpm integration:link`; Studio не пишет таблицы users/roles [S5, S17]. Connect key не заменяет staff token.

| Операция | Route / exact body | Guard / verification |
| --- | --- | --- |
| New property guest | `POST /api/v1/guests?propertyId=` `{firstName,lastName,email?,phone?,...CreateGuestDto}` | `guests.write`; read-back `/guests/:id?propertyId=` |
| Pending reservation | `POST /api/v1/reservations` `{propertyId,guestId,arrivalDate,departureDate,roomTypeId,ratePlanId,totalAmount:decimal-string,currencyCode,source,adults?,children?,specialRequests?,channelCode?,externalConfirmation?}` | `reservations.write`; source enum direct/ota/gds/phone/walk_in/agent/group/corporate. Staff amount должен прийти из PMS quote/setup fixture, не Studio pricing |
| Confirm | `PATCH /reservations/:id/confirm?propertyId=` no body | `reservations.write`, pending→confirmed |
| Assign room | `PATCH /reservations/:id/assign-room?propertyId=` `{roomId}` | `reservations.write`, confirmed→assigned, PMS availability/room checks |
| Check-in | `PATCH /reservations/:id/check-in?propertyId=` CheckInDto: `registrationSigned?`, ID fields, registrationData, deposit token/provider, skipDepositAuth?, room override? | `reservations.write`, actual PMS policies/room checks; output `{reservation,folio,depositAuth}` |
| Check-out | `PATCH /reservations/:id/check-out?propertyId=` `{expressCheckout?,sendReceiptEmail?,receiptEmail?,lateCheckoutFee?,notes?}` | `reservations.write`; folio balance checks, settlement, checkout side effects |
| Read reservation | `GET /reservations/:id?propertyId=` | Envelope `{reservation,guest,roomType,ratePlan,room,confirmationNumber}`, **не** `{data}` |
| Create folio | `POST /api/v1/folios` `{propertyId,guestId,type:"guest|master|city_ledger",currencyCode,reservationId?,bookingId?,...}` | `folios.manage`; staff create reservation уже делает auto-folio; Connect book пока не делает |
| Record actual tender | `POST /api/v1/payments` `{propertyId,folioId,method,amount:positive-decimal-string,currencyCode,gatewayTransactionId?,processedAt?,...}` | `folios.manage`; methods credit_card/debit_card/cash/bank_transfer/pix/city_ledger/vcc/other. Только authorized fixture/mock tender, не выдуманная оплата |
| Gateway auth/capture | `POST /payments/authorize` `{propertyId,folioId,amount,currencyCode,gatewayProvider,gatewayPaymentToken,...}`; `POST /payments/:id/capture?propertyId=` | `folios.manage`; mock/test gateway required для scenario |
| Verify finances | `GET /payments/:id?propertyId=`, `/payments?propertyId=...`, `/folios/:id?propertyId=`, `/folios/:id/context?propertyId=` | JWT/property, context/list folio require `folios.read`. Refund/void требуют `payments.refund` |

Lifecycle по фактической state machine: pending→confirmed→assigned→checked_in→stayover→due_out→checked_out; pending/confirmed/assigned cancellation, confirmed/assigned no_show; terminal states immutable. Business stage `pre_arrival` выводится из confirmed/assigned; `in_house` из checked_in/stayover (due_out отдельно); post_stay из checked_out [S13, S17]. Нельзя PATCH общий reservation status из Studio. Check-in/check-out могут создать финансовые, housekeeping, door-access и messaging consequences: sandbox должен изолировать также эти integrations.

### Scenario setup readiness matrix

| Stage Studio | Authoritative requirement | Реально доступно / setup result |
| --- | --- | --- |
| Unknown / known customer | CRM simulator identity/conversation | PMS setup не нужен; CRM adapter отвечает за стадию |
| Commercial request / Enquire / Tentative / Definite | CRM request/offer lifecycle | Не подменять PMS pending этими sales states; CRM owner |
| Payment-ready / pending payment | CRM commercial state + verified sandbox payment-link/provider state | Connect не имеет payment-link creation API; required provider отсутствует → `SETUP_UNAVAILABLE` |
| Confirmed reservation / pre-arrival | PMS assigned/confirmed reservation linked to virtual CRM customer, dates и amounts verified | Existing fixture+confirmation можно verify; new Connect book с новым CRM link сейчас blocked gap G1 |
| In-house | PMS checked_in/stayover + linked guest/stay/folio | Staff/setup provider выполняет допустимый lifecycle, затем read-back. Connect-only → `SETUP_UNAVAILABLE` |
| Service-only guest | PMS property guest link + service booking, optional folio/payment факт | Connect services/book available при configured catalog/resource/tax policy/credentials; existing fixture safer for scenario setup |
| Post-stay | PMS checked_out и фактический folio/payment settlement | Staff/setup provider + balances + read-back. Connect-only → `SETUP_UNAVAILABLE` |
| Returning guest | Existing stable CRM identity + verified previous PMS link/stay | Select explicit fixture mapping; не phone/email merge, не invent past stay |

### Предлагаемый fixture adapter (не существующий PMS endpoint)

Studio interface: `prepareScenario({environmentId,scenarioId,setupOperationId,stage,propertyId,virtualIdentityId,crmCustomerId}) -> {status:"READY"|"SETUP_UNAVAILABLE"|"FAILED",reason?,evidence?,links?}`. `SETUP_UNAVAILABLE` сохраняется и отображается; успешное создание чата не подделывает setup success. `evidence` включает authoritative URLs/IDs, observed state/time, contractVersion/commit; credentials не сохраняются в evidence.

PMS-owned provider может быть controlled CLI fixtures в выделенной БД, утверждённый staff API orchestrator или будущий sandbox-only API. Ни n8n, ни Studio не получают прямой DB access. Fixture namespace по environment/scenario/operation; idempotent receipt; dedicated test property; cleanup только явно отмеченных fixture IDs, не массовое удаление tenant. Предварительно подготовить rate/category/room inventory, service tax policy/resource/calendar и mock gateway. Имена, email/phone синтетические; notifications и locks sandbox-only.

Минимальные fixtures: (1) first-time customer, (2) linked customer future assigned stay, (3) current checked_in stay с folio, (4) service-only customer без reservation, (5) checked_out settled stay, (6) returning customer того же stable link, (7) same phone/email у двух независимых virtual profiles, (8) foreign property inaccessible, (9) exhausted room/service capacity, (10) accepted service quote changed before commit, (11) ambiguous timeout/retry with same operation key, (12) failed callback/redelivery. Даты считаются в **timezone PMS property**, а не timezone Studio host. Eligibility/policies определяет PMS.

## 8. Gap analysis и ответственность

| ID / priority | Existing → expected | Owner / required change | Compatibility / Studio behavior | Required test |
| --- | --- | --- | --- | --- |
| G1 P0 sandbox | Absent CRM customer link в Connect book получает IDENTITY_CONFLICT → first booking creates guest/link | PMS: проверять wrong type только для существующего link; serialize same external identity | Не удалять customerId для обхода; new linked accommodation setup unavailable | New customer with context creates exactly one guest/link; concurrent same customer; stale/wrong-type link rejected |
| G2 P0 financial truth | Prepaid/virtual_card response says authorized без payment → truthful payment facts | PMS: real payment orchestration или удалить/переименовать synthetic field, document provenance | Studio не подтверждает оплату на основании поля Connect | Gateway not called ⇒ no authorized fact; real mock auth/payment row/receipt read-back |
| G3 P1 authoritative pricing | Search canonical daily/tax quote; book/modify base*nights → same canonical accepted quote with stale-price rejection | PMS: reuse canonical pricing, quote/expectedTotal + accepted snapshot | Не добавлять pricing engine в Studio; treat mismatch as integration failure/review | Daily overrides, inclusive/exclusive taxes, quote changes, replay freezes accepted amount |
| G4 P1 retry | Accommodation key optional, check outside transaction; modify/cancel no receipt/revision → safe repeated mutation | PMS: operation lock + receipt recheck, scoped key for modify/cancel + revision | Version contract/feature flags; unknown DTO fields 400. Disable auto replay unsafe writes | Concurrent same-key one receipt, changed payload 409, timeout recovery, revision race |
| G5 P1 setup | Staff lifecycle exists; no sandbox fixture API/identity link setup → explicit isolated setup contract | PMS/CRM owners; Studio setup interface + eligibility/read-back | Keep `SETUP_UNAVAILABLE` until provider configured; fixture contract is proposal | Environment gate rejects production; fixture idempotency, lifecycle/settlement proof, cleanup isolation |
| G6 P1 least privilege | service scopes enforce; other tools legacy-wide → declared per-tool grants + property principal discovery | PMS auth/contract owner | Additive discovery/version marker; retain documented legacy compatibility, explicitly migrate credentials | Marker-only deny; read-only service deny writes; booking/request/event scopes; property guard all routes |
| G7 P1 events | Service outbox durable; accommodation/request emit after commit → transactional event/audit consistency | PMS | Consumers accept actual connect.booking_* until canonical versioned events deployed | Process crash after commit, delivery queue failure, retry keeps logical ID, no missing domain event |
| G8 P1 reconciliation | `/events` audit-derived types, newest-window, no cursor → lossless keyset event cursor with canonical event/logical ID | PMS | Gateway must expose limited polling capability; never promise full reconciliation | >limit events, timestamp ties, type filters before pagination, webhook/poll dedup |
| G9 P1 webhook readiness | testSent true but no HTTP → real signed test callback with receipt | PMS | Readiness false until actual receiver proof; test field legacy-compatible note insufficient | Expected callback received, invalid secret rejected, private URL denied, retry failure inspectable |
| G10 P2 discovery | Static flags/tools, omitted get_property/create_guest_request → principal-filtered tools/environment/property metadata | PMS; Gateway stores explicit attestation | Capability allow-list intersection; document static claims, unknown tools unavailable | Scoped credentials produce correct discovery; endpoints advertised match controllers |
| G11 P2 response hygiene | guest-request raw row/id + internal fingerprint; booking replay exposes fingerprint → safe external DTO/stable IDs | PMS; Gateway normalize/sanitize now | Normalize request `id` as serviceRequestId; filter internal context and guest/financial data | Same safe shape first/replay; no notes/resource IDs/key fingerprints leaked |
| G12 P2 guest references | Accommodation book/verify omit guestId, no integration link lookup → safe linked entity lookup/snapshot | PMS | Do not infer guest by phone; use approved setup evidence; service detail guestId only within scoped booking | Stable mapping after first booking/merge, foreign property denied, read-back guest request |
| G13 P2 contract/docs | v1 prose implies all mutations idempotent; JSON narrower; retry docs differ → exact source-derived contract | PMS docs owner | Studio retains this audit snapshot + detects contract drift; no PMS files modified here | Controller/DTO-to-contract assertions including status/envelope/event patterns |

G1–G3 особенно важны до проведения полного customer journey. Они не устраняются UI-состояниями Studio. Все proposed PMS changes остаются в его backlog; этот аудит не вмешивается в M3/M4.

## 9. Проверки перед подключением Sandbox

Уже существующие PMS tests, просмотренные как источники (не запускались):

- `auth/api-key.guard.spec.ts`, `connect-scope.guard.spec.ts`, `property-scope.guard.spec.ts`: revocation, property/confirmation denial, non-scalar propertyId.
- `connect/connect-booking.service.spec.ts`, `connect-booking-fk-ownership.spec.ts`, `reservation/pms-operations.postgres.spec.ts`: category assignment, inventory/same-property FK, booking lifecycle.
- `connect/service-operations.postgres.spec.ts`, `.http.spec.ts`, `service-capacity.spec.ts`, `service-schedule.spec.ts`: concurrent idempotency/capacity, tax/expectedTotal rollback, accepted-price move/cancel, outbox failure, safe detail, identity serialization, service-only Guest 360.
- `connect/connect-events.service.spec.ts`, `webhook/webhook-delivery.service.spec.ts` и outbox implementation: HMAC/property delivery/retry behavior. Наличие test file не утверждает, что все gaps покрыты или suite сейчас проходит.

Studio contract checks должны подтвердить base path/header, raw response envelopes, context field forwarding, safe payload normalization, unknown fields rejected, timestamp/decimal handling, property pinning и capability intersection. Успех Live Sandbox допускается только после разрешённых endpoint URL/credentials/environment, CRM transcript discovery и real n8n execution, подтверждённых PMS setup evidence/read-back, signed callback и выбранной стратегии reconciliation. До этого Local Preview остаётся preview, а CRM Connected не изображает PMS-connected agent.
