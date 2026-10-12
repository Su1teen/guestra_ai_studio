import { database, migrate } from "../server/db.js";
const db = await database(process.env.DATABASE_URL, process.env.LOCAL_DATA_DIR);
await migrate(db);
await db.close();
console.log("Migrations applied");
