import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { UserRow } from "../db.js";
import { getAnthropicKey } from "../users.js";
import { config } from "../config.js";

export class AiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "AiError";
  }
}

// Server-side refusal fallback is supported on these models; Haiku has none.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export function clientFor(user: UserRow): { client: Anthropic; model: string } {
  const apiKey = getAnthropicKey(user);
  if (!apiKey) throw new AiError("Add your Anthropic API key in Settings to use the AI features.", 400);
  return { client: new Anthropic({ apiKey }), model: user.model || config.ai.defaultModel };
}

/** Checks a key before we store it. Listing models is free. */
export async function verifyApiKey(apiKey: string): Promise<void> {
  try {
    await new Anthropic({ apiKey }).models.list({ limit: 1 });
  } catch (err) {
    throw toAiError(err);
  }
}

export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AiError("Your Anthropic API key was rejected. Check it in Settings.", 400);
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError("Your Anthropic API key doesn't have access to this model.", 400);
  if (err instanceof Anthropic.NotFoundError) return new AiError("The selected Claude model isn't available to your API key. Pick another in Settings.", 400);
  if (err instanceof Anthropic.RateLimitError) return new AiError("Anthropic rate limit reached. Wait a moment and try again.", 429);
  if (err instanceof Anthropic.BadRequestError) return new AiError(`Claude rejected the request: ${err.message}`, 400);
  if (err instanceof Anthropic.APIError) return new AiError(`Claude API error (${err.status ?? "network"}): ${err.message}`, 502);
  return new AiError((err as Error)?.message ?? "Unknown AI error", 500);
}

export interface StructuredRequest<S extends z.ZodType> {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: S;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

/** One Claude call that returns JSON validated against `schema`. */
export async function structured<S extends z.ZodType>(user: UserRow, req: StructuredRequest<S>): Promise<z.infer<S>> {
  const { client, model } = clientFor(user);
  const useFallbacks = FALLBACK_MODELS.has(model);
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: req.maxTokens ?? 16000,
      // The author profile is the stable prefix across a user's requests; cache it.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.content }],
      output_config: { effort: req.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    if (response.stop_reason === "refusal") {
      throw new AiError("Claude declined to write this one. Try rephrasing your notes or using different material.", 422);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiError("Claude ran out of room before finishing. Try fewer variations or shorter material.", 502);
    }
    if (!response.parsed_output) throw new AiError("Claude returned an unexpected response. Please try again.", 502);
    return response.parsed_output as z.infer<S>;
  } catch (err) {
    throw toAiError(err);
  }
}
