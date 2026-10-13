import { database, migrate } from "../server/db.js";
import { seed } from "../server/seed.js";
import {
  assertDatabaseOwnership,
  databaseReadiness,
} from "../server/readiness.js";
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)
  throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ chars)");
const db = await database(process.env.DATABASE_URL, process.env.LOCAL_DATA_DIR);
if (process.env.DATABASE_URL)
  await assertDatabaseOwnership(db, process.env.STUDIO_DATABASE_OWNER);
if (!process.env.DATABASE_URL) await migrate(db);
else {
  const ready = await databaseReadiness(db, {
    local: false,
    databaseOwner: process.env.STUDIO_DATABASE_OWNER,
    databaseDeployment: process.env.STUDIO_DATABASE_DEPLOYMENT_ID,
    environment: process.env.STUDIO_ENVIRONMENT,
  } as import("../server/config.js").Config);
  if (!ready.ready) throw new Error(ready.status);
}
await seed(db, false);
await db.close();
console.log("Workspace and administrator initialized");
