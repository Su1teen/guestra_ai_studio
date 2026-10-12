import { config } from "./config.js";
import { database, migrate } from "./db.js";
import { seed } from "./seed.js";
import { createApp } from "./app.js";
const cfg = await config();
if (!cfg.databaseUrl && !cfg.local)
  throw new Error("DATABASE_URL required unless LOCAL_PREVIEW=true");
const db = await database(cfg.databaseUrl, cfg.dataDir);
await migrate(db);
await seed(db, cfg.local);
const { app, gateway } = createApp(db, cfg);
const server = app.listen(cfg.port, cfg.host, () =>
  console.log(
    JSON.stringify({
      level: "info",
      event: "server_ready",
      url: `http://${cfg.host}:${cfg.port}`,
      database: db.kind,
      localPreview: cfg.local,
    }),
  ),
);
const worker = setInterval(() => {
  void gateway
    .tick()
    .catch(() =>
      console.error(
        JSON.stringify({ level: "error", event: "worker_tick_failed" }),
      ),
    );
}, 500);
worker.unref();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(worker);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
