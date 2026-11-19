import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { type ConfiguredDomain, configuredDomain, onConfiguredDomain } from "../src/domain/instance-domain";
import { setSetting } from "./api-helpers";
import { migratedStore } from "./helpers";

// #1589's D3: where a collection is is decided by the domain /setup fixed, never a request's host. configuredDomain is
// the one maker of a ConfiguredDomain that has a name, so no caller puts a host of its own in one: a spread of a real
// one and a literal are no ConfiguredDomain to the type checker (the expected errors below, which
// `pnpm --filter kopje typecheck` holds); an object cast to one has no name to read, and one made by the constructor a
// real one reaches has none, so it is on no domain.
describe("a ConfiguredDomain (#1589's D3)", () => {
  it("is made from the stored domain alone: no spread, literal, cast or constructed one stands in for it", async () => {
    const store = await migratedStore();
    await setSetting(store, "domain", "kopje.test");
    await runInDurableObject(store, (_instance, state) => {
      const real = configuredDomain(new Db(state.storage.sql));
      const host = "evil.example";
      const evil = new URL(`https://${host}/collections/1`);
      // @ts-expect-error a spread copies no private field, so it is no ConfiguredDomain, whatever name it adds
      const spread: ConfiguredDomain = { ...real, name: host };
      // @ts-expect-error nor is a literal
      const literal: ConfiguredDomain = { name: host };
      const cast = { name: host } as unknown as ConfiguredDomain;
      const Constructor = (Object.getPrototypeOf(real) as { constructor: new () => ConfiguredDomain }).constructor;
      expect({
        real: [onConfiguredDomain(new URL("http://kopje.test/collections/1"), real), onConfiguredDomain(evil, real)],
        constructed: onConfiguredDomain(evil, new Constructor()),
      }).toEqual({ real: [true, false], constructed: false });
      for (const forged of [spread, literal, cast]) {
        expect(() => onConfiguredDomain(evil, forged)).toThrow(TypeError);
      }
    });
  });
});
