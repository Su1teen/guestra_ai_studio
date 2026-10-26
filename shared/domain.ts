import { z } from "zod";
export const channels = ["whatsapp", "telegram", "instagram", "web"] as const;
export const stages = [
  "new_contact",
  "known_customer",
  "commercial_request",
  "enquire",
  "tentative",
  "definite",
  "pending_payment",
  "confirmed",
  "pre_arrival",
  "in_house",
  "service_only",
  "post_stay",
  "returning_guest",
  "due_out",
  "cancelled",
  "human_handoff",
] as const;
export type Mode = "preview" | "crm" | "sandbox";
export type Role = "admin" | "tester" | "reviewer" | "viewer";
export interface RecordBase {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface Client extends RecordBase {
  firstName: string;
  lastName: string;
  displayName: string;
  phone: string;
  telegram: string;
  channel: (typeof channels)[number];
  language: string;
  property: string;
  parameters: Record<string, string>;
}
export interface Identity extends RecordBase {
  clientId: string;
  displayChannel: (typeof channels)[number];
  transportChannel: "simulator";
  externalUserId: string;
  crmCustomerId?: string;
  pmsGuestId?: string;
  environment?: string;
  verifiedAt?: string;
  verificationSource?: string;
}
export interface Conversation extends RecordBase {
  agentId?: string;
  promptVersionId?: string;
  clientId: string;
  identityId: string;
  title: string;
  externalChatId: string;
  mode: Mode;
  crmConversationId?: string;
  cursor?: string;
  changesCursor?: number;
  propertyMapping?: {
    crmPropertyId: string;
    crmTenantId: string;
    pmsPropertyId: string;
    pmsTenantId: string;
    environment: string;
  };
  crmCustomerId?: string;
  pmsGuestId?: string;
  stage: string;
  draft: string;
  verdict: "unreviewed" | "pass" | "fail";
  lastText: string;
  unread: number;
  handoff: boolean;
  setupStatus: "READY" | "PREVIEW_ONLY" | "SETUP_UNAVAILABLE";
}
export interface Attachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "document" | "audio" | "video";
  url?: string;
  scanStatus?: string;
  externalFileId?: string;
  processingStatus?: string;
  transcript?: string;
}
export interface Message extends RecordBase {
  sequence?: number;
  conversationId: string;
  direction: "inbound" | "outbound";
  senderType: "guest" | "agent" | "human";
  text: string;
  externalMessageId?: string;
  deliveryStatus: string;
  attachments: Attachment[];
  replyTo?: string;
  source: "preview" | "crm";
  tombstone?: boolean;
  changeSequence?: number;
}
export interface Attempt extends RecordBase {
  conversationId: string;
  correlationId: string;
  externalMessageId: string;
  text: string;
  attachments: Attachment[];
  replyTo?: string;
  status: "queued" | "processing" | "awaiting_crm" | "delivered" | "failed";
  tries: number;
  nextAt: string;
  sequence: number;
  payloadHash: string;
  error?: string;
  crmMessageId?: string;
  runId: string;
}
export interface Run extends RecordBase {
  conversationId: string;
  correlationId: string;
  status: string;
  promptVersionId: string;
  promptSnapshot: string;
  model: string;
  workflowId: string;
  configuration: {
    timeoutMs: number;
    maxRetries: number;
    tools: string[];
    flags: Record<string, boolean>;
  };
  tools: {
    id: string;
    name: string;
    status: string;
    durationMs: number;
    summary: string;
    businessReference?: string;
  }[];
  durationMs: number;
  error?: string;
  agentId?: string;
  promptHash?: string;
  dispatchHash?: string;
  dispatchEnvelope?: import("../server/gateway-contract.js").Envelope;
  claim?: { payloadHash: string; executionId: string; claimedAt: string };
  lastEventSequence?: number;
  executionId?: string;
  workflowVersion?: string;
  deploymentId?: string;
  contextVersion?: string;
  allowedActions?: string[];
  businessOperationId?: string;
  businessStatus?: string;
}
export interface Annotation extends RecordBase {
  conversationId: string;
  targetType:
    | "conversation"
    | "message"
    | "run"
    | "tool"
    | "call"
    | "operation"
    | "deployment";
  targetId: string;
  author: string;
  body: string;
  severity: "info" | "warning" | "critical";
  type: string;
  flags: string[];
  status: "open" | "resolved";
  history: { at: string; author: string; body: string; status: string }[];
  externalReference?: string;
}
export interface Agent extends RecordBase {
  name: string;
  description: string;
  workflowId: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  tools: string[];
  flags: Record<string, boolean>;
  activeVersionId: string;
}
export interface Prompt extends RecordBase {
  agentId: string;
  version: number;
  body: string;
  status: "draft" | "test" | "published";
  deploymentState?:
    | "LOCAL_DRAFT"
    | "TEST_VERSION"
    | "STUDIO_PUBLISHED"
    | "N8N_DEPLOYMENT_PENDING"
    | "N8N_DEPLOYED"
    | "DEPLOYMENT_FAILED"
    | "ROLLED_BACK";
  deploymentId?: string;
  readBackHash?: string;
  author: string;
  parentId?: string;
}
export interface Scenario extends RecordBase {
  name: string;
  description: string;
  stage: (typeof stages)[number];
  opening: string;
  assertions: {
    name: string;
    kind: "contains" | "no_unconfirmed_delivery";
    value: string;
  }[];
}
export interface ScenarioRun extends RecordBase {
  scenarioId: string;
  conversationId: string;
  status: "PREVIEW_ONLY" | "SETUP_UNAVAILABLE" | "READY";
  reason: string;
  assertions: {
    name: string;
    status: "pending" | "pass" | "fail";
    detail: string;
  }[];
  references: Record<string, string>;
}
export interface Call extends RecordBase {
  conversationId: string;
  runId?: string;
  direction: "incoming" | "outgoing";
  status: "ringing" | "active" | "rejected" | "ended";
  startedAt?: string;
  endedAt?: string;
  durationSeconds: number;
  turns: {
    id: string;
    speaker: "guest" | "agent";
    text: string;
    at: string;
    mediaId?: string;
  }[];
}
export const clientSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80).default(""),
    displayName: z.string().trim().min(1).max(160),
    phone: z.string().max(32).default(""),
    telegram: z.string().max(80).default(""),
    channel: z.enum(channels),
    language: z.enum(["ru", "kk", "en"]).default("ru"),
    property: z.literal("LES Боровое").default("LES Боровое"),
    parameters: z.record(z.string(), z.string().max(500)).default({}),
  })
  .strict();
export const conversationSchema = z
  .object({
    agentId: z.string().optional(),
    promptVersionId: z.string().min(1).optional(),
    clientId: z.string().min(1),
    title: z.string().trim().min(1).max(150),
    channel: z.enum(channels),
    stage: z.enum(stages).default("new_contact"),
  })
  .strict();
export const messageSchema = z
  .object({
    externalMessageId: z.string().uuid(),
    text: z.string().trim().max(8000).default(""),
    attachmentIds: z.array(z.string()).max(5).default([]),
    replyTo: z.string().optional(),
  })
  .strict()
  .refine(
    (v) => v.text.length > 0 || v.attachmentIds.length > 0,
    "Сообщение пустое",
  );
export const annotationSchema = z
  .object({
    conversationId: z.string(),
    targetType: z.enum([
      "conversation",
      "message",
      "run",
      "tool",
      "call",
      "operation",
      "deployment",
    ]),
    targetId: z.string(),
    body: z.string().trim().min(1).max(4000),
    severity: z.enum(["info", "warning", "critical"]),
    type: z.string().max(80),
    flags: z.array(z.string().max(80)).max(10).default([]),
  })
  .strict();
export const scenarioSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    description: z.string().max(2000),
    stage: z.enum(stages),
    opening: z.string().max(8000),
    assertions: z
      .array(
        z.object({
          name: z.string().min(1),
          kind: z.enum(["contains", "no_unconfirmed_delivery"]),
          value: z.string(),
        }),
      )
      .max(20),
  })
  .strict();
