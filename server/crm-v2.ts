import { z } from "zod";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import { integrationHttp } from "./integration-http.js";
import * as c from "./crm-v2-contracts.js";
export class CrmV2Adapter {
  private attestation?: {
    key: string;
    expiresAt: number;
    value: z.output<typeof c.crmCapabilitiesSchema>;
  };
  constructor(
    public cfg: Config,
    private trace: Record<string, string> = {},
  ) {}
  withTrace(input: {
    correlationId: string;
    executionReference?: string;
    promptVersion?: string;
    deploymentReference?: string;
  }) {
    const schema = z
      .object({
        correlationId: z
          .string()
          .max(160)
          .regex(/^[A-Za-z0-9._:/-]+$/),
        executionReference: z
          .string()
          .max(160)
          .regex(/^[A-Za-z0-9._:/-]+$/)
          .optional(),
        promptVersion: z
          .string()
          .max(160)
          .regex(/^[A-Za-z0-9._:/-]+$/)
          .optional(),
        deploymentReference: z
          .string()
          .max(160)
          .regex(/^[A-Za-z0-9._:/-]+$/)
          .optional(),
      })
      .strict();
    return new CrmV2Adapter(
      this.cfg,
      Object.fromEntries(
        Object.entries(schema.parse(input)).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
  }
  async request<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<z.output<S>> {
    if (!this.cfg.crmKey)
      throw new ApiError(503, "NOT_CONFIGURED", "CRM credentials не настроены");
    const property =
      query.propertyId ??
      (body as { propertyId?: unknown } | undefined)?.propertyId;
    if (property !== this.cfg.crmProperty)
      throw new ApiError(
        403,
        "ENVIRONMENT_MISMATCH",
        "Adapter property scope mismatch",
      );
    if (path !== "capabilities") await this.attest();
    const url = new URL(this.cfg.crmUrl.replace(/\/$/, "") + "/v2/" + path);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    if (path !== "capabilities")
      for (const [key, value] of Object.entries(this.trace))
        url.searchParams.set(key, value);
    return integrationHttp(
      url.toString(),
      this.cfg,
      { "x-crm-api-key": this.cfg.crmKey },
      schema,
      body,
    );
  }
  capabilities() {
    return this.request("capabilities", c.crmCapabilitiesSchema, undefined, {
      propertyId: this.cfg.crmProperty,
    });
  }
  async attest(force = false) {
    const key = JSON.stringify([
      this.cfg.crmUrl,
      this.cfg.crmKey,
      this.cfg.crmProperty,
      this.cfg.pmsProperty,
      this.cfg.crmTenant,
      this.cfg.pmsTenant,
      this.cfg.environment,
    ]);
    if (
      !force &&
      this.attestation?.key === key &&
      this.attestation.expiresAt > Date.now()
    )
      return this.attestation.value;
    const cap = await this.capabilities();
    if (cap.environment !== (this.cfg.environment ?? "production"))
      throw new ApiError(
        403,
        "ENVIRONMENT_MISMATCH",
        "CRM environment mismatch",
      );
    if (
      cap.propertyId !== this.cfg.crmProperty ||
      cap.pmsPropertyId !== this.cfg.pmsProperty ||
      !this.cfg.crmTenant ||
      !this.cfg.pmsTenant ||
      cap.tenantId !== this.cfg.crmTenant ||
      cap.pmsTenantId !== this.cfg.pmsTenant
    )
      throw new ApiError(
        403,
        "ENVIRONMENT_MISMATCH",
        "Property / tenant mapping не подтверждён",
      );
    this.attestation = { key, expiresAt: Date.now() + 5000, value: cap };
    return cap;
  }
  async sandbox() {
    if (
      !this.cfg.sandbox ||
      !["test", "sandbox"].includes(this.cfg.environment ?? "production")
    )
      throw new ApiError(
        403,
        "SANDBOX_REQUIRED",
        "Нужна отдельная подтверждённая sandbox среда",
      );
    await this.attest(true);
  }
  async context(scope: c.CrmScope) {
    const input = c.scopeSchema.parse(scope);
    const result = await this.request(
      "context",
      c.contextSchema,
      undefined,
      input,
    );
    if (
      result.conversationId !== input.conversationId ||
      result.context.conversation.id !== input.conversationId ||
      result.customerId !== result.context.customer.id ||
      result.context.property.id !== input.propertyId ||
      result.aiReplyAllowed !== result.context.aiReplyAllowed ||
      result.automationMode !== result.context.conversation.automationMode
    )
      throw new ApiError(
        409,
        "IDENTITY_CONFLICT",
        "CRM context references mismatch",
      );
    for (const p of [...result.projections, ...result.context.pmsReferences])
      if (
        p.snapshot.propertyId !== this.cfg.pmsProperty ||
        p.snapshot.id !== p.id ||
        (p.snapshot.integrationContext &&
          p.snapshot.integrationContext.customerId !== result.customerId)
      )
        throw new ApiError(409, "IDENTITY_CONFLICT", "PMS evidence mismatch");
    return result;
  }
  async changes(scope: c.CrmScope, after = 0) {
    const s = c.scopeSchema.parse(scope);
    const result = await this.request(
      `conversations/${encodeURIComponent(s.conversationId)}/changes`,
      c.changesSchema,
      undefined,
      { ...s, after: String(after), limit: "100" },
    );
    if (
      result.conversationId !== s.conversationId ||
      result.nextCursor < after ||
      result.changes.some(
        (x, i) =>
          x.sequence <= after ||
          x.sequence > result.nextCursor ||
          (i > 0 && x.sequence <= result.changes[i - 1].sequence) ||
          (x.kind !== "tombstone" &&
            (!x.message || x.message.id !== x.messageId)),
      ) ||
      (result.hasMore && result.nextCursor === after)
    )
      throw new ApiError(502, "CONTRACT_MISMATCH", "Неверный changes cursor");
    return result;
  }
  async inspector(scope: c.CrmScope) {
    const input = c.scopeSchema.parse(scope),
      result = await this.request(
        "inspector",
        c.inspectorSchema,
        undefined,
        input,
      );
    if (result.conversationId !== scope.conversationId)
      throw new ApiError(
        409,
        "IDENTITY_CONFLICT",
        "Inspector conversation mismatch",
      );
    return result;
  }
  // Business writes are prepared for isolated integration tests; production activation is a later task.
  async mutate<S extends z.ZodTypeAny>(
    path: string,
    input: unknown,
    schema: S,
  ): Promise<z.output<S>> {
    await this.sandbox();
    return this.request(path, schema, input);
  }
  async search(input: z.input<typeof c.searchSchema>) {
    const data = c.searchSchema.parse(input);
    await this.attest();
    return this.request(
      "accommodations/search",
      z.object({
        source: z.literal("haip"),
        sourceVersion: z.string(),
        searchId: z.string().uuid(),
        timestamp: z.string(),
        results: z.array(z.record(z.unknown())),
        totalResults: z.number().int().nonnegative(),
        responseTimeMs: z.number().nonnegative(),
      }),
      data,
    );
  }
  offer(input: z.input<typeof c.offerSchema>) {
    return this.mutate(
      "offers",
      c.offerSchema.parse(input),
      z.object({
        offer: z.object({ id: c.id }).passthrough(),
        pricing: z
          .object({
            acceptedQuote: z.string().min(1).max(20000),
            totalAmount: z.string(),
            currency: z.string(),
            expiresAt: z.string(),
          })
          .passthrough(),
        duplicate: z.boolean(),
      }),
    );
  }
  book(input: z.input<typeof c.bookSchema>) {
    return this.mutate(
      "accommodations/book",
      c.bookSchema.parse(input),
      c.operationSchema,
    );
  }
  services(scope: c.CrmScope) {
    return this.request(
      "services",
      z.object({ services: z.array(z.record(z.unknown())) }),
      undefined,
      c.scopeSchema.parse(scope),
    );
  }
  availability(input: z.input<typeof c.availabilitySchema>) {
    return this.request(
      "services/availability",
      z.object({ available: z.boolean() }).passthrough(),
      c.availabilitySchema.parse(input),
    );
  }
  action(input: z.input<typeof c.actionSchema>) {
    return this.mutate(
      "actions",
      c.actionSchema.parse(input),
      c.operationSchema,
    );
  }
  guestRequest(input: z.input<typeof c.guestRequestSchema>) {
    return this.mutate(
      "guest-requests",
      c.guestRequestSchema.parse(input),
      c.operationSchema,
    );
  }
  async operation(scope: c.CrmScope, id: string) {
    const result = await this.request(
      "operations/" + encodeURIComponent(c.id.parse(id)),
      c.operationSchema,
      undefined,
      c.scopeSchema.parse(scope),
    );
    if (result.operationId !== id)
      throw new ApiError(
        409,
        "IDENTITY_CONFLICT",
        "Operation reference mismatch",
      );
    return result;
  }
  mediaReference(
    scope: c.CrmScope,
    attachmentId: string,
    input: {
      workspaceId: string;
      referenceUrl: string;
      expiresAt: string;
      mimeType: string;
      fileSize: number;
      scanStatus: "clean";
      callId?: string;
    },
  ) {
    const data = c.scopeSchema
      .extend({
        workspaceId: c.id,
        referenceUrl: z.string().url().max(4000),
        expiresAt: z.string().datetime(),
        mimeType: z.enum([
          "image/jpeg",
          "image/png",
          "image/webp",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "audio/ogg",
          "audio/mpeg",
          "audio/wav",
          "audio/webm",
          "video/mp4",
          "video/webm",
        ]),
        fileSize: z
          .number()
          .int()
          .positive()
          .max(20 * 1024 * 1024),
        scanStatus: z.literal("clean"),
        callId: z.string().max(160).optional(),
      })
      .parse({ ...scope, ...input });
    return this.mutate(
      `media/${encodeURIComponent(c.id.parse(attachmentId))}/reference`,
      data,
      z.object({
        mediaReferenceId: c.id,
        expiresAt: z.string(),
        workspaceId: c.id,
      }),
    );
  }
  mediaUrl(scope: c.CrmScope, attachmentId: string) {
    return this.request(
      `media/${encodeURIComponent(c.id.parse(attachmentId))}/url`,
      z.object({
        mediaReferenceId: c.id,
        url: z.string(),
        expiresAt: z.string(),
      }),
      undefined,
      c.scopeSchema.parse(scope),
    );
  }
  fixture(input: z.input<typeof c.fixtureInputSchema>) {
    return this.mutate(
      "sandbox/fixtures",
      c.fixtureInputSchema.parse(input),
      c.fixtureSchema,
    );
  }
  retire(fixtureId: string) {
    return this.mutate(
      `sandbox/fixtures/${encodeURIComponent(c.id.parse(fixtureId))}/retire`,
      { propertyId: this.cfg.crmProperty },
      z.object({
        fixtureId: c.id,
        retired: z.literal(true),
        retainedForAudit: z.literal(true),
      }),
    );
  }
  simulatePayment(fixtureId: string) {
    return this.mutate(
      `sandbox/fixtures/${encodeURIComponent(c.id.parse(fixtureId))}/simulate-payment`,
      { propertyId: this.cfg.crmProperty },
      z.object({
        fixtureId: c.id,
        simulatedPayment: z.object({
          source: z.literal("simulated"),
          status: z.literal("confirmed"),
          ledgerEffect: z.literal(false),
          providerVerified: z.literal(false),
        }),
      }),
    );
  }
}
