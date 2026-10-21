import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
export interface Sql {
  query<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ): Promise<T[]>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: string;
}
export async function database(
  url?: string,
  localDir = ".local/postgres",
): Promise<Database> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    const query = async <T>(sql: string, args: unknown[] = []) =>
      (await pool.query(sql, args)).rows as T[];
    return {
      kind: "PostgreSQL",
      query,
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const value = await fn({
            query: async <T>(s: string, a: unknown[] = []) =>
              (await c.query(s, a)).rows as T[],
          });
          await c.query("COMMIT");
          return value;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
      close: async () => pool.end(),
    };
  }
  if (process.env.NODE_ENV === "production")
    throw new Error("Production requires DATABASE_URL");
  if (localDir !== "memory://")
    await mkdir(resolve(localDir), { recursive: true });
  const db = new PGlite(
    localDir === "memory://" ? "memory://" : resolve(localDir),
  );
  await db.waitReady;
  return {
    kind: "Embedded PostgreSQL (PGlite)",
    query: async <T>(s: string, a: unknown[] = []) =>
      (await db.query<T>(s, a)).rows,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async <T>(s: string, a: unknown[] = []) =>
            (await tx.query<T>(s, a)).rows,
        }),
      ),
    close: () => db.close(),
  };
}
export async function migrate(db: Database) {
  await db.transaction(async tx => {
  if (db.kind === "PostgreSQL") await tx.query("SELECT pg_advisory_xact_lock(hashtext('guestra:studio:migrations'))");
  await tx.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  await tx.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum varchar(64)");
  for (const file of (await readdir(resolve("migrations")))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    let sql = await readFile(resolve("migrations", file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const [existing] = await tx.query<{checksum:string|null}>("SELECT checksum FROM schema_migrations WHERE version=$1",[file]);
    if (existing) {
      if (existing.checksum && existing.checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_DRIFT:" + file);
      if (!existing.checksum) await tx.query("UPDATE schema_migrations SET checksum=$1 WHERE version=$2",[checksum,file]);
      continue;
    }
    sql = sql.replace(
      "CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());",
      "",
    );
      for (const statement of sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [
        file, checksum,
      ]);
  }
  });
}
