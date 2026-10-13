# Railway activation — operator runbook

Status: READY FOR CONFIGURATION / REQUIRES N8N / REQUIRES SANDBOX / PRODUCTION NOT VERIFIED. This delivery changes Studio only. Do not merge until the operator has reviewed the schema/startup gates: Railway deploys `main` automatically.

## Verified inventory, 14 October 2026 (Asia/Qyzylorda)

Read-only Railway inspection confirmed project `lovely-art` (`b4d661da-21ad-417f-94fb-70b6885d6ffe`), production environment `e7c5c864-a4e3-477d-929c-af1855a58388`. Studio service `415d4a52-b205-4656-a9fb-fe545b0ddebb` uses `Su1teen/guestra_ai_studio`, `main`; domain `guestrastudio.up.railway.app` targets **8080**. The service already has `PORT`, `DATABASE_URL` and the original 24 variable names. OAuth exposes names only, so their values and database ownership were **not verified**. A separate database service named **`postgres_ai_studio`** already exists (`dbeec8df-6c05-4bf3-86af-4a21d5466634`); verify it before creating any additional `studio-postgres` service. No media volume was attached to Studio in the inspection.

CRM, PMS, their independent Postgres/Redis services remain in this project. Existing n8n (`7ab4334c-53ed-4f2c-9d97-3d6ff53b0dd4`) and its own PostgreSQL are in `gentle-reprieve` (`f8c4ab13-094d-4b6c-b1fc-dd0939ba05d0`). Cross-project orchestration uses authenticated public HTTPS.

The supplied live URLs are production, including n8n's web UI. A successful deployment/health response does not attest an integration, feature flag, optional migration, property, credential or workflow. No live Variables, databases, workflows, deployments or domains were changed.

## Operator inputs

Use [`guestra_ai_studio_railway.env`](../guestra_ai_studio_railway.env). Keep secrets in Railway/n8n credentials, never the frontend or Git.

| Variables                                                 | Required value/evidence                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`, `LOCAL_PREVIEW`, `HOST`, `PORT`, `PUBLIC_URL` | `production`, `false`, `0.0.0.0`, **`8080`**, `https://guestrastudio.up.railway.app`                                                                              |
| `DATABASE_URL`                                            | Reference only the verified **Studio** database, e.g. `${{postgres_ai_studio.DATABASE_URL}}`; never `${{Postgres.DATABASE_URL}}`, `haip-postgres` or n8n Postgres |
| `STUDIO_DATABASE_OWNER`                                   | Exact `guestra_ai_studio`, after independent ownership verification                                                                                               |
| `STUDIO_DATABASE_DEPLOYMENT_ID`                           | Operator-chosen immutable identifier matching the Studio DB attestation row                                                                                       |
| `STUDIO_ENVIRONMENT`                                      | `production` for the supplied services. For testing, a separately provisioned and database-attested `sandbox` or `test` environment                               |
| `STUDIO_AUTO_MIGRATE`                                     | `false` on Railway. Startup requires installed migrations; it does not install them by default                                                                    |
| `STUDIO_MIGRATION_APPROVED`                               | Temporary **manual migration command** input, `true` only after backup/copy validation and approval; do not enable routinely on the service                       |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`                           | Operator-provided administrator, password >=12 characters; initialize using reviewed `npm run bootstrap`                                                          |
| `MEDIA_SIGNING_SECRET`                                    | Independent random >=32-character secret                                                                                                                          |
| `MEDIA_DIR`                                               | Durable volume path, e.g. `/data/media`; attach/preserve a volume before media activation or implement ObjectStorage                                              |
| `MEDIA_SCANNER_URL`, `MEDIA_SCANNER_TOKEN`                | Approved HTTPS scanner, authenticated credential; clean response must be tested. Missing scanner remains `MEDIA_SCANNER_NOT_CONFIGURED`                           |
| `CRM_API_URL`                                             | Base including `/api/integrations/agent`; live discovery URL is `https://guestracrm-production.up.railway.app/api/integrations/agent`                             |
| `CRM_API_VERSION`                                         | `v2` default. Explicit `v1` only for approved legacy deployments; never automatic fallback                                                                        |
| `CRM_API_KEY`                                             | Dedicated hashed CRM integration principal, exact property/environment; production discovery uses read scopes below                                               |
| `CRM_PROPERTY_ID`, `CRM_TENANT_ID`                        | Actual CRM text IDs supplied by operator; verify through v2 capabilities. Do not infer from hotel display name                                                    |
| `PMS_API_URL`                                             | Base including `/api/v1/connect`; live discovery URL is `https://haip-demo-production.up.railway.app/api/v1/connect`                                              |
| `PMS_API_KEY`                                             | Property-scoped Connect credential with `integration.read` and `environment:<STUDIO_ENVIRONMENT>`                                                                 |
| `PMS_PROPERTY_ID`, `PMS_TENANT_ID`                        | Actual PMS property UUID and tenant ID. No default demo UUID is accepted as evidence                                                                              |
| `INTEGRATION_ALLOWED_HOSTS`                               | Exact comma-separated approved HTTPS hostnames for CRM/PMS/n8n/scanner; trim applied, no wildcards                                                                |
| `SANDBOX_ALLOWED_HOSTS`                                   | Existing key preserved as fallback when `INTEGRATION_ALLOWED_HOSTS` is absent; a host allowlist does **not** attest sandbox                                       |
| `STUDIO_SANDBOX`                                          | **`false` for the supplied production services**. `true` only after separate CRM/PMS test DB/environment attestation                                              |
| `N8N_WEBHOOK_URL`                                         | Future dedicated published Guestra Studio POST webhook; leave blank until built; never existing Telegram outbound webhook                                         |
| `N8N_CAPABILITIES_URL`                                    | Future dedicated authenticated GET capability webhook, not n8n UI/health URL                                                                                      |
| `N8N_TOKEN`                                               | Independent >=32-character bearer used for dedicated webhook and Studio server-to-server claim/media/receipt authentication                                       |
| `N8N_CALLBACK_SECRET`                                     | Different random >=32-character HMAC secret for exact raw callback JSON                                                                                           |
| `N8N_WORKSPACE_IDS`                                       | Exact approved Studio workspace IDs (e.g. existing `les-sandbox` only after verifying membership and environment); workflow capabilities must attest all of them  |

Studio production read principal: `integration.read`, `agent.read`, `inspector.read`, optionally `media.read`, and exact property/environment/workspace scopes. Studio sandbox fixture principal additionally needs `sandbox.setup`; CRM simulator-only mode needs `agent.write`. The future n8n principal is **separate**, with `agent.read`, `agent.write`, `integration.read`, `integration.write`, `inspector.read`, optional `media.read`/`media.write` and only required `tool:<name>` scopes. Media principal needs `workspaceIds`. Request/lifecycle/handoff legacy facade tools require their exact CRM tool scopes. Neither Studio nor n8n receives `PMS_COMMAND_SECRET`, CRM/PMS DB credentials or n8n admin API keys in browser state.

## Studio database rollout

1. Keep workspaces in Preview and all integration write flags off. Determine the actual database behind Studio's existing `DATABASE_URL`; do not assume it is empty. Compare its service/database/user to CRM/PMS/n8n independently.
2. Back up the Studio database. Validate migrations 001/002/003 on a disposable copy, including existing annotations/prompts/history. Review startup changes before approving a merge/deployment.
3. `npm run db:migrate` against **only Studio** requires `STUDIO_DATABASE_OWNER=guestra_ai_studio` and temporary `STUDIO_MIGRATION_APPROVED=true`. The ownership guard refuses databases containing CRM/PMS/n8n business tables. This is a second guard, not proof replacing the DBA audit.
4. After installing migration 003, the operator records the environment/deployment attestation in Studio only, using bound parameters through their database tool:

```sql
INSERT INTO studio_database_attestation(id,system,environment,deployment_id)
VALUES(true,'guestra_ai_studio', :studio_environment, :studio_database_deployment_id);
```

Do not overwrite an existing marker to disguise a different database/environment. Review/rotate it explicitly when moving a verified database. No attestation row is automatically created by application startup or migrations.

5. Initialize administrator if necessary, then deploy the approved Studio version with auto-migration off. `/api/health` checks liveness. `/api/ready` verifies Studio DB connectivity, migration ledger and attestation. Missing markers/schema fail startup rather than silently using another database.
6. Preserve media volume and old assets. Rollback application/configuration if needed, retain additive schema, cursor records, tombstones, claims, annotations and receipts. Do not drop/restore one system's tables to undo another system's committed operation.

## External activation, separate approved task

CRM main `aea540523c0e4dcf79f32fe11df5e3466ed9cdff` and PMS main `0dc4adeb508eb4bc6bc73d64848883eb6f115626` include optional v2 SQL. Deployed code alone is insufficient. Follow each repository's `CROSS_DATABASE_CONTRACT.md` and `.env.integration.example`; do not run their isolated setup helpers against Railway production.

PMS owner must separately review/install `integration-migrations/0001_domain_event_capture_v2.sql`, set its DB deployment marker, issue a property/environment-scoped credential, configure its signed quote/command/event policy, then enable `GUESTRA_INTEGRATION_V2_ENABLED`. CRM owner must separately review/install `integration-migrations/0001_cross_database_v2.sql`, register its deployment/principals/property mappings and approved PMS credentials, then enable `CRM_PMS_INTEGRATION_ENABLED`. These paths must be checked against the pinned repos before application. `GUESTRA_SANDBOX_SETUP_ENABLED` and sandbox property registrations belong only to separate isolated test deployments. PMS Inbox flags are independent and not necessary for Studio discovery.

Verify CRM capabilities (`guestra-crm-integration-v2`) and PMS capabilities (`guestra-connect-v2`) separately: exact environment, both tenant IDs, CRM property text ID, PMS UUID, nonempty deployment IDs, verifiedMapping and receipt/read-back features. Failures surface `AUTH_FAILED`, `DATABASE_NOT_ATTESTED`, `INTEGRATION_DISABLED`, `CONTRACT_MISMATCH` or `ENVIRONMENT_MISMATCH`; they never trigger a downgrade.

Only after separate sandbox attestation, configure the dedicated workflow from [N8N_WORKFLOW_BLUEPRINT](N8N_WORKFLOW_BLUEPRINT.md), authenticated capability endpoint, token/HMAC and approved workspace list. `CONNECTED` describes verified API discovery; End-to-End Sandbox additionally requires all providers and a durable Studio database. `SANDBOX_READY` remains a configuration gate, not external E2E success. Run the external cases in [E2E_TEST_PLAN](E2E_TEST_PLAN.md) before claiming integration or considering a separately approved production write rollout.
