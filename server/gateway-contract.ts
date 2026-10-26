import { createHash } from "node:crypto";
import { z } from "zod";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const payloadHash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const envelopeSchema = z
  .object({
    contractVersion: z.literal("studio-gateway-v1"),
    workspaceId: z.string().min(1),
    conversationId: z.string().min(1),
    environment: z.enum(["test", "sandbox", "production"]),
    runId: z.string().uuid(),
    correlationId: z.string().uuid(),
    inboundOwner: z.literal("n8n"),
    externalMessageId: z.string().uuid(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    property: z
      .object({
        crmPropertyId: z.string().min(1),
        crmTenantId: z.string().min(1),
        pmsPropertyId: z.string().uuid(),
        pmsTenantId: z.string().min(1),
      })
      .strict(),
    inbound: z
      .object({
        channel: z.literal("simulator"),
        propertyId: z.string(),
        externalUserId: z.string(),
        externalChatId: z.string(),
        externalMessageId: z.string().uuid(),
        externalUpdateId: z.string().uuid(),
        text: z.string().max(8000),
        firstName: z.string(),
        lastName: z.string(),
        displayName: z.string(),
        language: z.string(),
        attachments: z.array(
          z.object({
            externalFileId: z.string(),
            kind: z.string(),
            mimeType: z.string(),
            fileName: z.string(),
            fileSize: z.number(),
          }),
        ),
      })
      .strict(),
    media: z
      .array(
        z.object({
          id: z.string(),
          fileName: z.string(),
          mimeType: z.string(),
          size: z.number(),
          kind: z.string(),
          scanStatus: z.literal("clean"),
          url: z.string().url().optional(),
        }),
      )
      .max(5),
    prompt: z
      .object({
        versionId: z.string(),
        body: z.string().max(50000),
        model: z.string(),
        workflowId: z.string(),
        configuration: z.object({
          timeoutMs: z.number(),
          maxRetries: z.number(),
          tools: z.array(z.string()),
          flags: z.record(z.string(), z.boolean()),
        }),
      })
      .strict(),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export function envelopeHash(value: Omit<Envelope, "payloadHash"> | Envelope) {
  const { payloadHash: _hash, ...rest } = value as Envelope;
  return payloadHash({
    ...rest,
    media: rest.media.map(({ url: _url, ...asset }) => asset),
  });
}
export const acceptedSchema = z.object({
  accepted: z.literal(true),
  runId: z.string(),
  payloadHash: z.string(),
  durablyClaimed: z.literal(true),
  duplicate: z.boolean().optional(),
});
export const executionStates = [
  "dispatch_accepted",
  "inbound_saved",
  "agent_processing",
  "tool_execution",
  "business_pending",
  "business_completed",
  "reply_prepared",
  "reply_delivered",
  "completed",
  "failed",
  "human_owned",
  "completion_unknown",
] as const;
export const executionRank: Record<string, number> = {
  dispatch_accepted: 0,
  inbound_saved: 1,
  agent_processing: 2,
  tool_execution: 3,
  business_pending: 4,
  business_completed: 5,
  reply_prepared: 6,
  reply_delivered: 7,
  completed: 8,
  failed: 8,
  human_owned: 9,
  completion_unknown: -1,
};
