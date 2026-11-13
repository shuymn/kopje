import { afterEach, describe, expect, it, vi } from "vitest";

import { announcementAdmin } from "./announcement-helpers";
import { sql } from "./api-helpers";
import { BUILD, migratedStore } from "./helpers";
import { ACCESS, setAccess } from "./ops-helpers";

// The Store's own time (StoreKernel, TimedOperation): the kernel fills an operation's clock field from the clock it
// admits the operation by, read at each call. A suite that fakes Date after the Store was built gets the faked time.

const AT = Date.UTC(2031, 0, 2, 3, 4, 5);

afterEach(() => {
  vi.useRealTimers();
});

describe("the Store's clock", () => {
  it("is the faked Date for a Store built before the fake, in each clock field", async () => {
    // Built, and its kernel constructed, under the real clock.
    const store = await migratedStore();
    await setAccess(store);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT);

    // `now`: the announcement's creation time.
    expect((await announcementAdmin(store).create()).created_at).toBe(new Date(AT).toISOString());

    // `storeNow`: the kept domain count's refresh time.
    await store.refreshDomainCount(BUILD);
    const [row] = await sql<{ value: string }>(store, "SELECT value FROM kopje_state WHERE name = 'domain_count'");
    expect(JSON.parse(row!.value)).toMatchObject({ at: AT });
  });

  it("replaces a time the caller sends in the clock field", async () => {
    const store = await migratedStore();
    await setAccess(store);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT);
    const input = { authority: ACCESS, text: "hello", startsAt: null, endsAt: null, allDay: false, scheduledAt: null };
    // An RPC caller is not held to the type: it may send the field anyway.
    const written = await store.createAnnouncement(BUILD, { ...input, now: 0 } as typeof input);
    expect(written).toMatchObject({ ok: true, announcement: { created_at: new Date(AT).toISOString() } });
  });
});
