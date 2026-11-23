import { describe, expect, it } from "vitest";

import { billing, parseLines, timings } from "../bench/media-processor/report.mjs";

// The media processor bench's report (bench/media-processor/report.mjs, #1828 P27): only end-to-end successes count,
// and billed usage is priced per fixture by run id.
const run = (fields: Record<string, unknown>) =>
  JSON.stringify({
    kind: "run",
    op: "normalize",
    instance: "standard-3",
    threads: "default",
    status: 200,
    wallMs: 10_000,
    operationMs: 8_000,
    outputToR2Ms: 500,
    server: { encode: 6_000, "encode-cpu": 12_000 },
    ...fields,
  });

describe("the media processor bench report", () => {
  it("counts a run whose container answered 200 but whose output failed to reach R2 as a failure", () => {
    const records = parseLines(
      [
        run({ fixture: "a.mp4", run: "r1", ok: false, error: "R2 put failed", wallMs: 1_000 }),
        run({ fixture: "b.mp4", run: "r2", ok: true }),
        run({ fixture: "b.mp4", run: "r3", ok: true, wallMs: 20_000 }),
      ].join("\n"),
    );
    const lines = timings(records);
    expect(lines).toContain("| a.mp4 | standard-3 | default | 0/1 | - | - | - | - | - |");
    expect(lines).toContain("| b.mp4 | standard-3 | default | 2/2 | 20.0 | 6.0 | 12.0 | 2.00 | 8.0 |");
    // The failed run's times enter no stage either: two samples, from b.mp4's runs.
    expect(lines).toContain("| output into R2 | 2 | 0.50 |");
    // A run with no `ok` (a request that failed before the bench answered) is not a success.
    expect(timings(parseLines(run({ fixture: "c.mp4", run: "r4" })))).toContain(
      "| c.mp4 | standard-3 | default | 0/1 | - | - | - | - | - |",
    );
  });

  it("prices each fixture on its own runs, joined by run id", () => {
    const records = parseLines(
      [
        run({ fixture: "short.mp4", run: "r1", ok: true }),
        run({ fixture: "long.mp4", run: "r2", ok: true }),
        run({ fixture: "long.mp4", run: "r3", ok: false }),
      ].join("\n"),
    );
    const gib = 1073741824;
    const lines = billing(records, [
      { run: "r1", cpuTimeSec: 10, allocatedMemory: 200 * gib, allocatedDisk: 0 },
      { run: "r2", cpuTimeSec: 600, allocatedMemory: 1000 * gib, allocatedDisk: 0 },
      { run: "r3", cpuTimeSec: 400, allocatedMemory: 1000 * gib, allocatedDisk: 0 },
      { run: "stray", cpuTimeSec: 5, allocatedMemory: 0, allocatedDisk: 0 },
    ]);
    // 10 × 0.00002 + 200 × 0.0000025 = 0.0007; 1000 × 0.00002 + 2000 × 0.0000025 = 0.025.
    expect(lines).toContain(
      "| short.mp4 | normalize | standard-3 | default | 1 | 1 | 10.0 | 200 | 0 | 0.0007 | 0.0007 |",
    );
    expect(lines).toContain(
      "| long.mp4 | normalize | standard-3 | default | 2 | 1 | 1000.0 | 2000 | 0 | 0.0250 | 0.0125 |",
    );
    expect(lines).toContain("| (runs not in the results) | | | | 1 | | 5.0 | 0 | 0 | 0.0001 | 0.0001 |");
  });
});
