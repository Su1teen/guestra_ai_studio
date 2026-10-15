import { database, migrate } from "../server/db.js";
import { assertDatabaseOwnership } from "../server/readiness.js";
if (
  process.env.DATABASE_URL &&
  process.env.STUDIO_MIGRATION_APPROVED !== "true"
)
  throw new Error(
    "Explicit STUDIO_MIGRATION_APPROVED=true required after backup/review",
  );
const db = await database(process.env.DATABASE_URL, process.env.LOCAL_DATA_DIR);
if (process.env.DATABASE_URL)
  await assertDatabaseOwnership(db, process.env.STUDIO_DATABASE_OWNER);
await migrate(db);
await db.close();
console.log("Migrations applied");
