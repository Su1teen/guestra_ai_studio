# Foundation delivery — 13 октября 2026

## IMPLEMENTED

React/Vite guest messenger с адаптивными layouts, виртуальными клиентами, отдельными чатами/каналами, поиском/фильтрами, saved drafts, reply/copy/message menus, safe links, confirmed sending states и backend processing indicator. Review panel: message/conversation/run/tool/call annotations, author/severity/type/flags, revision history, resolve/reopen, verdict. Inspector отделён от гостевого экрана.

Express API, PostgreSQL16-compatible SQL migrations, pg server adapter, local durable PGlite, repository/service layers, runtime validation, scrypt auth/session/RBAC/workspace isolation, readiness/structured error logs. Durable attempts/sequence/leases, immutable idempotency payload, retries/backoff, asynchronous callback receipts and monotonic run states. Separate preview transcript and bounded read-only CRM cache.

Agent registry/configuration, PostgreSQL prompt drafts/history/diff, immutable published versions, local publish/rollback audit and per-run prompt/config snapshot. Scenarios and persisted assertions with truthful PREVIEW_ONLY/SETUP_UNAVAILABLE states. Media metadata/object-storage abstraction, actual local uploads/previews/downloads, magic/MIME/size validation, HMAC URLs/scanner hook/retention. Virtual call sessions/transitions/logs/duration/turns/audio/run linkage/comments.

Dockerfile, Railway configuration, compose PostgreSQL, env template, CI, setup/API/integration/deployment docs. Related repository code audited read-only, precise gap matrices prepared.

## VERIFIED

Local typecheck, 25 API/security/idempotency/persistence tests and production build passed. All 6 browser acceptance tests on desktop/mobile passed for guest/chat creation, draft after reload, send/safe link, annotations/resolve, prompt history/diff, virtual call turns, image lightbox, PDF download and actual WAV playback. Local browser execution used installed Edge; CI uses Chromium and PostgreSQL 16. Final CI status is recorded in the PR description after execution.

Related CRM/PMS findings verified by static source reading at pinned commits; live endpoints/business operations were not executed. UI inspected in the browser; initial draft/selection reload and async state races were corrected.

## READY FOR INTEGRATION

Actual CRM Agent API inbound/transcript adapter with simulator identity separation, one inbound owner per mode, staff note filtering and original media ref overlay. PMS/n8n capability adapters, signed callback envelope, scenario/trace/prompt/STT/TTS interfaces and exact ownership/replay/error contracts. New connected modes are gated by explicit sandbox config and discovery.

## NOT CONNECTED

CRM/PMS/n8n endpoints and credentials, real LLM/model execution, workflow prompt publication/read-back, trace API, advanced scenario fixture provider, S3/R2 backend, malware scanner service, real outbound agent media, SIP/PBX/STT/TTS/realtime audio. Current Local Preview uses explicit templates. Publish updates only Studio registry. No production deployment/migration/merge performed.

PostgreSQL 16 checks are configured in CI; their final status is recorded in the PR after execution. Local verification uses PGlite unless a separate TEST_DATABASE_URL is supplied. Railway runtime and container startup are not claimed verified by local build alone. LocalStorage needs a durable volume; physical retention cleanup is a storage lifecycle extension. Transcript reconciliation reports a 5000-record bound honestly until CRM changes cursor exists. Multi-workspace account switching, self-registration and workflow trace ingestion remain extensions to the foundation.

## REQUIRES CRM/PMS CHANGES

PMS-only operational authority; explicit Request/Offer↔PMS refs and verified Customer↔Guest mapping; first accommodation identity-link fix; provider-backed payment/status/link API; preserve manual takeover; scoped credentials/discovery; real signed event delivery/immutable cursor; no internal notes in guest/context APIs; immutable transcript changes feed; outbound media and read-only tool traces; sandbox fixture endpoints; complete mutation idempotency/revision handling. Full existing/expected/source/owner/compatibility/test analysis: [CRM_PMS_INTEGRATION_GAPS](CRM_PMS_INTEGRATION_GAPS.md).

Development branch feat/studio-foundation, minimal main bootstrap 107a7a3. Source delivery is prepared as a draft PR; no external integration is presented as complete.
