import { database, migrate } from "../server/db.js";
import { seed } from "../server/seed.js";
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)
  throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ chars)");
const db = await database(process.env.DATABASE_URL, process.env.LOCAL_DATA_DIR);
await migrate(db);
await seed(db, false);
await db.close();
console.log("Workspace and administrator initialized");
