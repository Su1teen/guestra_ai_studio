# Scenario fixture lifecycle

Local Preview keeps every scenario available and marks `PREVIEW_ONLY`; changing a Studio stage never changes hotel business state. Connected setup remains `SETUP_UNAVAILABLE` unless environment/property/tenant capabilities and authoritative fixture read-back succeed.

| Existing Studio stage                                                                                                                | CRM/PMS canonical fixture stage |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| known_customer, returning_guest                                                                                                      | returning_customer              |
| commercial_request, enquire                                                                                                          | enquire                         |
| confirmed                                                                                                                            | confirmed_reservation           |
| new_contact, tentative, definite, pending_payment, pre_arrival, in_house, service_only, due_out, post_stay, cancelled, human_handoff | same canonical spelling         |

The typed mapping preserves old saved scenarios. Schema adds due_out/cancelled/human_handoff without renaming existing values. A canonical stage is test setup vocabulary, not a local lifecycle authority.

`POST /api/scenarios/:id/run` selects an existing virtual client/channel, creates a Studio conversation and scenario run, then attempts setup only in Sandbox mode. `POST /api/scenario-runs/:id/setup` replays setup with the same stable `studio:<sha256(workspace,run,conversation)>` fixture ID. The ID is saved before dispatch, so a lost response cannot allocate another fixture.

Preflight requires Studio sandbox opt-in, expected test/sandbox environment, both CRM/PMS v2 capabilities, verified tenant/property mapping and their deployment attestations. CRM/PMS independently enforce scoped `sandbox.setup`, explicit test property registrations and their sandbox setup flags. A production 200 or configured URLs never bypasses these gates.

The exact CRM setup body is **only** `{propertyId,fixtureId,stage}`. It does not accept Studio externalUserId/clientId. CRM creates `externalUserId=fixture:<fixtureId>`, chat with the same reference, CRM customer/conversation and PMS guest. Studio binds a separate virtual identity for the selected client to those API-returned references, preserving prior identities. No name/phone/ID equality inference is permitted.

CRM has no GET fixture endpoint at the pinned version. Its replayed POST calls PMS setup and owned read-back, then returns `guestra-fixtures-v1`; Studio additionally GETs CRM v2 context. READY requires scope/expiry/customer/guest evidence and the canonical read-back: pending/confirmed/checked_in/checked_out/cancelled reservation as appropriate, scheduled service for service_only, correct request lifecycle for tentative/definite, AI disabled for human_handoff. Missing/mismatched state stays unavailable. Snapshot hotel facts are not stored as new Studio business rows.

`POST /api/scenario-runs/:id/retire` delegates to CRM fixture retirement, marks the local run unavailable/handoff and retains references/audit. Backend retains financial/history receipts and releases only fixture resources. Default upstream expiry is 24h; expired/retired keys are never recycled. Replaying a setup after retirement is rejected.

`POST /api/scenario-runs/:id/simulate-payment` delegates only for a verified ready fixture. Exact response identifies `source=simulated`, `ledgerEffect=false`, `providerVerified=false`. It is never a real payment or proof of paid money; no PMS ledger API is exposed by Studio. Current backend disallows simulation on nonpayment fixtures.

Future authorized sandbox E2E must run every canonical stage, interrupted setup, same-key altered payload, expiration, replay/read-back, simulated payment and retirement against isolated CRM/PMS databases. Fixtures/fake transport tests demonstrate this adapter's behavior, not activation of live backends.
