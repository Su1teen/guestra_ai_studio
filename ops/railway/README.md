# Controlled Railway deployment and integration bootstrap

This directory is delivered identically in CRM, PMS and AI Studio, except for the
service-specific pre-deploy entrypoint and additive migration files. The real n8n
workflow is a separate delivery. A test orchestrator is not n8n E2E.

## Generate one complete operator configuration

Run `npm run integrations:generate-config -- --input ops/railway/config.private.json --output ops/railway/generated`
(use `pnpm integrations:generate-config --input ... --output ...` in PMS).
Use `config.input.example.json` as the input shape. Supply complete existing ENV
snapshots and verified existing tenant/property/workspace IDs. The generator
preserves database URLs, Redis, login users, legacy Telegram variables, media
secrets and existing integration keys. It refuses conflicting bindings. It creates
independent PMS Studio-read and CRM-service keys and a separate future n8n profile.
It computes key hashes automatically and shares the CRM command signing secret.

The output directory must not already exist: rerunning cannot silently rotate
keys. Linux permissions are 0700/0600; Windows ACL inheritance is removed and
access is granted only to the current operator. Never commit generated files or
upload them as CI artifacts. Files contain real secrets. `ENV-CHANGES.md` lists
ADD / KEEP / CHANGE; future orchestrator credentials are LATER. Existing IDs and
database identities are KEEP. Missing real IDs are LOOKUP REQUIRED, never invented.

## Apply to existing Railway services

1. Keep a restorable backup and first validate the rollout against a populated
   isolated copy. Do not point tests at production. Existing schemas must already
   contain PMS properties/reservations/folios/payments, CRM organizations/properties/
   app_users, or Studio workspaces/studio_users. An unrelated or partly initialized
   database is refused.
2. Paste each complete generated `.env` into that service's Railway Raw Editor.
   Database ownership: PMS `haip-postgres`, CRM `Postgres`, Studio `postgres-wz2f`
   in the pilot project. These verified service names support reference variables
   `${{haip-postgres.DATABASE_URL}}`, `${{Postgres.DATABASE_URL}}` and
   `${{postgres-wz2f.DATABASE_URL}}`; existing DATABASE_URL values are preserved.
   Do not reuse one service's database for another.
3. Deploy PMS, then CRM, then Studio. Their `railway.json` selects the shipped
   Dockerfile and invokes `node ops/railway/predeploy.mjs`. PMS no longer executes
   a production seed on every GitHub push. CRM startup also does not reseed data.
   Deployment automation is OFF until `GUESTRA_DEPLOY_AUTOMATION_ENABLED=true` is
   explicitly applied. Shipping the code alone performs no new production SQL.

## Initial adoption and ordinary updates

Set the service owner and a permanent deployment identity, plus
`GUESTRA_MIGRATION_BASELINE_APPROVED=true` for first adoption of an existing
journal without historical checksums. This attests the reviewed deployed source;
it cannot prove old file contents retrospectively. After successful first
adoption, set this approval back to false. The identity never changes per push.
Existing integration attestations must match; a conflict is refused rather than
overwritten. Existing safe deployment IDs are printed as operator metadata on
conflict, before any new canonical identity is created. Keep that existing ID;
do not change an established database identity after each deployment.

The pre-deploy uses a dedicated PostgreSQL connection and an advisory lock.
It checks service ownership and immutable environment/deployment identity,
checks every source checksum before executing pending SQL, records each committed
file, and rolls back a failed file. Missing or changed deployed files fail closed.
Each migration is transactional. Concurrent pre-deploys converge on one journal.
`migration-policy.json` explicitly classifies reviewed files. Unclassified new SQL
is manual by default; adding an approved additive migration includes its policy
entry in the reviewed release. Ordinary approved additive files run once on future
pushes, without manual SQL or an operator changing migration IDs.
The legacy PMS runner initializes `push-schema` only on an empty database; it
never replays the 0001–0021 baseline against populated databases. Migration 0042
repairs missing `connect_credentials` and `scopes` without replaying historical SQL.
Unexpected missing historical CRM files and PMS 0022–0041 files require separate
review, including historical data backfills. They are adopted from their existing
journal rather than replayed blindly. Destructive migrations are never
automatically approved.

## Optional integration schema and registry activation

The generated prepare profile sets `GUESTRA_INTEGRATION_MIGRATIONS_APPROVED=false`.
This means event/message capture triggers are not installed just because a
feature flag is false. After a populated-copy regression and operator review:

- PMS and CRM: explicitly set `GUESTRA_INTEGRATION_MIGRATIONS_APPROVED=true` and
  redeploy. This installs the already versioned opt-in integration migration,
  including capture triggers. It is an operational change even with writes OFF.
- CRM: set `GUESTRA_REGISTRY_ENABLED=true` in the same approved rollout. Its
  pre-deploy persists principals and verified hotel mappings into its own existing
  integration registry; subsequent runtime reads use the database registry.
- Keep both feature flags `GUESTRA_INTEGRATION_V2_ENABLED` (PMS) and
  `CRM_PMS_INTEGRATION_ENABLED` (CRM) false until both schemas and credentials pass
  checks. Then enable them for discovery/readiness with business writes still OFF.
- `GUESTRA_PROPERTY_MAPPING_CONFIRMED=true` is the operator's explicit assertion
  that the CRM and PMS IDs identify the same real hotel. Local tenant ownership is
  independently checked. Guests never create tenants. PMS persists property
  mappings using `integration_links`, not a second hotel catalog.

Studio's pre-deploy applies its 001/002/003 migration journal and inserts the
initial `studio_database_attestation` only when absent. It never overwrites an
attestation or creates another database. `STUDIO_AUTO_MIGRATE=false` remains set;
production HTTP startup does not perform schema migrations. Local Preview retains
its loopback-only embedded database and automatic local migrations.

## Credential management and authentication

`CONNECT_CREDENTIALS_BOOTSTRAP` is a JSON array containing id, propertyId, label,
key, environment, scopes and optional revoked. `CONNECT_CREDENTIAL_BOOTSTRAP_ENABLED=true`
enables controlled pre-deploy registration; no public bootstrap endpoint exists.
`integrations:bootstrap` is an alternative operator CLI, not a HTTP auth bypass.
Repeated records are no-ops. Changed scopes/key/property on an existing ID fail.
Rotate by adding a new ID/key and explicitly setting the old record's revoked
field to true. A revoked key can never be resurrected. Neither keys nor hashes
appear in application logs or audit descriptions. Audit records contain only
safe credential metadata. The authenticated administrative API remains available
with staff JWT authentication and permissions.

PMS `AUTH_ENABLED=false` may remain during a separately planned Keycloak rollout.
Production Connect authentication and v2 authentication are independent of this
staff switch. Administrative issuance is denied while staff authentication is
disabled. Bootstrap credentials cannot evade v2 write scopes through legacy POST,
PATCH or DELETE routes. New production business writes additionally require
`GUESTRA_BUSINESS_WRITES_ENABLED=true`, which remains false until sandbox E2E.
The existing staff demo mode is not a fully secured production staff deployment.

CRM principal rotation uses a new principal ID/keyHash and explicit revocation of
the previous record. Bootstrap refuses reassignment and missing properties. With
the registry enabled, database revocation takes precedence over ENV. Keep legacy
Telegram credentials unchanged. No code in this delivery creates an n8n workflow.

## Readiness and tests

- PMS: `GET /api/v1/connect/diagnostics?propertyId=...` with the property-scoped
  read credential in `x-api-key`.
- CRM: `GET /api/integrations/agent/readiness?propertyId=...` with a scoped read
  principal in `x-crm-api-key`.
- Studio: authenticated administrator `GET /api/integrations/readiness`; the
  lightweight `/api/ready` exposes only database readiness for Railway.

Diagnostics do not create bookings, payments or guest records. They distinguish
schema, attestation, credential/scope, mapping, environment and disabled-write
states. N8N_NOT_CONFIGURED is expected before the separate workflow is delivered.

`npm run test:deployment` runs generator validation and the real PostgreSQL
deployment tests when `DEPLOY_TEST_DATABASE_URL` targets a loopback test database.
The tests verify populated-row preservation, explicit trigger approval, concurrent
execution, drift detection, rollback and wrong-database rejection. No production
SQL, variables, credentials or backups are modified by this test harness.

For the three-codebase HTTP harness, build all repositories and in the PMS
checkout set `DATABASE_URL` and `CRM_TEST_DATABASE_URL` to separate loopback
databases ending `_integration_test`, plus `CRM_TEST_ROOT` and `STUDIO_TEST_ROOT`
to the matching source checkouts. Run `pnpm integrations:test-isolated`. The
command creates a one-day localhost TLS certificate, trusts it only in the child
test process, uses the real Studio adapter, and exercises CRM/PMS supported HTTP
APIs for customer resolution, duplicates, accepted offers/bookings, service/guest
requests, financial duplication, event projection, recovery and handoff. It
refuses production URLs. It does not implement or deploy a n8n workflow.
