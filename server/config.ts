import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  local: boolean;
  databaseUrl?: string;
  dataDir: string;
  mediaDir: string;
  signingSecret: string;
  sandbox: boolean;
  allowedHosts: string[];
  crmUrl: string;
  crmKey: string;
  pmsUrl: string;
  pmsKey: string;
  n8nUrl: string;
  n8nCapabilitiesUrl: string;
  n8nToken: string;
  callbackSecret: string;
  crmProperty: string;
  pmsProperty: string;
  scannerUrl: string;
  scannerToken: string;
  environment?: "test" | "sandbox" | "production";
  crmVersion?: "v1" | "v2";
  crmTenant?: string;
  pmsTenant?: string;
  integrationHosts?: string[];
  orchestratorWorkspaces?: string[];
  databaseOwner?: string;
  databaseDeployment?: string;
  autoMigrate?: boolean;
}
export async function config(): Promise<Config> {
  try {
    loadEnvFile(".env");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const local =
    process.env.LOCAL_PREVIEW === "true" &&
    process.env.NODE_ENV !== "production";
  const host = process.env.HOST ?? (local ? "127.0.0.1" : "0.0.0.0");
  if (local && !["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error("Local preview must bind to loopback");
  let signingSecret = process.env.MEDIA_SIGNING_SECRET ?? "";
  if (!signingSecret && local) {
    await mkdir(".local", { recursive: true });
    try {
      signingSecret = await readFile(".local/media-secret", "utf8");
    } catch {
      signingSecret = randomBytes(32).toString("hex");
      await writeFile(".local/media-secret", signingSecret, { mode: 0o600 });
    }
  }
  if (signingSecret.length < 32)
    throw new Error("MEDIA_SIGNING_SECRET must contain at least 32 characters");
  const environment = process.env.STUDIO_ENVIRONMENT ?? "production";
  if (!["test", "sandbox", "production"].includes(environment))
    throw new Error("Invalid STUDIO_ENVIRONMENT");
  const crmVersion = process.env.CRM_API_VERSION ?? "v2";
  if (!["v1", "v2"].includes(crmVersion))
    throw new Error("Invalid CRM_API_VERSION");
  const port = Number(process.env.PORT ?? (local ? 4310 : 8080));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const hosts = (value: string) =>
    value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    port,
    host,
    publicUrl: process.env.PUBLIC_URL ?? "http://127.0.0.1:5173",
    local,
    databaseUrl: process.env.DATABASE_URL || undefined,
    dataDir: process.env.LOCAL_DATA_DIR ?? ".local/dev-db",
    mediaDir: resolve(process.env.MEDIA_DIR ?? ".local/media"),
    signingSecret,
    sandbox: process.env.STUDIO_SANDBOX === "true",
    allowedHosts: (process.env.SANDBOX_ALLOWED_HOSTS ?? "")
      .split(",")
      .filter(Boolean),
    crmUrl: process.env.CRM_API_URL ?? "",
    crmKey: process.env.CRM_API_KEY ?? "",
    pmsUrl: process.env.PMS_API_URL ?? "",
    pmsKey: process.env.PMS_API_KEY ?? "",
    n8nUrl: process.env.N8N_WEBHOOK_URL ?? "",
    n8nCapabilitiesUrl: process.env.N8N_CAPABILITIES_URL ?? "",
    n8nToken: process.env.N8N_TOKEN ?? "",
    callbackSecret: process.env.N8N_CALLBACK_SECRET ?? "",
    crmProperty: process.env.CRM_PROPERTY_ID ?? "",
    pmsProperty: process.env.PMS_PROPERTY_ID ?? "",
    scannerUrl: process.env.MEDIA_SCANNER_URL ?? "",
    scannerToken: process.env.MEDIA_SCANNER_TOKEN ?? "",
    environment: environment as Config["environment"],
    crmVersion: crmVersion as Config["crmVersion"],
    crmTenant: process.env.CRM_TENANT_ID ?? "",
    pmsTenant: process.env.PMS_TENANT_ID ?? "",
    integrationHosts: hosts(
      process.env.INTEGRATION_ALLOWED_HOSTS ||
        process.env.SANDBOX_ALLOWED_HOSTS ||
        "",
    ),
    orchestratorWorkspaces: hosts(process.env.N8N_WORKSPACE_IDS ?? ""),
    databaseOwner: process.env.STUDIO_DATABASE_OWNER ?? "",
    databaseDeployment: process.env.STUDIO_DATABASE_DEPLOYMENT_ID ?? "",
    autoMigrate:
      (local && !process.env.DATABASE_URL) ||
      process.env.STUDIO_AUTO_MIGRATE === "true",
  };
}
