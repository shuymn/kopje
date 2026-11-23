import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { avVerifier, verifyStill } from "../../src/platform/av-bytes";

// The output verifier on fresh output of the image the CI container job built (scripts/container-smoke.sh writes the
// outputs and their list at $AV_FRESH_LIST, then runs this suite alone: vitest.av-fresh.config.ts, the files through
// its AV_FRESH binding). An ffmpeg bump or a change to args.go or mp4strip.go that writes something the verifier
// refuses fails the job. Each output is held to its input's duration where the list gives one.
const fresh = (env as unknown as { AV_FRESH: Fetcher }).AV_FRESH;

// As test-node/av-fixtures.ts serves the list.
type AvFreshEntry = { file: string; type: "video/mp4" | "audio/mpeg" | "image/png"; expectedDuration?: number };

describe("fresh output of the image", () => {
  it("is accepted by the verifier, every file of the list", async () => {
    const list = await (await fresh.fetch("http://fresh/list.json")).json<AvFreshEntry[]>();
    expect(list.length, "AV_FRESH_LIST").toBeGreaterThan(0);
    const failures: string[] = [];
    for (const entry of list) {
      const res = await fresh.fetch(`http://fresh/${encodeURIComponent(entry.file)}`);
      expect(res.status, entry.file).toBe(200);
      if (entry.type === "image/png") {
        const refused = verifyStill(new Uint8Array(await res.arrayBuffer()));
        if (refused !== null) {
          failures.push(`${entry.file}: ${refused}`);
        }
        continue;
      }
      const v = avVerifier(
        entry.type,
        Number(res.headers.get("content-length")),
        entry.expectedDuration === undefined ? {} : { expectedDuration: entry.expectedDuration },
      );
      await res.body?.pipeThrough(v.stream).pipeTo(new WritableStream()).catch(v.abort);
      const verdict = await v.verdict;
      console.log(entry.file, JSON.stringify(verdict.ok ? verdict.facts : verdict));
      if (!verdict.ok) {
        failures.push(`${entry.file}: ${verdict.rule}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
