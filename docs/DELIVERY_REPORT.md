# Studio integration-ready delivery — 14 October 2026

## IMPLEMENTED

Only AI Studio is changed, on codex/studio-integration-ready from Studio main eeea318. CRM aea5405/PMS 0dc4ade contracts and optional SQL were audited from read-only main snapshots. Exact v2 capabilities/context/search/offers/booking/services/availability/actions/guest-requests/receipts/changes/inspector/fixture/media adapter contracts are implemented with runtime schemas and explicit environment/property/tenant evidence. Legacy v1 simulator/transcript remains an explicit mode without silent downgrade.

Immutable changes cursor, duplicate/update/tombstone/paged history and separate delivery/execution/business states reuse existing transcript_snapshots/conversation_refs/message_attempts/agent_runs. Workspace/virtual identity/CRM customer/PMS guest stay distinct; fixture-created identity is bound to selected virtual client only after API evidence. No hotel business tables are added.

Gateway keeps studio-gateway-v1 with frozen scope/hash/prompt/media references. Authenticated SQL claims, immutable signed sequenced events, logical run ordering and same-key recovery handle duplicate/lost responses. Unknown business completion suspends further execution; completed business state requires CRM authoritative receipt. Human takeover stays sticky. Tester notes bind stable local targets to verified external refs and never leak to guest/LLM.

Prompt lifecycle now separates draft/test/Studio-published/pending/n8n-deployed/failed/rollback, with immutable selectable test versions and injected PromptPublisher active hash read-back. Inspector preserves sanitized HTTP/errors/timing/external refs. Existing Messenger, guest accounts/search/composer/links/media/review, Local Preview and persistent virtual calls are retained; earlier history is paginated. Speech/VoiceSession and CRM media contracts prepare future providers without real telephony.

## DATABASE CHANGES / REUSED

Additive 003_integration_readiness.sql adds Studio-only database attestation and transcript/run indexes. All original business-independent tables remain: identities, conversations refs, attempts/runs, transcript cache, integration_mappings/configuration, prompts, scenario_runs, annotations, media/calls/audit. JSON records hold cursors/sequences/tombstones/claims/frozen snapshots/refs/deployment state. No tables renamed/dropped; no CRM/PMS/n8n database connected, migrated or modified. Production startup defaults to no automatic migrations and requires independently verified own DB marker; manual migrate requires explicit approval/owner. Any DATABASE_URL, even local mode, passes ownership checks.

## TESTED

Local typecheck, 56 SQL/contract/regression tests on isolated embedded PostgreSQL and production build passed. Desktop/mobile browser acceptance: 10 tests passed (Messenger/login/draft/review/prompt/calls/image/PDF/audio/disconnected integrations). Browser tests explicitly clear external DB/API/scanner endpoints and use a dedicated local database. TEST_DATABASE_URL rejects nonloopback/non-test names. GitHub CI uses disposable PostgreSQL 16 studio_test in addition to browser tests; check the PR CI for the final server-database result. No fixture/mock PASS is claimed as real external E2E.

## READY FOR CONFIGURATION

[RAILWAY_ACTIVATION](RAILWAY_ACTIVATION.md) and [guestra_ai_studio_railway.env](../guestra_ai_studio_railway.env) list exact variables, separate scoped credentials, both property/tenant IDs and DB marker/migration/media prerequisites. Read-only Railway inspection confirmed Studio main source, successful deployed service, domain target 8080 and existing dedicated postgres_ai_studio service. OAuth exposed variable names only; actual values/DB ownership/auth/migration/capabilities were not verified. No media volume was attached at inspection. Server uses PORT with nonlocal default 8080.

## REQUIRES N8N

[N8N_WORKFLOW_BLUEPRINT](N8N_WORKFLOW_BLUEPRINT.md) defines dedicated trigger/claim/fast response/context/model/tool/receipt/delivery/callback/capability/error workflows and credentials using official n8n docs. Real workflow and admin publication client are intentionally not created. Default publisher reports pending/WORKFLOW_NOT_DEPLOYED. Build against installed n8n version, preserve existing Telegram/unrelated workflows, connect over authenticated HTTPS across Railway projects, verify active prompt hash and run [E2E_TEST_PLAN](E2E_TEST_PLAN.md).

## REQUIRES SANDBOX

Dedicated test/sandbox CRM/PMS/Studio DBs, upstream optional migrations/feature flags/deployment markers, registered property/tenant/staff/room/rate/service fixtures and scoped keys remain operator tasks. Stage READY requires actual fixture/API read-back. Payment simulation stays source=simulated/ledgerEffect=false/providerVerified=false. Scanner, durable storage/agent media transport and real voice providers need separate configuration/E2E. Inspector exposes sanitized upstream facts; pinned upstream does not provide raw safe arguments, and no fabricated tool calls/reasoning are shown.

## PRODUCTION NOT VERIFIED

Supplied live URLs stay production; STUDIO_SANDBOX=true alone cannot activate fixtures/writes. Live Railway variables/domains/deployments, CRM/PMS business DBs and all n8n workflows were untouched. No main merge or production deployment. External n8n/AI/CRM/PMS/consent/ledger/provider tests remain EXTERNAL_E2E_PENDING. Review additive rollout/variables and green PostgreSQL/browser CI before a separately approved merge.
