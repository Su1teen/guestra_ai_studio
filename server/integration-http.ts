import { z } from "zod";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";

export function permittedUrl(raw: string, cfg: Config) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(503, "NOT_CONFIGURED", "Endpoint не настроен");
  }
  const hosts = cfg.integrationHosts ?? cfg.allowedHosts;
  if (
    !hosts.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.protocol !== "https:" ||
    url.hash
  )
    throw new ApiError(
      403,
      "ENVIRONMENT_MISMATCH",
      "Endpoint должен быть HTTPS и входить в явный allowlist",
    );
  return url;
}
export async function integrationHttp<S extends z.ZodTypeAny>(
  url: string,
  cfg: Config,
  headers: Record<string, string>,
  schema: S,
  body?: unknown,
  timeoutMs = 10000,
): Promise<z.output<S>> {
  const target = permittedUrl(url, cfg);
  let response: Response;
  try {
    response = await fetch(target, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError(
      502,
      "INTEGRATION_UNREACHABLE",
      "Интеграция недоступна",
      true,
    );
  }
  if (!response.ok) {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      /* Only safe codes are surfaced. */
    }
    const e = raw as
      | {
          code?: unknown;
          message?: unknown;
          error?: unknown;
          retryable?: boolean;
        }
      | undefined;
    const candidate =
      typeof e?.code === "string"
        ? e.code
        : typeof e?.message === "string"
          ? e.message
          : "";
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)
      ? candidate
      : response.status === 401 || response.status === 403
        ? "AUTH_FAILED"
        : "INTEGRATION_ERROR";
    const retryable =
      code === "INTEGRATION_DISABLED" ||
      code === "INTEGRATION_DATABASE_NOT_ATTESTED"
        ? false
        : response.status >= 500 ||
          response.status === 429 ||
          e?.retryable === true;
    throw new ApiError(
      response.status === 401 || response.status === 403 ? 503 : 502,
      code,
      `API: HTTP ${response.status} · ${code}`,
      retryable,
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ApiError(502, "CONTRACT_MISMATCH", "API вернул неверный JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      502,
      "CONTRACT_MISMATCH",
      "Ответ API не соответствует контракту",
    );
  return parsed.data;
}
