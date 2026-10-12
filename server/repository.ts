import { randomUUID } from "node:crypto";
import type { Sql } from "./db.js";
import type { RecordBase } from "../shared/domain.js";
import { ApiError } from "./errors.js";
export const tables = [
  "virtual_clients",
  "virtual_identities",
  "conversation_refs",
  "agent_configurations",
  "prompt_versions",
  "agent_runs",
  "message_attempts",
  "preview_messages",
  "transcript_snapshots",
  "tester_annotations",
  "test_scenarios",
  "scenario_runs",
  "media_assets",
  "call_sessions",
  "integration_mappings",
  "integration_configuration",
  "audit_logs",
  "simulation_sessions",
] as const;
export type Table = (typeof tables)[number];
export const now = () => new Date().toISOString();
export function record<T>(data: T): T & RecordBase {
  return { ...data, id: randomUUID(), createdAt: now(), updatedAt: now() };
}
export class Repository {
  constructor(
    public sql: Sql,
    public workspaceId: string,
  ) {}
  async list<T>(table: Table): Promise<T[]> {
    if (table === "preview_messages")
      return (
        await this.sql.query<{ data: T; sequence: string }>(
          "SELECT data,sequence FROM preview_messages WHERE workspace_id=$1 ORDER BY sequence",
          [this.workspaceId],
        )
      ).map((r) => Object.assign({}, r.data, { sequence: Number(r.sequence) }));
    return (
      await this.sql.query<{ data: T }>(
        `SELECT data FROM ${table} WHERE workspace_id=$1 ORDER BY data->>'createdAt',id`,
        [this.workspaceId],
      )
    ).map((r) => r.data);
  }
  async get<T>(table: Table, id: string): Promise<T | undefined> {
    return (
      await this.sql.query<{ data: T }>(
        `SELECT data FROM ${table} WHERE workspace_id=$1 AND id=$2`,
        [this.workspaceId, id],
      )
    )[0]?.data;
  }
  async put<T extends RecordBase>(
    table: Table,
    data: T,
    columns: Record<string, unknown> = {},
  ): Promise<T> {
    const fields = data as T & Record<string, unknown>;
    const required: Record<string, string> = {};
    if (table === "virtual_identities")
      Object.assign(required, {
        client_id: "clientId",
        external_user_id: "externalUserId",
      });
    if (table === "conversation_refs")
      Object.assign(required, {
        client_id: "clientId",
        identity_id: "identityId",
        external_chat_id: "externalChatId",
      });
    if (table === "prompt_versions") required.agent_id = "agentId";
    if (
      [
        "agent_runs",
        "message_attempts",
        "preview_messages",
        "transcript_snapshots",
        "tester_annotations",
        "scenario_runs",
        "call_sessions",
        "simulation_sessions",
      ].includes(table)
    )
      required.conversation_id = "conversationId";
    if (table === "message_attempts")
      Object.assign(required, {
        external_message_id: "externalMessageId",
        status: "status",
        next_at: "nextAt",
      });
    if (table === "scenario_runs") required.scenario_id = "scenarioId";
    if (table === "media_assets") required.storage_key = "storageKey";
    columns = {
      ...Object.fromEntries(
        Object.entries(required).map(([column, field]) => [
          column,
          fields[field],
        ]),
      ),
      ...columns,
    };
    const colKeys = Object.keys(columns);
    if (
      colKeys.some(
        (k) =>
          ![
            "client_id",
            "external_user_id",
            "identity_id",
            "external_chat_id",
            "agent_id",
            "conversation_id",
            "external_message_id",
            "status",
            "next_at",
            "scenario_id",
            "storage_key",
          ].includes(k),
      )
    )
      throw new Error("Invalid column");
    const keys = ["workspace_id", "id", "data", ...colKeys];
    const values = [
      this.workspaceId,
      data.id,
      JSON.stringify(data),
      ...Object.values(columns),
    ];
    await this.sql.query(
      `INSERT INTO ${table} (${keys.join(",")}) VALUES (${values.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT (workspace_id,id) DO UPDATE SET ${["data", ...colKeys].map((k) => `${k}=excluded.${k}`).join(",")}`,
      values,
    );
    return data;
  }
  async update<T extends RecordBase>(
    table: Table,
    id: string,
    fn: (value: T) => T,
    columns: Record<string, unknown> = {},
  ): Promise<T> {
    const value = await this.get<T>(table, id);
    if (!value) throw new ApiError(404, "NOT_FOUND", "Запись не найдена");
    return this.put(table, { ...fn(value), updatedAt: now() }, columns);
  }
  async patch<T>(
    table: Table,
    id: string,
    changes: Record<string, unknown>,
    allowedStatuses?: string[],
  ): Promise<T | undefined> {
    const args: unknown[] = [
      this.workspaceId,
      id,
      JSON.stringify({ ...changes, updatedAt: now() }),
    ];
    let condition = "";
    if (allowedStatuses) {
      args.push(allowedStatuses);
      condition = " AND data->>'status'=ANY($4::text[])";
    }
    const delivered =
      table === "message_attempts" &&
      changes.status !== undefined &&
      changes.status !== "delivered";
    const dataExpression = delivered
      ? "data || ($3::jsonb - 'status') || jsonb_build_object('status',CASE WHEN status='delivered' THEN 'delivered' ELSE $3::jsonb->>'status' END)"
      : "data || $3::jsonb";
    const extra =
      table === "message_attempts"
        ? `,status=${delivered ? "CASE WHEN status='delivered' THEN 'delivered' ELSE COALESCE($3::jsonb->>'status',status) END" : "COALESCE($3::jsonb->>'status',status)"},next_at=COALESCE(($3::jsonb->>'nextAt')::timestamptz,next_at)`
        : "";
    return (
      await this.sql.query<{ data: T }>(
        `UPDATE ${table} SET data=${dataExpression}${extra} WHERE workspace_id=$1 AND id=$2${condition} RETURNING data`,
        args,
      )
    )[0]?.data;
  }
  async audit(actor: string, action: string, target: string, summary: string) {
    await this.put("audit_logs", record({ actor, action, target, summary }));
  }
}
