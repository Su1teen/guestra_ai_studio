# Studio integration contracts

Studio owns virtual clients/identities, simulation references, attempts/runs, prompts, annotations, media metadata, calls and test results. CRM owns guest business context/conversations/commercial Requests/Offers; PMS owns operational hotel state. No cross-database SQL or duplicated hotel tables. See [DATABASE_OWNERSHIP_AND_MAPPINGS](DATABASE_OWNERSHIP_AND_MAPPINGS.md).

Preview is persisted local simulation and labels template responses. CRM Connected has one Studio simulator inbound owner and authoritative transcript, without inventing an AI reply. End-to-End Sandbox delegates inbound ownership to the future n8n workflow. Saved conversation modes remain intact; display channels do not create real provider accounts.

## Discovery and scope

Existing environment keys are preserved. Default CRM version is v2; explicit CRM_API_VERSION=v1 permits the legacy simulator/transcript contract. Incompatible v2 never falls back. Credentials stay server-side. Exact HTTPS host allowlist does not attest sandbox; expected environment/property/tenant/deployment and features are independently checked.

CRM base /api/integrations/agent, x-crm-api-key. PMS base /api/v1/connect, x-api-key, read-only discovery. Optional upstream SQL/runtime flags are required. AUTH_FAILED, DATABASE_NOT_ATTESTED, INTEGRATION_DISABLED, CONTRACT_MISMATCH and ENVIRONMENT_MISMATCH remain distinct. CONNECTED means verified discovery, not E2E. Sandbox sending additionally requires explicit isolated test/sandbox opt-in, mapping, signed callback credential, approved workspaces/workflow and Studio DB readiness. Supplied production services cannot receive simulator/business writes.

## Messaging and identity

POST /messages/inbound preserves simulator/property/externalUserId/externalChatId/externalMessageId/externalUpdateId/text/profile/attachment metadata. Phone/name/username never proves PMS identity. V2 context validates customer/conversation/property and safe verified projection refs; inspector strips unknown metadata/notes. See [CRM_V2_ADAPTER](CRM_V2_ADAPTER.md).

Immutable guest-message-changes-v1 pages persist cursor/snapshots together; duplicate and overlapping polls are safe. Delivery/media replace same message ID, tombstones remain as annotation references. History is paginated, not deleted after 200 rows. Explicit v1 retains paged reconciliation/note filtering.

## studio-gateway-v1

Existing envelope keys remain, with frozen property scope/externalMessageId/canonical payloadHash. Only ephemeral media URLs are excluded from hash. Authenticated n8n claim commits existing agent_runs before acceptance; same payload returns existing run, changed payload conflicts; per-conversation logical order is enforced. Acceptance requires a claim actually present in Studio PostgreSQL.

HMAC callbacks use immutable event ID, matching claimed execution/correlation and monotonic sequence. Separate dispatch/inbound/agent/tool/business/reply/final states. Human ownership is sticky; unknown business completion blocks another logical operation. Callback storage survives CRM outage; polling reconciles later. Business completion independently checks CRM receipt; guest delivery comes only from CRM changes. Full node/protocol/retry design: [N8N_WORKFLOW_BLUEPRINT](N8N_WORKFLOW_BLUEPRINT.md).

CRM facade is the only business tool route. Neither Studio nor n8n receives PMS_COMMAND_SECRET or direct business SQL/write credentials. CRM/PMS retain consent, delivered proposal, current ownership, allowed tools, price/revision/property and idempotency guarantees. Pending/HTTP200 is not success.

## Fixtures, prompts, media and voice

Scenario setup uses stable persisted fixture ID, exact CRM body and upstream-created fixture identity bound to selected virtual client. API read-back precedes READY; unavailable setup preserves Preview. Replay/retire/simulated payment: [SCENARIO_FIXTURE_LIFECYCLE](SCENARIO_FIXTURE_LIFECYCLE.md).

Studio publish is local. Separate deployment lifecycle and injectable PromptPublisher require active hash/version/deployment read-back; default external publisher stays disconnected. [PROMPT_DEPLOYMENT_CONTRACT](PROMPT_DEPLOYMENT_CONTRACT.md).

Media uses workspace ownership, MIME/magic/20MiB validation, clean scanner requirement and five-minute purpose-signed URLs. Active claimed run may exchange only its own clean assets. CRM v2 reference/url methods prepare remote registration/retrieval; absent/processing/expired media is not falsely playable. Real scanner/storage/agent-origin binary preparation require configuration and external E2E.

Persistent virtual calls stay separate from telephony. SpeechAdapter and VoiceSessionAdapter prepare session/ordered speaker segments/authorized audio/STT/TTS/completion and CRM references, without live provider calls. Notes may target local attempts/runs, then bind verified external refs without replacing local ID; they never become guest messages/LLM input.

## Activation

Error shape stays {error:{code,message,retryable,correlationId}}; secrets/raw upstream bodies are excluded. RBAC/workspace scoping remains server-side. Railway startup verifies own DB/migration/attestation, defaults to no automatic production migrations and listens on PORT=8080. [RAILWAY_ACTIVATION](RAILWAY_ACTIVATION.md) lists every operator variable/credential/property input. Local contract PASS is not external n8n/PMS E2E: [E2E_TEST_PLAN](E2E_TEST_PLAN.md).
