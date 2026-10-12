# CRM integration audit

Audit date: 2026-10-13. Read-only review of `C:\paterhaus\guestra_crm`.

Local `.git/HEAD` points to `main`; `.git/refs/heads/main` contains
`b9625b49544e19511036119266ad1c9f663a1cb0`. All line references below describe the
local files actually read. Git status was unavailable under the sandbox, so this
audit does not assert that the checkout is clean. CRM files were not changed,
CRM tests were not executed, and no external CRM or n8n instance was contacted.

## Authority decision

The target platform must follow the user-approved ownership model: CRM owns
customer identity, channel identity, durable conversation/messages, commercial
requests/offers, sales lifecycle and handoff. PMS owns inventory, availability,
rates, reservations, operational services/guest requests, folios and payment
facts. Studio stores test objects, mappings, attempts, runs, annotations and
limited read-only transcript snapshots. n8n orchestrates authorized API calls.

The existing CRM is significantly broader than this target. Its operational
tables/services are functional local implementations, not delegates to PMS.
`docs/crm-pms-authority-boundary.md:15` assigns service catalog/bookings, guest
requests and commercial folios to CRM. Those declarations conflict with the
target and must not be copied into Studio.

## Existing HTTP contract, verified in code

Base: `/api/integrations/agent`, mounted in `server/app.ts:21`.

Authentication: `x-crm-api-key: <CRM_INTEGRATION_API_KEY>`;
constant-time comparison in `server/routes/agent.ts:138`. The same server secret
also protects `/api/integrations/ai`. It has no per-environment, per-property or
read-only scopes. `server/config.ts:6` requires at least 16 characters. The
session middleware is non-blocking for these endpoints; CRM staff endpoints
under `/api/crm` instead require an authenticated database-mode user
(`server/routes/crm.ts:117`, `server/auth/middleware.ts:25`). No browser should
receive the integration key.

Read-only health: `GET /api/health` returns `{status:"ok"}`
(`server/app.ts:23`); it does not prove database readiness, sandbox status or
property authorization.

### Capability discovery

`GET /capabilities` returns `contractVersion:"agent-api-v1"`,
`supportedChannels`, `supportedMessageTypes`, `supportedAttachmentKinds`,
`attachmentProcessingStates`, `supportedTools`, `toolDescriptors`, lifecycle and
booking-mode arrays, confirmation policy and feature flags
(`server/routes/agent.ts:148`). Channels are `telegram`, `whatsapp`, `instagram`,
`simulator`. `agentTrace:true` means rows are recorded; it does not mean a trace
read API exists. `mediaAttachments:true` means inbound metadata is supported;
it does not mean outbound binaries or media downloads work.

### Identity and conversation scope

`server/contracts/agent-contract.ts:79` defines shared fields:

```ts
IdentityScope = { channel?: "telegram" | "whatsapp" | "instagram" | "simulator";
  externalUserId: string; propertyId: string };
ConversationScope = IdentityScope & { conversationId: string };
OptionalConversationScope = IdentityScope & {
  conversationId?: string; externalChatId?: string };
```

Always send `channel:"simulator"` explicitly. The default is `telegram` for
older integrations. Strings are trimmed and nonempty. Identity uniqueness is
global `(channel,externalUserId)`, not property- or organization-scoped
(`server/db/schema.ts:106`). Customer IDs derive from SHA-256 of
`channel + NUL + externalUserId` (`server/services/customer-service.ts:61`).
The resolver verifies the existing customer's organization against the
property; it never merges by phone or email on inbound. Studio identifiers must
therefore include an unguessable workspace/environment/client/identity
namespace, with different stable IDs for each visual identity.

Conversation uniqueness is `(channel,propertyId,guestId,externalChatId)`
(`server/db/schema.ts:448`). Multiple chats of one identity require distinct
stable `externalChatId` values. Identity-scoped requests with `conversationId`
verify customer/property/channel; if omitted, `/context` may select the latest
chat, so Studio must always send an explicit chat or conversation reference.

### Inbound

`POST /messages/inbound` (`server/routes/agent.ts:173`, schema
`server/contracts/agent-contract.ts:107`):

```json
{
  "channel": "simulator",
  "propertyId": "les_borovoe",
  "externalUserId": "studio:<workspace>:<environment>:<identity>",
  "externalChatId": "studio:<workspace>:<environment>:<conversation>",
  "externalMessageId": "studio:<attempt-stable-message-id>",
  "externalUpdateId": "studio:<attempt-stable-event-id>",
  "displayName": "Тестовый гость",
  "firstName": "Айдана",
  "language": "ru",
  "text": "Здравствуйте! Какие варианты есть на выходные?",
  "attachments": []
}
```

Optional contact fields: `username`, `firstName`, `lastName`, `displayName`,
`phone`, `email`, `language` (2–12 characters). Text is optional, max 10,000;
nonempty text or at least one attachment is required. Attachments max 10.
Provider phone/email are stored in message metadata; inbound intentionally does
not write them to the customer or merge profiles (`agent.ts:227`, `agent.ts:264`).

First response is HTTP 201; exact duplicate is HTTP 200:

```ts
{ duplicate: boolean; messageId: string | null;
  context: { contractVersion: "agent-api-v1";
    conversation: { id: string; channel: string; automationMode: string; /* … */ };
    customer: { id: string; /* … */ }; lifecycle: string; /* … */ } | null;
  aiReplyAllowed: boolean; allowedActions: string[] }
```

Persist `context.conversation.id` and `messageId` atomically with the Studio
attempt. Never infer delivered status from a webhook HTTP acceptance alone.
Inbound is saved by one component only: Gateway in CRM Connected mode, n8n in
End-to-End Sandbox mode.

Inbound deduplication uses message key
`${channel}:${externalChatId}:${externalUserId}:${externalMessageId}` and event
key `(channel,"agent_inbound_message",externalUpdateId ?? messageKey)`
(`agent.ts:175`). `externalUpdateId` is global within a channel/provider, so it
must be namespaced too. Event hashing uses JSON of parsed input; message hashing
uses normalized identity/property/text/attachments. Changed reuse yields HTTP
409 `IDEMPOTENCY_CONFLICT`; one race response is marked `retryable:true`
(`agent.ts:289`). Retries must replay a stable full payload and IDs.

### Context and transcript

`POST /context` accepts `OptionalConversationScope` and returns context directly
(`agent.ts:298`). `GET /conversations/:id/messages` requires query `channel`,
`propertyId`, `externalUserId`, optional `after=<messageId>` and `limit`
(integer 1–200, default 50; schema `agent-contract.ts:175`). Returns:

```ts
{ conversationId: string; nextCursor: string | null;
  messages: Array<{ id: string; direction: string; senderType: string;
    text: string; at: string; deliveryStatus: string;
    externalMessageId: string | null;
    attachments: Array<{ id: string; kind: string; mimeType: string | null;
      fileName: string | null; fileSize: number | null; durationMs: number | null;
      processingStatus: string; transcript?: string }> }> }
```

Ordering is ascending `(sentAt,id)`, and `after` is resolved only in the same
conversation (`agent.ts:1296`). `nextCursor` is nonnull only when more than
`limit` rows were fetched; a drained page still needs a local watermark of its
last row. Missing cursor returns 404 `MESSAGE_NOT_FOUND`.

Two material limitations must be handled:

1. Transcript includes internal `direction:"note"` records, since the query
   does not filter direction (`agent.ts:1295`); CRM notes are persisted by
   `crm.ts:1301`. Studio's guest view must allow only `in`/`out`, and n8n must
   exclude notes from guest input. Context `recentMessages` also lacks this
   filter (`agent-context-service.ts:233`). CRM needs a guest-safe endpoint/filter.
2. `sentAt` changes on outbound success (`agent.ts:1265`) and attachment/status
   changes have no change cursor. Watermark-only polling can miss updates or
   reorder messages. Merge snapshots by CRM message ID, reconcile a historical
   window, and request immutable sequence plus change cursor in the next phase.

### Outbound and handoff

`POST /messages/outbound/prepare` accepts `ConversationScope`, nonempty `text`
(max 10,000), `idempotencyKey` (max 120), optional `proposedAction`
(`agent-contract.ts:206`, `agent.ts:1098`). It creates a durable AI message with
`deliveryStatus:"pending"`. Result:

```ts
{ messageId: string; conversationId: string; externalChatId?: string;
  text: string; deliveryStatus: string; proposedAction: object | null;
  duplicate: boolean }
```

The key is `agent-ai:<customer>:<property>:<input.idempotencyKey>`; it is not
conversation-scoped, so include the conversation and inbound ID in the supplied
key. Identical prepare retries return the existing row; changed text/proposal or
conversation returns 409. It accepts text only: no attachments field is saved.

**Documentation discrepancy:** `docs/agent-api-v1.md:38` implies simulator
prepare is automatically marked sent. Actual `agent.ts:1213` only inserts
pending and does not call `sendConversationMessage`. The existing simulator test
explicitly calls that internal service (`server/agent-channels.test.ts:110`).
The public n8n simulator path must report successful local delivery through
`/messages/outbound/result`; do not assume it is automatic.

`POST /messages/outbound/result` accepts `ConversationScope`, `messageId`, same
`idempotencyKey`, `success:boolean`, `externalMessageId` required on success,
optional `error` max 1,000 (`agent-contract.ts:209`, `agent.ts:1234`). Successful
simulator receipts may use `simulator:<CRM message ID>`. Result:

```ts
{ messageId: string; deliveryStatus: "sent" | "failed"; duplicate: boolean;
  code?: "DELIVERY_FAILED"; retryable?: true; deliveryError?: string }
```

Repeated matching success returns duplicate; conflicting confirmed delivery
returns 409. Failure is HTTP 200 with `DELIVERY_FAILED` and `retryable:true`;
adapter logic must inspect body, not HTTP status alone. Pending/failed outbound
is excluded from context recentMessages, but is present in transcript.

CRM staff/system transport is a separate path. Simulator dispatch is local and
sets `sent` with `simulator:<messageId>` (`outbound-messaging.ts:48`). Telegram
and WhatsApp POST `{event,idempotencyKey,messageId,conversationId,propertyId,
channel,externalChatId,text,senderType}` with `x-agent-webhook-token`, 12s timeout;
success requires HTTP success plus `{ok:true,externalMessageId}`
(`outbound-messaging.ts:24`). Human delivery is recorded directly by that
service; Agent API result accepts AI rows only (`agent.ts:1247`), so the docs'
statement that all human replies use result is not literally true.

`POST /handoff` accepts `ConversationScope`, `reasonCode` in
`custom_discount|refund_or_payment_issue|complaint_or_conflict|uncertain_intent|
unavailable_nonstandard_solution|corporate_or_event_complex|
guest_requested_human|unsupported_action`, optional `summary`, `requestedAction`,
`priority` in `low|medium|high|urgent` (default medium)
(`agent-contract.ts:228`). Sets `needs_human`; repeated same reason returns
duplicate (`agent.ts:887`). `payment_ready` is set internally by request lifecycle,
not accepted as a `/handoff` reason. Context then returns `aiReplyAllowed:false`
and `allowedActions:[]`. Outbound allows one acknowledgement after handoff and
no new proposal (`agent.ts:1121`). Takeover/resume require CRM staff endpoints,
not Studio business controls (`crm.ts:1326`, `crm.ts:1336`).

### Media

Inbound attachment shape (`agent-contract.ts:94`):

```ts
{ kind: "image" | "document" | "audio" | "video" | "other";
  mimeType?: string; fileName?: string; fileSize?: number;
  externalFileId?: string; storageProvider?: string; storageKey?: string;
  durationMs?: number; metadata?: Record<string, unknown> }
```

No binaries, URLs or authorized downloads are implemented by CRM. Metadata is
persisted in `message_attachments` (`schema.ts:1089`, migration
`drizzle/0014_channel_neutral_agent_hub.sql:17`). `storageKey` means initially
`ready`, otherwise `received` (`agent.ts:280`). Context and transcript omit
`externalFileId`, `storageProvider`, `storageKey`, and arbitrary metadata; Studio
must maintain its own message/asset mappings and resolve signed links server-side.

`POST /messages/:messageId/attachments/:attachmentId/process-result` accepts
`propertyId`, `idempotencyKey`, `processingStatus:processing|ready|failed`, optional
`transcript` max 50,000, `storageProvider`, `storageKey`, `durationMs`, `metadata`
(`agent-contract.ts:177`). Scope is property + message + attachment, not channel
identity (`agent.ts:1478`). Ready audio transcripts become text in recent context.
No STT implementation is supplied by this route.

Outbound prepare has no attachment support. CRM Inbox only renders legacy
`attachmentName` (`src/pages/Inbox.tsx:567`) and its store sends text/asNote
(`src/store/crm-store.tsx:1488`). Outbound agent images/documents require a new
CRM contract and transport implementation; they must stay unavailable in
connected Studio until discovered and tested.

## Commercial, reservation and payment overlap

| Existing operation | Code evidence | Target integration behavior |
|---|---|---|
| `/requests/upsert` writes commercial lead, classification/interests and conversation link | `agent.ts:396`; `agent-contract.ts:136` | Keep CRM ownership. Supply explicit conversation and stable namespaced key. |
| `/requests/lifecycle` accepts enquire/tentative/definite/lost/closed; tentative creates follow-up, definite pauses AI for payment link | `agent.ts:501`, `agent.ts:555`; `agent-contract.ts:150` | Keep sales lifecycle. Definite is guest intent, not payment or confirmed reservation. |
| Accommodation options/availability read local categories/units/rates | `agent.ts:324`, `agent.ts:344`; `services/availability-service.ts` | Delegate reads to PMS availability and rates; preserve category-only guest presentation. |
| `/offers/create` calculates `rate.defaultPrice * nights` from CRM service catalog and writes operational folio line | `services/agent-offer-service.ts:53`, `:63`, `:78` | CRM stores offer using PMS quote/rate source, expiry and version; no independent operational folio. |
| `/accommodations/book` calls CRM reservation transaction, assigns physical unit, provisions stay/folio and payment request | `agent.ts:789`; `services/reservation-service.ts:72`, `:83`, `:89`, `:118` | PMS alone creates reservation/hold/charge. CRM projects resulting IDs and accepted commercial state. |
| External `/api/integrations/ai/bookings/confirm` creates a confirmed CRM reservation with external ID | `routes/integrations.ts:78`, `:236`; `reservation-service.ts:233`, `:279` | Convert to idempotent verified PMS event projection. Add request/offer/conversation/mapping reference instead of selecting any active lead. |
| `/services/book`, cancel/reschedule allocate CRM resources and write CRM folio | `agent.ts:649`, `:700`, `:737`; `service-reservation-service.ts:113`, `:150`, `:158`, `:166` | PMS operational ServiceBooking and folio charge; CRM stores commercial/reference projection. |
| Service-only folio linking can move a CRM line into reservation folio | `service-reservation-service.ts:245` | PMS owns transfer/link/charge transaction; sync PMS IDs and event versions. |
| `/guest-requests` creates local operational CRM task tied to stay/room | `agent.ts:814`, `:856` | PMS creates/assigns/fulfills operational guest request; CRM retains communication reference. |
| `/stays/extension/preview` derives rate from CRM folio, `/stays/extend` changes stay/reservation/charge | `agent.ts:99`, `:1520`, `:1541`; `stay-service.ts:114` | PMS previews and commits extension under live availability/price guard. |
| Staff payment receipt inserts payment and confirms local reservation, re-enables AI | `payment-service.ts:14`, `:37`, `:45`, `:55` | PMS payment fact/event owns confirmation and financial totals; CRM projects it. |

External confirmation payload currently requires `channel`, `externalUserId`,
`propertyId`, `confirmationNumber`, `reservationId` (external PMS ID), `roomType`,
`checkIn`, `checkOut`, `adults`, `children`, `grandTotal`, `currency:"KZT"`, optional
CRM `roomId` (`integrations.ts:78`). Returns `{guestId,leadId,leadCode,reservationId,
stayId,confirmationNumber,stage,bookingReference,duplicate}`; returned reservation
ID is CRM local ID. Unique indices preserve `(property,externalReservationId)` and
`(property,externalConfirmationNumber)` (`schema.ts:582`). It creates folio
adjustment lines and selects one nonterminal active request without an explicit
request reference (`reservation-service.ts:259`, `:305`), so it is insufficient
for parallel chats or authoritative event replay.

Protected actions are correctly bound to a sent proposal and later explicit
contact confirmation, same conversation, exact hashed payload, 30-minute expiry,
one use (`services/agent-action-service.ts:24`). Preserve this authorization model
while migrating business execution to PMS. The transactional action's actual
idempotency is proposal/confirmation based, not merely the caller's supplied key.
No Studio action may bypass this by calling a staff operation.

Identity verification is booking-reference plus normalized phone, excludes
cancelled/no-show reservations, and requires exactly one matched booker or
participant. Five attempts in ten minutes request staff review. Merging is only
allowed for a clean single-identity stub with no commercial/financial/operational
records (`agent.ts:939`, `:989`, `:1049`). Returning guests require controlled
mapping/verification against sandbox PMS projections; phone coincidence alone
is never sufficient. Verification may change conversation/customer IDs, which
Studio must reconcile from the response.

## n8n workflow audit

`integrations/n8n/guestra-crm-telegram-agent.workflow.json` is a Telegram-specific
workflow, not a Studio webhook or PMS-connected workflow. It ingests exactly once
in CRM, stops duplicate and human-owned executions, constructs trusted identity
and message IDs, supplies context to a structured-output agent, persists reply,
sends through Telegram, and reports success/failure. Credential references are
names, not embedded secrets.

Evidence: normalization line 18; ingest line 53; duplicate/AI guards lines 69/81;
trusted IDs line 91; system prompt line 110; reply prepare line 143; delivery
success/failure lines 162/171; human webhook line 179; business tools lines
254–330. It substitutes `[unsupported_media]` instead of forwarding attachments
(line 18), has no Studio/simulator trigger, no Studio run correlation callbacks,
no prompt-version snapshot, no PMS API calls, and no tool nodes for the newer
request lifecycle/profile/memory tools. Tools are attached as a fixed catalog;
allowedActions enforcement is primarily prompt/backend validation rather than
dynamic tool allowlisting. Recovery cannot simply rerun ingestion, because its
duplicate branch stops even if the first execution failed after inbound commit.

The new Studio workflow must accept the gateway envelope, ingest via the same
CRM route using `simulator`, report durable stages/run IDs, confirm local outbound
through result, recover by run/idempotency state, and route PMS tools only after
the ownership migration. Credentials and workflow publication stay server-side.

## Gap register for the next integration pass

Every row lists existing behavior, expected behavior, owner/change,
compatibility and required tests. Proposed endpoints are design requirements,
not claims that they exist today.

| Gap | Existing behavior and source | Expected behavior / required change | Owner | Compatibility | Tests required |
|---|---|---|---|---|---|
| G01 Business authority | Local operational CRM services; authority doc assigns services/folio to CRM (`crm-pms-authority-boundary.md:15`; source table above) | Explicit feature-gated delegate/projection mode; inventory/rates/reservations/services/folio/payment facts from PMS | CRM + PMS | Preserve local historical rows and legacy deployments; separate IDs and source/version; never dual-write | Same booking/service/payment replay; conflict/timeout recovery; no CRM operational write when PMS mode active |
| G02 Request/offer to reservation | Confirmation finds an arbitrary active lead (`reservation-service.ts:259`) | PMS command carries CRM request/offer/conversation references, PMS quote ID/hash, property/guest mappings; event links exact request and accepted offer | CRM + PMS + n8n | Keep old confirm payload for legacy callers behind explicit mode; new version rejects ambiguous link | Two chats, two requests, out-of-order confirmations, quote expiry/change |
| G03 Service/folio sync | CRM service books local resources/charge and can merge lines (`service-reservation-service.ts:158`, `:245`) | PMS ServiceBooking ID, charge ID, folio ID and version projection; service-only guest supported by real PMS API | CRM + PMS | Existing CRM service records retain source; migration maps once without duplicate charges | Reserve/cancel/reschedule/replay; paid service transfer; charge cancellation and entitlement |
| G04 Payment authority | CRM staff receipt confirms CRM reservation (`payment-service.ts:45`) | Payment-ready intent stays CRM; pending/settled/refunded facts from authenticated PMS/provider events; payment link issued by approved owner | CRM + PMS | Keep sales state distinct from payment fact; provider reference unique; amounts and currency from PMS | Duplicate callbacks, partial payment, hold expiry, refund, payment arriving before reservation event |
| G05 Property mapping | CRM IDs are opaque strings such as `les_borovoe`; no PMS mapping table found in schema | Explicit environment-scoped CRM property ↔ PMS UUID mapping, tested guards | Studio integration config + CRM/PMS integration links | Never guess UUID from hotel display name; missing mapping blocks setup/tools | Wrong property/environment/organization; disabled mapping |
| G06 Customer ↔ Guest mapping | CRM globally unique channel identity; no PMS guest mapping found (`schema.ts:106`) | Verified environment-scoped CRM customer ↔ PMS guest UUID integration link; provenance and role | CRM + PMS | Studio holds references only; phone/email candidates require verification | Returning guest, stub collision, booker/participant privacy, cross-channel profiles |
| G07 PMS event consumer | Only legacy booking-confirm mutation observed; no PMS event lifecycle consumer in server sources | Signed/authenticated delivery, event ID/version deduplication, links/projection updates and replay API | CRM + PMS | Handle at-least-once delivery, schema versions, out-of-order versions; no upstream command loop | reservation held/confirmed/changed/cancelled; check-in/out/no-show; service and folio/payment changes |
| G08 Guest-safe transcript | Transcript/context expose staff notes (`agent.ts:1295`; `agent-context-service.ts:233`) | Guest endpoint excludes notes/internal content and safely exposes only committed outbound; Studio immediate filter | CRM + Studio + n8n | Do not break staff Inbox; optional audience contract/version | Note never reaches guest UI/LLM; pending/failed outbound stays honest |
| G09 Durable change cursor | Ordering uses mutable sentAt; no attachment/status change feed (`agent.ts:1265`, `:1296`) | Immutable per-conversation sequence plus update/change cursor; revision-aware transcript | CRM | Retain `after` v1; add new optional change cursor; Studio merges by ID and reconciles history | Equal timestamps, out-of-order result, pending→failed→sent, async STT, reconnect, deleted/merged cursor |
| G10 Outbound media | Text-only prepare and transport (`agent-contract.ts:206`; `outbound-messaging.ts:24`) | Metadata-only outbound attachments, authorized asset references, text-or-media validation, per-channel capability and delivery | CRM + n8n + Studio media | Additive optional fields; reject unsupported media, no silent text fallback | Photo/PDF/audio/video; expired signed URLs; denied download; delivery failure and retry |
| G11 Media retrieval | Transcript omits storage reference; binary service absent (`agent.ts:1319`) | Authorized media reference/resolve contract with stable asset IDs; Studio signed URL service and n8n fetch token | CRM + Studio | Do not expose permanent storage keys or secrets; sanitize metadata | Workspace isolation, retention expiry, scan quarantine, URL expiry, STT update |
| G12 Inspector | `agent_tool_events` stores sanitized status/duration only; no read route (`agent-tool-trace.ts:84`) | Property/identity-scoped read-only trace API with cursor and run/correlation ID; n8n safe execution summaries | CRM + n8n + Studio | Preserve v1 tool events; add nullable correlation columns; no reasoning/secrets/raw payment tokens | Scope denial, failure trace, redaction, correlated replay, duplicate events |
| G13 Sandbox lifecycle setup | Agent API has domain writes, not isolated fixture/setup endpoints; no arbitrary stay-state endpoint | Explicit test-only setup adapter/fixture receipt with real CRM/PMS IDs and teardown; `SETUP_UNAVAILABLE` until enabled | CRM + PMS + Studio | Fail closed for production or unknown environment; no local lifecycle flag assertion | All journey stages, fixture rollback/replay, wrong environment, actual state assertions |
| G14 Auth scopes | One global key, capability lacks environment marker (`agent.ts:140`, `:148`) | Per-integration property/environment grants, read-only scopes, sandbox identity marker, rotation/revocation | CRM | Accept legacy key only for legacy deployments; new scopes additive/versioned | Wrong property, read-only mutation, revoked key, production URL blocked by Studio |
| G15 Simulator receipt docs | Prepare leaves pending; internal test manually dispatches (`agent.ts:1213`; `agent-channels.test.ts:110`) | Correct docs or explicit public simulator dispatch/receipt; n8n result reports committed local delivery | CRM + n8n | Preserve prepare/result; do not invent sent state in UI | Public HTTP-only simulator loop, duplicate receipt, failed receipt |
| G16 Recoverable orchestration | Telegram duplicate branch always stops (`workflow.json:69`) | Durable run record/state and resume from saved inbound ID; serialized runs per conversation, callback deduplication | n8n + Studio | Still one inbound writer; same event replays exact payload | Crash after ingest/tool/prepare/result, webhook acceptance timeout, retry without extra AI reply |
| G17 Staff handoff race | Payment receipt broadly resumes all request conversations (`payment-service.ts:55`); route guard checks lifecycle outside some transactions | Preserve explicit human ownership on PMS event receipt; recheck mode under mutation locks | CRM + n8n | Payment settlement must not silently revoke manual takeover | Human takeover during run/payment/tool, one acknowledgement, resumed explicit staff flow |

## Scenario preparation map

| Requested Studio stage | Actual CRM derivation / prerequisite | Connected preparation status |
|---|---|---|
| New unknown | Inbound creates stub, conversation mode ai, no request (`agent.ts:220`) | Existing inbound is sufficient in an explicitly authorized isolated CRM |
| Known / returning | Verified identity/mapping; `repeatGuest` derives completed stay count (`agent-context-service.ts:262`) | Requires sanctioned sandbox profile/stay fixture or pre-existing verified mapping |
| Commercial / enquire | Real commercial request via `/requests/upsert`; lifecycle enquire | Requires permitted fixture adapter and observed CRM request |
| Tentative | Lifecycle endpoint creates follow-up (`agent.ts:540`) | Requires permitted sandbox setup and actual tentative request |
| Definite / payment-ready | Request definite and needs_human (`agent.ts:555`) | Not a payment fact; real sales handoff required |
| Pending payment | Reservation/offer/payment request or request payment state (`agent-context-service.ts:180`) | PMS hold/invoice fixture + CRM event projection required |
| Confirmed / pre-arrival | CRM projected reservation confirmed; future arrival yields pre_arrival (`agent-context-service.ts:179`) | PMS confirmed fixture + mapping/projection required |
| In-house / due-out | Actual active guest stay operational status (`agent-context-service.ts:162`) | PMS check-in fixture/event required; local Studio flags insufficient |
| Service-only | No reservation, service request or scheduled service (`agent-context-service.ts:171`) | PMS operational service-only fixture + CRM projection required |
| Post-stay | Actual stay checked_out/cancelled/no_show (`agent-context-service.ts:165`) | PMS checkout fixture/event required; returning_guest remains identity property |

Unavailable lifecycle setup must return `SETUP_UNAVAILABLE` with required owner
and capability, and must not execute a chat as if the guest had a real stay.
Local Preview examples are clearly simulated data, never authoritative CRM/PMS
state. Reuse of CRM/PMS staff APIs to seed fixtures is a controlled test harness
decision for a later explicitly configured sandbox; Studio guest chat must not
expose those controls.

## Existing test evidence and audit limits

Read tests (not executed during this audit): `server/agent-channels.test.ts:62`
capabilities; `:71` channel isolation; `:94` simulator loop; `:143` attachments
and STT result; `:178` profile conflict; `:212` memory; `:241` payment-ready
handoff; `:278` tool traces. `server/agent-stabilization.test.ts:61` external/local
reservation IDs; `:96` conversation-scoped request updates; `:162` verification
retry; `:221` dirty stub protection; `:286` participant privacy; `:391` failed
outbound exclusion; `:487` capability contract parity.

`server/fullstack.test.ts:1378` confirmation mismatch/expiry;
`:1423` protected booking; `:1468` last-unit race; `:1510` handoff. These tests
validate current local CRM behavior and cannot prove PMS delegation, simulator
HTTP-only delivery, production separation or a completed end-to-end Studio run.

The next dual integration pass should execute new contract tests against
explicitly supplied non-production CRM/PMS/n8n endpoints, then retain fixtures,
run IDs, mappings and expected state receipts for repeatable acceptance.
