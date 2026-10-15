# Integration acceptance plan

Local contract tests use isolated PGlite PostgreSQL and stateful fake HTTPS CRM/PMS/orchestrator fixtures. CI runs platform/v2 suites on disposable PostgreSQL 16 `studio_test`; TEST_DATABASE_URL rejects nonloopback/non-test databases. Browser tests use isolated local Studio with external endpoints disabled. No test targets production.

| Area                                                                                                                    | Automated evidence                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| New/returning clients, same phone/different identity, display channels, concurrent conversations/users/workspaces, RBAC | Platform/persistence regressions and namespace/ownership guards                 |
| v1 inbound/transcript, Local Preview, annotations, prompt/call/media persistence                                        | Existing regressions preserved                                                  |
| v2 capabilities, optional flag/DB/auth/contract/environment/property/tenant mismatch                                    | V2 capability fixtures and fail-closed assertions                               |
| Safe context/reference mapping, no staff/tester notes                                                                   | Runtime schemas and context fixture assertions                                  |
| Changes pagination/duplicate/delivery/media/late outbound/tombstone/outage/out-of-order cursor                          | SQL cursor/snapshot tests                                                       |
| Durable concurrent claims, same key changed hash, lost webhook response, no unclaimed accepted:true                     | Stateful fake orchestration with real SQL claims                                |
| Inbound saved without reply, sticky handoff, signed sequence/replay/conflict                                            | Platform/v2 callback tests                                                      |
| Pending/completed read-back, confirmation input, price/quote/revision/identity errors                                   | Adapter/callback fixtures; actual upstream consent enforcement remains external |
| Scenario aliases/setup/replay/distinct references/retire/simulated no-ledger payment                                    | Fixture API and SQL persistence tests                                           |
| Media ownership/MIME/expiry/scanner and active-run exchange                                                             | Media tests and scoped exchange contracts                                       |
| Local/pending/verified/failed/rollback prompt deployment                                                                | Disconnected/injected publisher hash read-back tests                            |
| Additive schema, preserved history, foreign DB refusal                                                                  | Migration/readiness tests                                                       |
| Large history and guest Messenger/drafts/review/prompt/calls/image/PDF/audio                                            | Paging API test and desktop/mobile browser regressions                          |

Final test counts/results are in DELIVERY_REPORT.md. Fake tools model realistic receipts, not real hotel mutations/AI execution. A fixture PASS never proves provider/ledger/consent guarantees or external activation.

## External cases — EXTERNAL_E2E_PENDING

Provision separate authorized CRM/PMS/Studio sandbox databases, registered fixture properties, exact mappings/scoped keys/migrations/markers, scanner/storage and dedicated n8n workflow. Verify each independently before mutations.

1. First/returning virtual clients, same phone/different identities, multiple channels/properties/workspaces and users; verify separate CRM customer/conversation and PMS guest refs.
2. Claim/single inbound; restart Studio/n8n at every boundary. Lose claim/webhook/business/transport/callback responses, replay original keys and prove no duplicate booking/service/charge/payment effect.
3. Backend-approved vs unapproved/stale/wrong-conversation guest confirmation and real proposal delivery. Human takeover before/during/after tools, disallowed tool/property/workspace credentials.
4. Authoritative search/Offer/quote, price change/expiry/sold-out/declined booking/revision/identity conflict. Poll pending original receipt; completed only after PMS read-back, delivery separately verified.
5. Full changes history/pagination/concurrent poll completion/duplicates/updates/media/late reply/tombstones/reconnect, preserved cursor and annotations.
6. Every canonical fixture, interrupted setup, stable replay/changed payload/expiry/retire; simulated payment remains ledgerEffect=false/providerVerified=false and real payment ledger unchanged. Never run against production.
7. Real clean media processing/reference/retrieval/expiry/exchange/agent attachments and voice transcript mapping; verify storage after restart, no binary webhook JSON.
8. Implement actual scoped PromptPublisher for installed n8n API; publish/active hash/version/deployment and rollback read-back; other workflows untouched.
9. Actual AI/model/tool behavior with fresh CRM context/tool intersection, logs/redaction, safe requote/decline, sticky human and unknown-operation recovery, no notes/secrets leak.

Classify IMPLEMENTED / TESTED / READY FOR CONFIGURATION / REQUIRES N8N / REQUIRES SANDBOX / PRODUCTION NOT VERIFIED. External tests do not become PASS from mocks, deployment, health or capabilities.
