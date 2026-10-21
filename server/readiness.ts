import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
export async function assertDatabaseOwnership(db: Database, owner?: string) {
  if (owner !== "guestra_ai_studio")
    throw new ApiError(
      503,
      "DATABASE_NOT_ATTESTED",
      "STUDIO_DATABASE_OWNER must attest guestra_ai_studio",
    );
  const foreign = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",
    [
      [
        "guests",
        "leads",
        "reservations",
        "folios",
        "payments",
        "workflow_entity",
        "execution_entity",
      ],
    ],
  );
  if (foreign.length)
    throw new ApiError(
      503,
      "DATABASE_OWNERSHIP_MISMATCH",
      "Database contains foreign business tables; migrations refused",
    );
}
export async function databaseReadiness(db: Database, cfg: Config) {
  try {
    await db.query("SELECT 1");
    const applied = await db.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const required = (await readdir(resolve("migrations"))).filter((f) =>
      f.endsWith(".sql"),
    );
    if (required.some((f) => !applied.some((x) => x.version === f)))
      return { status: "MIGRATION_REQUIRED", ready: false };
    await db.query(
      "SELECT r.id FROM agent_runs r JOIN message_attempts a ON a.workspace_id=r.workspace_id AND a.data->>'runId'=r.id JOIN conversation_refs c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id LIMIT 0",
    );
    if (!cfg.local || cfg.databaseUrl) {
      await assertDatabaseOwnership(db, cfg.databaseOwner);
      const row = (
        await db.query<{
          system: string;
          environment: string;
          deployment_id: string;
        }>(
          "SELECT system,environment,deployment_id FROM studio_database_attestation WHERE id=true",
        )
      )[0];
      if (
        !row ||
        row.system !== "guestra_ai_studio" ||
        row.environment !== cfg.environment ||
        !cfg.databaseDeployment ||
        row.deployment_id !== cfg.databaseDeployment
      )
        return { status: "DATABASE_NOT_ATTESTED", ready: false };
    }
    return { status: "READY", ready: true };
  } catch (error) {
    const code = (error as {code?: string}).code;
    if (code === "42P01" || code === "42703") return {status:"MIGRATION_REQUIRED",ready:false};
    if (error instanceof ApiError) return {status:error.code,ready:false};
    if (code?.startsWith("08") || code === "ECONNREFUSED" || code === "ENOTFOUND") return {status:"DATABASE_UNAVAILABLE",ready:false};
    return { status: "DATABASE_NOT_ATTESTED", ready: false };
  }
}
