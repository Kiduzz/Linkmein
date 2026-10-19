import { describe, expect, it } from "vitest";
import { decrypt, encrypt, maskSecret } from "../server/crypto.js";

describe("crypto", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("sk-ant-secret");
    const b = encrypt("sk-ant-secret");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("sk-ant-secret");
  });

  it("rejects tampered ciphertext", () => {
    const parts = encrypt("hello").split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });

  it("masks secrets", () => {
    expect(maskSecret("sk-ant-api03-abcdefghijklmnop")).toBe("sk-ant-…mnop");
    expect(maskSecret("short")).toBe("••••");
  });
});
