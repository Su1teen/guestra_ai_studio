import { z } from "zod";
// Pinned to CRM aea5405 / PMS 0dc4ade. Objects strip unknown upstream fields.
export const id = z.string().min(1).max(200);
const environment = z.enum(["test", "sandbox", "production"]);
export const scopeSchema = z
  .object({
    channel: z.enum(["simulator", "telegram", "whatsapp", "instagram"]),
    externalUserId: id,
    propertyId: id,
    conversationId: id,
  })
  .strict();
export type CrmScope = z.infer<typeof scopeSchema>;
export const crmCapabilitiesSchema = z.object({
  contractVersion: z.literal("guestra-crm-integration-v2"),
  environment,
  propertyId: id,
  tenantId: id,
  pmsPropertyId: z.string().uuid(),
  pmsTenantId: id,
  deploymentId: id,
  verifiedMapping: z.literal(true),
  operationalAuthority: z.literal("guestra_pms"),
  features: z.object({
    durableOperations: z.literal(true),
    guestMessageChanges: z.literal(true),
    operationReceipts: z.literal(true),
  }),
});
export const pmsCapabilitiesSchema = z.object({
  contractVersion: z.literal("guestra-connect-v2"),
  environment,
  sourceSystem: z.literal("guestra_pms"),
  propertyId: z.string().uuid(),
  tenantId: id,
  deploymentId: id,
  credentialId: id,
  ownership: z.array(z.string()),
  features: z.object({
    acceptedQuote: z.literal(true),
    operationReceipts: z.literal(true),
    durableEvents: z.literal(true),
    authoritativeReadBack: z.literal(true),
    paymentLinks: z.boolean(),
  }),
});
export const attachmentSchema = z.object({
  id,
  externalFileId: z.string().nullish(),
  kind: z.string(),
  mimeType: z.string().nullish(),
  fileName: z.string().nullish(),
  fileSize: z.number().int().nonnegative().nullish(),
  processingStatus: z.string().optional(),
  transcript: z.string().nullish(),
});
export const crmMessageSchema = z.object({
  id,
  direction: z.enum(["in", "out"]),
  senderType: z.string().refine((x) => !["note", "internal"].includes(x)),
  text: z.string().nullable(),
  at: z.string(),
  deliveryStatus: z.string(),
  externalMessageId: z.string().nullish(),
  attachments: z.array(attachmentSchema).default([]),
});
export const changesSchema = z.object({
  contractVersion: z.literal("guest-message-changes-v1"),
  conversationId: id,
  nextCursor: z.number().int().nonnegative().safe(),
  hasMore: z.boolean(),
  changes: z.array(
    z.object({
      sequence: z.number().int().positive().safe(),
      kind: z.string(),
      messageId: id,
      message: crmMessageSchema.optional(),
    }),
  ),
});
const snapshotSchema = z.object({
  id: z.string().uuid(),
  propertyId: z.string().uuid(),
  guestId: z.string().uuid(),
  entityType: z.string(),
  revision: z.number().int().nonnegative().safe().optional(),
  status: z.string().optional(),
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  totalAmount: z.union([z.string(), z.number()]).optional(),
  currencyCode: z.string().optional(),
  integrationContext: z
    .object({
      sourceSystem: z.literal("guestra_crm"),
      customerId: id,
      conversationId: id.optional(),
      requestId: id.optional(),
      offerId: id.optional(),
    })
    .nullish(),
});
const projectionSchema = z.object({
  type: z.string(),
  id: z.string().uuid(),
  revision: z.number().int().nonnegative().safe(),
  snapshot: snapshotSchema,
  verifiedAt: z.string(),
});
const recentSchema = z.object({
  id,
  direction: z.enum(["in", "out"]),
  senderType: z.string(),
  text: z.string().nullable(),
  at: z.string(),
  attachments: z.array(attachmentSchema).default([]),
});
const safeContext = z.object({
  contractVersion: z.literal("agent-api-v1"),
  property: z.object({ id, name: z.string(), timezone: z.string() }),
  customer: z.object({
    id,
    name: z.string().nullable(),
    language: z.string(),
    repeatGuest: z.boolean(),
    stayCount: z.number(),
  }),
  conversation: z.object({
    id,
    channel: z.string(),
    automationMode: z.enum(["ai", "human", "needs_human"]),
  }),
  lifecycle: z.string(),
  request: z
    .object({
      id,
      stage: z.string(),
      status: z.string(),
      requestLifecycle: z.string(),
      checkIn: z.string().nullish(),
      checkOut: z.string().nullish(),
      adults: z.number(),
      children: z.number(),
      category: z.string().nullish(),
    })
    .nullable(),
  offer: z
    .object({
      id,
      status: z.string(),
      expiresAt: z.string(),
      total: z.number(),
      deposit: z.number(),
      currency: z.string(),
    })
    .nullable(),
  recentMessages: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter(
            (m) =>
              m &&
              ["in", "out"].includes(m.direction) &&
              !["note", "internal"].includes(m.senderType),
          )
        : value,
    z.array(recentSchema),
  ),
  aiReplyAllowed: z.boolean(),
  allowedActions: z.array(z.string()),
  operationalAuthority: z.literal("guestra_pms"),
  pmsReferences: z.array(projectionSchema).default([]),
});
export const contextSchema = z.object({
  customerId: id,
  conversationId: id,
  automationMode: z.enum(["ai", "human", "needs_human"]),
  context: safeContext,
  aiReplyAllowed: z.boolean(),
  operationalAuthority: z.literal("guestra_pms"),
  projections: z.array(projectionSchema),
});
export const operationSchema = z
  .object({
    operationId: id,
    operationKey: id.optional(),
    status: z.enum(["pending", "completed", "rejected"]),
    result: snapshotSchema.nullish(),
    snapshot: snapshotSchema.nullish(),
    errorCode: z.string().nullish(),
    attempts: z.number().int().nonnegative().optional(),
    duplicate: z.boolean().optional(),
  })
  .refine(
    (x) => x.status !== "completed" || Boolean(x.snapshot ?? x.result),
    "Completed requires authoritative read-back",
  );
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const confirmation = {
  proposalMessageId: id,
  confirmationMessageId: id,
  idempotencyKey: id.max(120),
};
const revision = {
  entityId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
};
const servicePayload = z
  .object({
    serviceId: z.string().uuid(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    participants: z.number().int().positive().max(10000),
    quantity: z.number().int().positive().max(10000).default(1),
    expectedTotal: z.string().regex(/^\d+(\.\d{1,2})?$/),
    reservationId: z.string().uuid().optional(),
  })
  .strict();
export const actionSchema = z.discriminatedUnion("actionType", [
  scopeSchema.extend({
    ...confirmation,
    actionType: z.literal("book_service"),
    payload: servicePayload,
  }),
  scopeSchema.extend({
    ...confirmation,
    actionType: z.literal("reschedule_service"),
    payload: z
      .object({
        ...revision,
        startAt: z.string().datetime(),
        endAt: z.string().datetime(),
      })
      .strict(),
  }),
  scopeSchema.extend({
    ...confirmation,
    actionType: z.literal("cancel_service"),
    payload: z.object(revision).strict(),
  }),
  scopeSchema.extend({
    ...confirmation,
    actionType: z.literal("cancel_accommodation"),
    payload: z
      .object({
        entityId: z.string().uuid(),
        expectedUpdatedAt: z.string().datetime(),
        reason: z.string().max(1000).optional(),
      })
      .strict(),
  }),
  scopeSchema.extend({
    ...confirmation,
    actionType: z.literal("amend_accommodation"),
    payload: z
      .object({
        entityId: z.string().uuid(),
        expectedUpdatedAt: z.string().datetime(),
        acceptedQuote: z.string().min(1).max(20000),
      })
      .strict(),
  }),
]);
export const searchSchema = scopeSchema.extend({
  checkIn: date,
  checkOut: date,
  adults: z.number().int().positive().max(100),
  children: z.number().int().nonnegative().max(100).default(0),
});
export const offerSchema = scopeSchema.extend({
  requestId: id,
  roomTypeId: z.string().uuid(),
  ratePlanId: z.string().uuid(),
  idempotencyKey: id.max(120),
});
export const bookSchema = scopeSchema.extend({ ...confirmation, offerId: id });
export const availabilitySchema = scopeSchema.extend({
  serviceId: z.string().uuid(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  quantity: z.number().int().positive().max(10000).default(1),
  participants: z.number().int().positive().max(10000).default(1),
});
export const guestRequestSchema = scopeSchema.extend({
  sourceMessageId: id,
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).optional(),
  department: z
    .enum([
      "reception",
      "housekeeping",
      "maintenance",
      "restaurant",
      "spa",
      "transport",
      "other",
    ])
    .default("reception"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  idempotencyKey: id.max(120),
});
export const inspectorSchema = z.object({
  customerId: id,
  conversationId: id,
  events: z.array(
    z.object({
      id,
      tool: z.string(),
      statusCode: z.number().int(),
      success: z.boolean(),
      errorCode: z.string().nullish(),
      durationMs: z.number().nonnegative(),
      at: z.string(),
      operationReference: z.string().nullish(),
      references: z.object({
        correlationId: id.optional(),
        executionReference: id.optional(),
        promptVersion: id.optional(),
        deploymentReference: id.optional(),
        messageId: id.optional(),
        requestId: id.optional(),
        offerId: id.optional(),
        operationId: id.optional(),
        reservationId: id.optional(),
        serviceBookingId: id.optional(),
      }),
    }),
  ),
});
export const canonicalStages = [
  "new_contact",
  "returning_customer",
  "enquire",
  "tentative",
  "definite",
  "pending_payment",
  "confirmed_reservation",
  "pre_arrival",
  "in_house",
  "service_only",
  "due_out",
  "post_stay",
  "cancelled",
  "human_handoff",
] as const;
export const fixtureInputSchema = z
  .object({
    propertyId: id,
    fixtureId: id.max(120),
    stage: z.enum(canonicalStages),
  })
  .strict();
export const fixtureSchema = z.object({
  contractVersion: z.literal("guestra-fixtures-v1"),
  propertyId: id,
  pmsPropertyId: z.string().uuid(),
  fixtureId: id,
  stage: z.enum(canonicalStages),
  customerId: id,
  conversationId: id,
  requestId: id.nullish(),
  externalUserId: id,
  expiresAt: z.string().datetime({ offset: true }),
  refs: z.object({
    guestId: z.string().uuid(),
    reservationId: z.string().uuid().optional(),
    bookingId: z.string().uuid().optional(),
    folioId: z.string().uuid().optional(),
    serviceBookingId: z.string().uuid().optional(),
  }),
  snapshots: z.array(snapshotSchema),
  simulatedPayment: z
    .object({
      source: z.literal("simulated"),
      status: z.string(),
      ledgerEffect: z.literal(false),
      providerVerified: z.literal(false).optional(),
    })
    .nullable(),
});
export const stageMapping: Record<string, (typeof canonicalStages)[number]> = {
  new_contact: "new_contact",
  known_customer: "returning_customer",
  returning_guest: "returning_customer",
  commercial_request: "enquire",
  confirmed: "confirmed_reservation",
  ...Object.fromEntries(canonicalStages.map((x) => [x, x])),
};
export const toolAliases: Record<string, string> = {
  check_accommodation_availability: "search_accommodation",
  get_accommodation_options: "search_accommodation",
  create_offer: "create_pms_offer",
};
export function approvedTools(
  configured: string[],
  allowedActions: string[],
  aiReplyAllowed: boolean,
) {
  if (!aiReplyAllowed) return [];
  return [
    ...new Set(configured.map((tool) => toolAliases[tool] ?? tool)),
  ].filter((tool) => allowedActions.includes(tool));
}
