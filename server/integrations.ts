import type { Config } from "./config.js";
import type {
  Attachment,
  Conversation,
  Identity,
  Attempt,
  Message,
  Client,
} from "../shared/domain.js";
import { ApiError } from "./errors.js";
import { now } from "./repository.js";
export interface ScenarioSetupAdapter {
  prepare(input: {
    workspaceId: string;
    stage: string;
    externalUserId: string;
    crmPropertyId: string;
    pmsPropertyId: string;
  }): Promise<{
    status: "READY" | "SETUP_UNAVAILABLE";
    references: Record<string, string>;
    reason: string;
  }>;
}
export class UnavailableScenarioSetup implements ScenarioSetupAdapter {
  async prepare() {
    return {
      status: "SETUP_UNAVAILABLE" as const,
      references: {},
      reason:
        "CRM/PMS не предоставляют проверенный sandbox fixture API. Создайте тестовое состояние через разрешённый setup adapter и подтвердите его read-back.",
    };
  }
}
export interface TraceReader {
  read(
    correlationId: string,
    cursor?: string,
  ): Promise<{ events: unknown[]; nextCursor?: string }>;
}
export interface PromptPublisher {
  publish(input: {
    workflowId: string;
    versionId: string;
    body: string;
  }): Promise<{ deploymentId: string; readBackHash: string }>;
}
export interface SpeechAdapter {
  transcribe(asset: Attachment): Promise<string>;
  synthesize(text: string): Promise<Attachment>;
}
export interface ObjectStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
export function permittedUrl(raw: string, cfg: Config) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(503, "NOT_CONFIGURED", "Sandbox endpoint не настроен");
  }
  if (
    !cfg.sandbox ||
    !cfg.allowedHosts.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.protocol !== "https:"
  )
    throw new ApiError(
      403,
      "SANDBOX_REQUIRED",
      "Endpoint должен быть HTTPS и входить в явный sandbox allowlist",
    );
  return url;
}
async function http<T>(
  url: string,
  cfg: Config,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs = 10000,
): Promise<T> {
  const target = permittedUrl(url, cfg);
  let response: Response;
  try {
    response = await fetch(target, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new ApiError(
      502,
      "INTEGRATION_UNREACHABLE",
      "Тестовая интеграция недоступна",
      true,
    );
  }
  if (!response.ok) {
    let retryable = response.status >= 500 || response.status === 429;
    try {
      const error = await response.json();
      retryable = retryable || error.retryable === true;
    } catch {}
    throw new ApiError(
      response.status === 401 ? 503 : 502,
      "INTEGRATION_ERROR",
      `Sandbox API: HTTP ${response.status}`,
      retryable,
    );
  }
  const data = await response.json();
  return data as T;
}
type InboundResult = {
  messageId: string;
  duplicate: boolean;
  context: { conversation: { id: string }; customer?: { id: string } };
  aiReplyAllowed: boolean;
  allowedActions: string[];
};
type CrmMessage = {
  id: string;
  direction: string;
  senderType: string;
  text: string;
  at: string;
  deliveryStatus: string;
  externalMessageId?: string;
  attachments?: {
    id: string;
    kind: string;
    mimeType: string;
    fileName: string;
    fileSize?: number;
  }[];
};
export class Integrations {
  constructor(public cfg: Config) {}
  async capabilities() {
    const c = this.cfg;
    const targets = [
      ["crm", c.crmUrl, c.crmKey, "x-crm-api-key"],
      ["pms", c.pmsUrl, c.pmsKey, "x-api-key"],
      ["n8n", c.n8nCapabilitiesUrl, c.n8nToken, "Authorization"],
    ] as const;
    const output = await Promise.all(
      targets.map(async ([name, url, key, header]) => {
        if (!url || !key)
          return {
            name,
            status: "not_configured",
            detail: "Endpoint и credentials не предоставлены",
            capabilities: null,
          };
        try {
          const caps = await http<Record<string, unknown>>(
            name === "n8n" ? url : url.replace(/\/$/, "") + "/capabilities",
            c,
            { [header]: header === "Authorization" ? "Bearer " + key : key },
          );
          const supported = Array.isArray(caps.supportedChannels)
            ? caps.supportedChannels
            : [];
          const valid =
            name === "crm"
              ? caps.contractVersion === "agent-api-v1" &&
                supported.includes("simulator") &&
                Boolean(
                  (caps.featureFlags as Record<string, unknown>)
                    ?.conversationMessagePolling,
                )
              : name === "n8n"
                ? caps.contractVersion === "studio-gateway-v1" &&
                  caps.environment === "sandbox" &&
                  caps.inboundOwner === "n8n"
                : caps.contractVersion === "v1" &&
                  caps.integrationContextSupported === true &&
                  caps.idempotencySupported === true;
          return {
            name,
            status: valid ? "ready" : "incompatible",
            detail: valid
              ? "Capability discovery выполнен"
              : "Контракт не соответствует требуемой версии",
            capabilities: caps,
          };
        } catch (e) {
          return {
            name,
            status: "unreachable",
            detail: e instanceof ApiError ? e.message : "Discovery failed",
            capabilities: null,
          };
        }
      }),
    );
    const mappingReady = Boolean(c.crmProperty && c.pmsProperty);
    return {
      connections: output,
      crmReady: output[0].status === "ready" && Boolean(c.crmProperty),
      sandboxReady:
        output.every((x) => x.status === "ready") &&
        mappingReady &&
        c.callbackSecret.length >= 32,
      sandboxAttested: c.sandbox,
      mappingReady,
    };
  }
  async inbound(
    conversation: Conversation,
    identity: Identity,
    attempt: Attempt,
    client: Client,
  ) {
    return http<InboundResult>(
      this.cfg.crmUrl + "/messages/inbound",
      this.cfg,
      { "x-crm-api-key": this.cfg.crmKey },
      this.inboundPayload(conversation, identity, attempt, client),
    );
  }
  inboundPayload(
    conv: Conversation,
    identity: Identity,
    attempt: Attempt,
    client: Client,
  ) {
    return {
      channel: "simulator",
      propertyId: this.cfg.crmProperty,
      externalUserId: identity.externalUserId,
      externalChatId: conv.externalChatId,
      externalMessageId: attempt.externalMessageId,
      externalUpdateId: attempt.correlationId,
      text: attempt.text,
      firstName: client.firstName,
      lastName: client.lastName,
      displayName: client.displayName,
      language: client.language,
      attachments: attempt.attachments.map((a) => ({
        externalFileId: a.id,
        kind: a.kind,
        mimeType: a.mimeType,
        fileName: a.fileName,
        fileSize: a.size,
      })),
    };
  }
  async dispatch(
    workspaceId: string,
    conv: Conversation,
    identity: Identity,
    attempt: Attempt,
    client: Client,
    prompt: unknown,
    media: Attachment[],
    timeoutMs: number,
  ) {
    return http<{ accepted: boolean }>(
      this.cfg.n8nUrl,
      this.cfg,
      {
        Authorization: "Bearer " + this.cfg.n8nToken,
        "Idempotency-Key": `${workspaceId}:${conv.id}:${attempt.externalMessageId}`,
      },
      {
        contractVersion: "studio-gateway-v1",
        workspaceId,
        conversationId: conv.id,
        environment: "sandbox",
        runId: attempt.runId,
        correlationId: attempt.correlationId,
        inboundOwner: "n8n",
        inbound: this.inboundPayload(conv, identity, attempt, client),
        media,
        prompt,
      },
      timeoutMs,
    );
  }
  async transcript(conv: Conversation, identity: Identity, after?: string) {
    if (!conv.crmConversationId)
      return {
        messages: [] as Message[],
        nextCursor: undefined,
        hasMore: false,
      };
    const query = new URLSearchParams({
      channel: "simulator",
      propertyId: this.cfg.crmProperty,
      externalUserId: identity.externalUserId,
      limit: "100",
    });
    if (after) query.set("after", after);
    const result = await http<{
      messages: CrmMessage[];
      nextCursor: string | null;
    }>(
      `${this.cfg.crmUrl}/conversations/${encodeURIComponent(conv.crmConversationId)}/messages?${query}`,
      this.cfg,
      { "x-crm-api-key": this.cfg.crmKey },
    );
    // CRM currently includes staff notes. Filter before ever storing a guest snapshot.
    const messages = result.messages
      .filter((m) => ["in", "out"].includes(m.direction))
      .map((m) => ({
        id: m.id,
        createdAt: m.at,
        updatedAt: now(),
        conversationId: conv.id,
        direction:
          m.direction === "in" ? ("inbound" as const) : ("outbound" as const),
        senderType:
          m.direction === "in"
            ? ("guest" as const)
            : m.senderType === "ai"
              ? ("agent" as const)
              : ("human" as const),
        text: m.text ?? "",
        externalMessageId: m.externalMessageId,
        deliveryStatus: m.deliveryStatus,
        attachments: (m.attachments ?? []).map((a) => ({
          id: a.id,
          fileName: a.fileName,
          mimeType: a.mimeType,
          size: a.fileSize ?? 0,
          kind: ["image", "audio", "video"].includes(a.kind)
            ? (a.kind as "image" | "audio" | "video")
            : ("document" as const),
        })),
        source: "crm" as const,
      }));
    return {
      messages,
      nextCursor: result.nextCursor ?? result.messages.at(-1)?.id,
      hasMore: result.nextCursor !== null,
    };
  }
}
