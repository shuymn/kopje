import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { countingStore, harness, offline } from "./app-helpers";
import { completeSetup, migratedStore } from "./helpers";

// GET and HEAD /media_proxy/<id>/<style> (#1560, web/media.ts serveMediaProxy): the URLs a withheld attachment is
// presented with answer the plain 404 on any host, with no Store, R2 or network read; full maintenance answers 503, as
// for every media route.

const PATHS = ["/media_proxy/111111111111111111/original", "/media_proxy/111111111111111111/small", "/media_proxy/x/y"];

// A media bucket that fails the test on any read.
const untouchableBucket = (reads: string[]) =>
  new Proxy(env.MEDIA, {
    get: (_target, name) => {
      reads.push(String(name));
      throw new Error(`R2 read: ${String(name)}`);
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/media_proxy", () => {
  it("answers 404 to GET and HEAD of /media_proxy on any host without a Store, R2 or network read", async () => {
    const store = await migratedStore();
    await completeSetup(store);
    const counting = countingStore(store);
    const bucket: string[] = [];
    const fetched: string[] = [];
    const global = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return Promise.reject(new Error("no network"));
    });
    const federation = {
      ...offline,
      loader: {
        ...offline.loader,
        fetch: (input: RequestInfo | URL) => {
          fetched.push(String(input instanceof Request ? input.url : input));
          return Promise.reject(new Error("no network"));
        },
      },
    };
    const answers: [string, string, string, number, string | null, string][] = [];
    for (const host of ["kopje.test", "other.example"]) {
      const { request } = harness(
        counting.stub,
        { MEDIA: untouchableBucket(bucket) },
        undefined,
        federation,
        undefined,
        host,
      );
      for (const path of PATHS) {
        for (const [method, accept] of [
          ["GET", "*/*"],
          ["GET", "text/html"],
          ["HEAD", "*/*"],
        ] as const) {
          const response = await request(path, { method, headers: { accept } });
          answers.push([
            host,
            method,
            accept,
            response.status,
            response.headers.get("content-type"),
            method === "HEAD" ? "" : await response.text(),
          ]);
        }
      }
    }
    expect(answers).toHaveLength(18);
    for (const [, method, , status, type, body] of answers) {
      expect(status).toBe(404);
      expect(type).toBe("text/plain; charset=utf-8");
      expect(body).toBe(method === "HEAD" ? "" : "Not Found");
    }
    expect({ store: counting.calls, bucket, fetched, global: global.mock.calls.length }).toEqual({
      store: [],
      bucket: [],
      fetched: [],
      global: 0,
    });
    // The guarded branch ran: an ordinary API read on the same harness reads the Store.
    const { request } = harness(counting.stub);
    expect((await request("/api/v1/instance")).status).toBe(200);
    expect(counting.calls.length).toBeGreaterThan(0);
  });

  it("answers 404 in readonly maintenance and 503 under full maintenance", async () => {
    const store = await migratedStore();
    await completeSetup(store);
    const statuses = [];
    for (const mode of ["readonly", "full"]) {
      const { request } = harness(store, { MAINTENANCE: mode });
      statuses.push((await request(PATHS[0]!)).status, (await request(PATHS[1]!, { method: "HEAD" })).status);
    }
    expect(statuses).toEqual([404, 404, 503, 503]);
  });
});
