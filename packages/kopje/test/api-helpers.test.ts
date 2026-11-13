import { describe, expect, it } from "vitest";

import { accessTeam, kept } from "./api-helpers";

// The kid of a JWK.
const kidOf = (key: JsonWebKey) => (key as { kid?: string }).kid;

describe("accessTeam", () => {
  it("gives each team its own kid over the shared pairs, another key under it, and a fresh key on rotation", async () => {
    const [a, b] = [await accessTeam(), await accessTeam()];
    expect(a.kid).not.toBe(b.kid);
    const signing = async (team: typeof a) => {
      const [header] = (await team.assertion()).split(".");
      return JSON.parse(atob(header!.replace(/-/g, "+").replace(/_/g, "/"))) as { kid: string };
    };
    expect([(await signing(a)).kid, (await signing(b)).kid]).toEqual([a.kid, b.kid]);
    expect(kidOf(a.otherKey)).toBe(a.kid);
    const published = async (team: typeof a) =>
      (await (await team.fetch(`https://${team.teamDomain}/cdn-cgi/access/certs`)).json<{ keys: JsonWebKey[] }>()).keys;
    const [key] = await published(a);
    expect(a.otherKey.n).not.toBe(key!.n);
    expect((await published(b))[0]!.n).toBe(key!.n);
    const next = await a.rotate();
    expect(kidOf(next)).not.toBe(a.kid);
    expect(next.n).not.toBe(key!.n);
    expect(next.n).not.toBe(a.otherKey.n);
    expect((await published(a)).map(kidOf)).toEqual([a.kid, kidOf(next)]);
  });
});

describe("kept", () => {
  it("makes once and shares the result", async () => {
    let made = 0;
    const get = kept(() => Promise.resolve(++made));
    expect([await get(), await get()]).toEqual([1, 1]);
  });

  it("drops a rejected promise, so the next call makes it again", async () => {
    let made = 0;
    const get = kept(() => (++made === 1 ? Promise.reject(new Error("first")) : Promise.resolve(made)));
    await expect(get()).rejects.toThrow("first");
    expect([await get(), await get(), made]).toEqual([2, 2, 2]);
  });
});
