# Existing Railway Studio rollout

Studio already exists in lovely-art and main automatically deploys. Domain target/listen PORT is 8080. This delivery does not deploy or modify Railway. Follow the complete operator [RAILWAY_ACTIVATION](RAILWAY_ACTIVATION.md) guide and [env template](../guestra_ai_studio_railway.env).

Production startup verifies the dedicated Studio DB, migration ledger/schema and explicit deployment attestation, defaults to no automatic migrations, then initializes Studio-only registry/admin data. Review/copy-test the additive migration and supply ownership/deployment variables before approving merge. Never use CRM/PMS/n8n databases; verify the existing postgres_ai_studio service before creating another. Local embedded Preview alone retains automatic migrations. Any configured DATABASE_URL, including local mode, requires ownership verification.

Keep supplied production endpoints STUDIO_SANDBOX=false; discovery does not enable writes. Isolated sandbox and dedicated authenticated HTTPS n8n workflow/capabilities/scoped credentials are a subsequent authorized task. Media requires a durable volume/ObjectStorage and verified scanner; no volume was attached at read-only inspection. Rollback retains additive schema, refs/cursors/claims/receipts/media/audit.

Run typecheck, isolated PostgreSQL contract tests, build and desktop/mobile browser acceptance before review. Real external n8n/CRM/PMS E2E remains pending. No main merge, live variables/migrations/workflows/business operations were performed.
