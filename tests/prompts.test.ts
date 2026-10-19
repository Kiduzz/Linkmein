import { describe, expect, it } from "vitest";
import { authorContext, splitSamples } from "../server/ai/prompts.js";

describe("prompts", () => {
  it("splits writing samples on --- lines", () => {
    expect(splitSamples("First post\n---\nSecond post\n  ---  \nThird")).toEqual(["First post", "Second post", "Third"]);
    expect(splitSamples("")).toEqual([]);
  });

  it("includes only filled profile fields, the voice guide and samples", () => {
    const ctx = authorContext("Ada", {
      headline: "Founder at Example",
      audience: "Early-stage founders",
      about: "  ",
      voiceGuide: "- Short sentences",
      writingSamples: "One\n---\nTwo",
      emoji: "none",
      hashtags: "none",
    });
    expect(ctx).toContain("Author: Ada");
    expect(ctx).toContain("Headline: Founder at Example");
    expect(ctx).toContain("Target audience: Early-stage founders");
    expect(ctx).not.toContain("About:");
    expect(ctx).toContain("<voice_guide>\n- Short sentences");
    expect(ctx).toContain('<sample index="2">\nTwo');
    expect(ctx).toContain("Do not use emoji.");
    expect(ctx).toContain("Do not add hashtags.");
  });
});
