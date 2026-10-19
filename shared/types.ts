// Types shared by the server and the web client.

export type EmojiUse = "none" | "light" | "expressive";
export type HashtagUse = "none" | "few" | "several";

/** Everything the AI knows about you. Every field is optional; more context means better posts. */
export interface Profile {
  headline?: string;
  about?: string;
  industry?: string;
  audience?: string;
  goals?: string;
  topics?: string;
  /** Facts, wins, stories and opinions the AI may draw on. */
  experiences?: string;
  tone?: string;
  /** Words, claims or topics the AI must never use. */
  avoid?: string;
  callToAction?: string;
  emoji?: EmojiUse;
  hashtags?: HashtagUse;
  language?: string;
  /** Your own past posts, separated by a line containing only "---". */
  writingSamples?: string;
  /** A style guide distilled from the writing samples by "Analyze my voice". */
  voiceGuide?: string;
}

export type PostLength = "short" | "medium" | "long";

export const POST_GOALS = [
  "Share a lesson learned",
  "Tell a story",
  "Celebrate a win or milestone",
  "Announce something",
  "Give practical tips",
  "Share an opinion",
  "Behind the scenes",
  "Ask the audience a question",
] as const;

export interface GenerateOptions {
  mediaIds: number[];
  notes: string;
  goal?: string;
  length?: PostLength;
  variations?: number;
  tone?: string;
}

export interface PostDraft {
  angle: string;
  text: string;
  rationale: string;
}

export interface InspirationAnalysis {
  topic: string;
  hookStyle: string;
  structure: string[];
  tone: string;
  formatting: string;
  whyItWorks: string;
  approximateWords: number;
}

export interface RemixOptions {
  inspirationId: number;
  notes: string;
  mediaIds: number[];
  variations?: number;
  length?: PostLength;
}

export interface RemixDraft extends PostDraft {
  /** 0-1 share of the draft's word 5-grams that also appear in the source post. */
  overlap: number;
}

export const LINKEDIN_POST_LIMIT = 3000;
/** LinkedIn collapses posts behind "…see more" after roughly this many characters. */
export const LINKEDIN_FOLD = 210;

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best writing)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (balanced)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
] as const;
