CREATE TABLE studio_database_attestation (id boolean PRIMARY KEY DEFAULT true CHECK(id), system text NOT NULL CHECK(system='guestra_ai_studio'), environment text NOT NULL CHECK(environment IN ('test','sandbox','production')), deployment_id text NOT NULL, attested_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX transcript_conversation_order ON transcript_snapshots(workspace_id,conversation_id,(data->>'createdAt'),id);
CREATE INDEX run_claim_hash ON agent_runs(workspace_id,(data->>'dispatchHash'));
