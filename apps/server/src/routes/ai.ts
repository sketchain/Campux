import type { FastifyInstance } from "fastify";
import { PRIVATE_POST_PROMPT_MAX_LENGTH } from "@campux/domain";
import { z } from "zod";
import { requireTenantRole } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { readTenantAiSettings, testTenantAiSettings, updateTenantAiSettings } from "../runtime/ai-settings";
import { POST_REVIEW_MAX_RETRIES_LIMIT, POST_REVIEW_PROMPT_MAX_LENGTH } from "../runtime/ai-post-review-settings";
import { testPostReviewModel } from "../runtime/ai-post-review";
import {
  LLM_EXTRA_BODY_MAX_BYTES,
  LLM_MAX_TOKENS_LIMIT,
  LLM_TIMEOUT_SECONDS_MAX,
  LLM_TIMEOUT_SECONDS_MIN,
  llmApiFormats,
  llmJsonModes,
  llmMaxTokensFields,
  llmReasoningEfforts,
  llmTemperatureModes,
} from "../runtime/llm-params";

export const llmParamsSchema = z.object({
  apiFormat: z.enum(llmApiFormats).optional(),
  maxTokensField: z.enum(llmMaxTokensFields).optional(),
  maxTokens: z.number().int().min(1).max(LLM_MAX_TOKENS_LIMIT).nullable().optional(),
  reasoningEffort: z.enum(llmReasoningEfforts).optional(),
  temperatureMode: z.enum(llmTemperatureModes).optional(),
  temperature: z.number().min(0).max(2).optional(),
  jsonMode: z.enum(llmJsonModes).optional(),
  stream: z.boolean().optional(),
  extraBody: z.record(z.unknown()).refine((value) => JSON.stringify(value).length <= LLM_EXTRA_BODY_MAX_BYTES, "额外请求体过大").optional(),
  timeoutSeconds: z.number().int().min(LLM_TIMEOUT_SECONDS_MIN).max(LLM_TIMEOUT_SECONDS_MAX).nullable().optional(),
});

export const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["local", "llm"]).optional(),
  provider: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().url().optional(),
  model: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  temperature: z.number().min(0).max(1).optional(),
  timeoutSeconds: z.number().int().min(5).max(120).optional(),
  rules: z.object({
    privatePostAiEnabled: z.boolean().optional(),
    postTaggingEnabled: z.boolean().optional(),
    postTagMaintenanceEnabled: z.boolean().optional(),
    privatePostAggregateDelaySeconds: z.number().int().min(0).max(120).optional(),
    postTriggerKeywords: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
    privatePostPrompt: z.string().trim().max(PRIVATE_POST_PROMPT_MAX_LENGTH).optional(),
    llmParams: llmParamsSchema.optional(),
    postReviewFallbackParams: llmParamsSchema.optional(),
    postReviewEnabled: z.boolean().optional(),
    postReviewPrompt: z.string().trim().max(POST_REVIEW_PROMPT_MAX_LENGTH).optional(),
    postReviewMaxRetries: z.number().int().min(0).max(POST_REVIEW_MAX_RETRIES_LIMIT).optional(),
    postReviewFallbackBaseUrl: z.union([z.literal(""), z.string().trim().url()]).optional(),
    postReviewFallbackModel: z.string().trim().max(120).optional(),
    postReviewFallbackApiKey: z.string().max(500).optional(),
    postReviewFallbackClearApiKey: z.boolean().optional(),
  }).optional(),
});

const postReviewTestSchema = aiSettingsSchema.extend({
  target: z.enum(["primary", "fallback"]).default("primary"),
});

export function registerAiRoutes(app: FastifyInstance) {
  app.get("/api/admin/ai/settings", async (request, reply) => {
    const context = await requireTenantRole(request, reply, "admin");
    return {
      settings: await readTenantAiSettings(context.selectedTenant.id),
    };
  });

  app.patch("/api/admin/ai/settings", async (request, reply) => {
    const context = await requireTenantRole(request, reply, "admin");
    const body = aiSettingsSchema.parse(request.body ?? {});
    const settings = await updateTenantAiSettings(context.selectedTenant.id, body);

    await writeAuditLog({
      tenantId: context.selectedTenant.id,
      actorId: context.user.id,
      action: "tenant.ai.settings.update",
      targetType: "tenant",
      targetId: context.selectedTenant.id,
      detail: {
        fields: Object.keys(body).filter((key) => key !== "apiKey"),
        apiKeyUpdated: Boolean(body.apiKey || body.clearApiKey),
        postReviewFallbackApiKeyUpdated: Boolean(body.rules?.postReviewFallbackApiKey || body.rules?.postReviewFallbackClearApiKey),
      },
    });

    return { settings };
  });

  app.post("/api/admin/ai/settings/test", async (request, reply) => {
    const context = await requireTenantRole(request, reply, "admin");
    const body = aiSettingsSchema.parse(request.body ?? {});
    const result = await testTenantAiSettings(context.selectedTenant.id, body);

    await writeAuditLog({
      tenantId: context.selectedTenant.id,
      actorId: context.user.id,
      action: "tenant.ai.settings.test",
      targetType: "tenant",
      targetId: context.selectedTenant.id,
      detail: {
        ok: result.ok,
        mode: result.mode,
        provider: result.provider,
        model: result.model,
        baseUrl: result.baseUrl,
        latencyMs: result.latencyMs,
      },
    });

    return { result };
  });

  app.post("/api/admin/ai/post-review/test", async (request, reply) => {
    const context = await requireTenantRole(request, reply, "admin");
    const { target, ...body } = postReviewTestSchema.parse(request.body ?? {});
    const result = await testPostReviewModel(context.selectedTenant.id, body, target);

    await writeAuditLog({
      tenantId: context.selectedTenant.id,
      actorId: context.user.id,
      action: "tenant.ai.post_review.test",
      targetType: "tenant",
      targetId: context.selectedTenant.id,
      detail: {
        ok: result.ok,
        target: result.target,
        model: result.model,
        baseUrl: result.baseUrl,
        latencyMs: result.latencyMs,
      },
    });

    return { result };
  });
}
