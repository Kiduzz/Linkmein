import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

// Claude is called straight from the browser with the user's own key, which never
// leaves their device except to go to Anthropic.

export class AiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface AiContext {
  /** The author's name, used in prompts. */
  name: string;
  apiKey: string | null;
  model: string;
}

// Server-side refusal fallback is supported on these models; Haiku has none.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

/** Checks a key before we store it. Listing models is free. */
export async function verifyApiKey(apiKey: string): Promise<void> {
  try {
    await client(apiKey).models.list({ limit: 1 });
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
  if (err instanceof Anthropic.APIConnectionError) return new AiError("Couldn't reach Anthropic. Check your internet connection.", 503);
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
export async function structured<S extends z.ZodType>(ctx: AiContext, req: StructuredRequest<S>): Promise<z.infer<S>> {
  if (!ctx.apiKey) throw new AiError("Add your Anthropic API key in Settings to use the AI features.", 400);
  const useFallbacks = FALLBACK_MODELS.has(ctx.model);
  try {
    // Streaming keeps long generations (many photos, several drafts) clear of request timeouts.
    const stream = client(ctx.apiKey).beta.messages.stream({
      model: ctx.model,
      max_tokens: req.maxTokens ?? 16000,
      // The author profile is the stable prefix across requests; cache it.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.content }],
      output_config: { effort: req.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const response = await stream.finalMessage();
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
