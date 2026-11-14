import { describe, expect, expectTypeOf, it } from "vitest";

import type { AnnouncementRefusal } from "../src/domain/announcements";
import { kvGet } from "../src/domain/fedify-kv";
import type { StoreStub } from "../src/platform/store-client";
import { toStoreUnavailable } from "../src/platform/store-errors";
import { Store } from "../src/store";
import { defineRpc, STORE_RPC } from "../src/store-rpc";
import { BUILD, migratedStore, rejectionOf } from "./helpers";
import { ACCESS } from "./ops-helpers";

// The Store's RPC methods derived from STORE_RPC (store-rpc.ts): one method a registry entry, typed through the stub.

const run = () => Promise.resolve(null);

describe("the Store's RPC registry", () => {
  it("defines one method of the Store for each entry, named as the entry, as a class body defines it", () => {
    const names = Object.keys(STORE_RPC);
    expect(names.length).toBeGreaterThan(300);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(Store.prototype, name);
      expect(descriptor, name).toMatchObject({ enumerable: false, writable: true, configurable: true });
      expect((descriptor?.value as { name: string } | undefined)?.name, name).toBe(name);
    }
  });

  it("runs the entry's operation over RPC, on the Store it is called on, with the caller's build", async () => {
    const store = await migratedStore();
    // Without an input, with one, and with the Store's clock filled.
    expect(await store.instanceDomain(BUILD)).toBeNull();
    await store.kvSet(BUILD, { key: KEY, value: '"v"', expiresAt: null });
    expect(await store.kvGet(BUILD, { key: KEY, now: Date.now() })).toBe('"v"');
    expect(await store.createAnnouncement(BUILD, { authority: ACCESS, ...ANNOUNCEMENT })).toMatchObject({ ok: false });
    // The build reaches the kernel's gate.
    expect(toStoreUnavailable(await rejectionOf(store.instanceDomain("0.0.0-other")))?.reason).toBe("version-mismatch");
  });

  it("refuses an entry named as a method of the class or one it inherits", () => {
    class Base {
      inherited() {}
    }
    class Target extends Base {
      written() {}
    }
    for (const name of ["written", "inherited", "toString", "constructor"]) {
      expect(() => defineRpc(Target.prototype, { [name]: kvGet }, run), name).toThrow(
        `Store RPC ${name} is both a registry entry and a method`,
      );
    }
    // A name of its own is defined.
    defineRpc(Target.prototype, { derived: kvGet }, run);
    expect(Object.hasOwn(Target.prototype, "derived")).toBe(true);
  });

  it("types each method through the stub", () => {
    // Never called: the checks are the type checker's.
    const typed = async (store: StoreStub) => {
      expectTypeOf(await store.instanceDomain(BUILD)).toEqualTypeOf<string | null>();
      expectTypeOf(await store.kvGet(BUILD, { key: "k", now: 0 })).toEqualTypeOf<string | null>();
      const written = await store.createAnnouncement(BUILD, { authority: ACCESS, ...ANNOUNCEMENT });
      expectTypeOf(written.ok).toEqualTypeOf<boolean>();
      if (written.ok) {
        expectTypeOf(written.announcement.created_at).toEqualTypeOf<string>();
      } else {
        expectTypeOf(written.code).toEqualTypeOf<AnnouncementRefusal["code"]>();
      }
      // @ts-expect-error a wrong input: the key is a string
      await store.kvGet(BUILD, { key: 1, now: 0 });
      // @ts-expect-error a wrong input: the time is missing
      await store.kvGet(BUILD, { key: "k" });
      // @ts-expect-error an input to an operation that takes none
      await store.instanceDomain(BUILD, {});
      // @ts-expect-error the field the Store's clock fills
      await store.createAnnouncement(BUILD, { authority: ACCESS, ...ANNOUNCEMENT, now: 0 });
      // @ts-expect-error an unknown RPC name
      expectTypeOf<"noSuchOperation">().toExtend<keyof typeof store>();
    };
    expect(typed).toBeTypeOf("function");
  });
});

const KEY = JSON.stringify(["k"]);
const ANNOUNCEMENT = { text: "", startsAt: null, endsAt: null, allDay: false, scheduledAt: null };
