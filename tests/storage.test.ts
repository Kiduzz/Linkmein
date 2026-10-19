import { beforeEach, describe, expect, it } from "vitest";
import { ownsKey, readJson, updateJson, writeJson } from "../server/storage.js";
import { freshStorage } from "./helpers.js";

const acct = "0123456789abcdef01234567";

beforeEach(freshStorage);

describe("storage", () => {
  it("only accepts upload keys inside the account's folder", () => {
    expect(ownsKey(acct, `u/${acct}/0b6f2c1e-1111-4222-8333-444455556666/0.jpg`)).toBe(true);
    expect(ownsKey(acct, `u/ffffffffffffffffffffffff/0b6f2c1e-1111-4222-8333-444455556666/0.jpg`)).toBe(false);
    expect(ownsKey(acct, `u/${acct}/../../accounts/x.json`)).toBe(false);
    expect(ownsKey(acct, `queue/index.json`)).toBe(false);
  });

  it("writes JSON with create-only and compare-and-swap semantics", async () => {
    const etag = await writeJson("t/a.json", { n: 1 }, { create: true });
    expect(etag).toBeTruthy();
    expect(await writeJson("t/a.json", { n: 2 }, { create: true })).toBeNull();
    expect(await writeJson("t/a.json", { n: 2 }, { ifMatch: "stale" })).toBeNull();
    expect(await writeJson("t/a.json", { n: 2 }, { ifMatch: etag! })).toBeTruthy();
    expect((await readJson<{ n: number }>("t/a.json"))?.value).toEqual({ n: 2 });
    expect(await readJson("t/missing.json")).toBeNull();
  });

  it("keeps every concurrent update", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateJson<{ seen: number[] }>("t/c.json", { seen: [] }, (c) => ({ seen: [...c.seen, i] }))));
    expect((await readJson<{ seen: number[] }>("t/c.json"))!.value.seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
