# Remaining integration work

Historical CRM_AUDIT.md/PMS_AUDIT.md describe old v1 baselines. The prior absence-of-v2 gap list is superseded by the audit of CRM main aea5405/PMS main 0dc4ade and [CRM_V2_ADAPTER](CRM_V2_ADAPTER.md).

Implemented/tested locally: exact scoped v2 validation, simulator v1 compatibility, immutable changes/delivery/media/tombstones, identity/context evidence, sandbox fixture lifecycle, durable Gateway claim/hash/events, immutable run snapshots, PromptPublisher/read-back boundary, inspector and paginated Messenger. Only additive Studio schema changes were made.

External work remains: dedicated n8n workflow/capabilities/error credentials, real PromptPublisher for installed n8n API, upstream optional SQL/flags/deployment attestation, isolated sandbox properties/tenants/staff/room/rate/service registrations, scanner/durable storage/media transport and actual consent/ledger/recovery E2E. Real STT/TTS/telephony remain separate providers.

Railway inspection saw dedicated postgres_ai_studio service but OAuth exposed variable names only; actual DATABASE_URL ownership, readiness, migrations/auth are operator verification. No live Variables/database/workflow/deployment/domain changed. Supplied production services are not sandboxes. Follow [RAILWAY_ACTIVATION](RAILWAY_ACTIVATION.md) and [N8N_WORKFLOW_BLUEPRINT](N8N_WORKFLOW_BLUEPRINT.md).
