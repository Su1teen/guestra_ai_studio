import { spawn } from "node:child_process";
process.env.LOCAL_PREVIEW = "true";
process.env.HOST = "127.0.0.1";
const children = [
  spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
    { stdio: "inherit", env: process.env },
  ),
];
function close() {
  for (const child of children) child.kill();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
for (const child of children)
  child.on("exit", (code) => {
    close();
    process.exit(code ?? 0);
  });
