import { describe, expect, it } from "vitest";
import { overlapScore } from "../shared/ai/originality.js";

const source = "I got rejected from 40 jobs last year. Here is what the 41st application taught me about writing a resume.";

describe("overlapScore", () => {
  it("is 1 for a copy and 0 for unrelated text", () => {
    expect(overlapScore(source, source)).toBe(1);
    expect(overlapScore("Our team shipped the new billing system on Friday after three months of work.", source)).toBe(0);
  });

  it("ignores case and punctuation", () => {
    expect(overlapScore(source.toUpperCase().replace(/\./g, "!"), source)).toBe(1);
  });

  it("is partial when some phrasing is reused", () => {
    const score = overlapScore("Last quarter was rough. Here is what the 41st application taught me about hiring.", source);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("handles very short drafts", () => {
    expect(overlapScore("Hi", source)).toBe(0);
  });
});
