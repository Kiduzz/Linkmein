import { describe, expect, it } from "vitest";
import { buildPostBody, escapeLittleText, toLittleText } from "../server/linkedin.js";

describe("little text", () => {
  it("escapes reserved characters", () => {
    expect(escapeLittleText("a (b) [c] {d} <e> @f *g* _h_ ~i~ | \\")).toBe(
      "a \\(b\\) \\[c\\] \\{d\\} \\<e\\> \\@f \\*g\\* \\_h\\_ \\~i\\~ \\| \\\\",
    );
  });

  it("turns hashtags into hashtag templates", () => {
    expect(toLittleText("Shipped it! #buildinpublic #AI")).toBe("Shipped it! {hashtag|\\#|buildinpublic} {hashtag|\\#|AI}");
  });

  it("handles hashtags at the start and on their own line", () => {
    expect(toLittleText("#Leadership matters\n\n#careers")).toBe("{hashtag|\\#|Leadership} matters\n\n{hashtag|\\#|careers}");
  });

  it("supports non-English hashtags", () => {
    expect(toLittleText("Merci #équipe")).toBe("Merci {hashtag|\\#|équipe}");
  });

  it("leaves C#, #1 and URL fragments as literal text", () => {
    expect(toLittleText("I write C# and was #1 at https://x.com/a#b")).toBe(
      "I write C\\# and was \\#1 at https://x.com/a\\#b",
    );
  });

  it("escapes text around hashtags", () => {
    expect(toLittleText("(new) #launch (today)")).toBe("\\(new\\) {hashtag|\\#|launch} \\(today\\)");
  });
});

describe("buildPostBody", () => {
  const base = { author: "urn:li:person:abc", text: "Hello", visibility: "PUBLIC" as const };

  it("builds a text-only post", () => {
    const body = buildPostBody({ ...base, content: { kind: "none" } });
    expect(body).toMatchObject({ author: "urn:li:person:abc", commentary: "Hello", lifecycleState: "PUBLISHED", visibility: "PUBLIC" });
    expect(body.content).toBeUndefined();
  });

  it("uses media for one image and multiImage for several", () => {
    const one = buildPostBody({ ...base, content: { kind: "image", images: [{ urn: "urn:li:image:1", altText: "A desk" }] } });
    expect(one.content).toEqual({ media: { id: "urn:li:image:1", altText: "A desk" } });
    const many = buildPostBody({ ...base, content: { kind: "image", images: [{ urn: "urn:li:image:1" }, { urn: "urn:li:image:2" }] } });
    expect(many.content).toEqual({ multiImage: { images: [{ id: "urn:li:image:1", altText: "" }, { id: "urn:li:image:2", altText: "" }] } });
  });

  it("attaches a video", () => {
    const body = buildPostBody({ ...base, content: { kind: "video", urn: "urn:li:video:9" } });
    expect(body.content).toEqual({ media: { id: "urn:li:video:9" } });
  });
});
