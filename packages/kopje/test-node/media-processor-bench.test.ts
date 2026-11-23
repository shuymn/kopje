import { describe, expect, it } from "vitest";

import { endToEnd, type Outcome } from "../bench/media-processor/outcome.mjs";
import { billing, parseLines, timings } from "../bench/media-processor/report.mjs";

// The media processor bench (bench/media-processor/, #1828 P27): a run succeeds only end to end against the fixture's
// expected kind, every run the driver made is in the denominator, and billed usage is priced per fixture by run id.
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

describe("a bench run's outcome", () => {
  const video: Outcome = {
    op: "normalize",
    expect: "video",
    status: 200,
    error: null,
    mediaKind: "video",
    contentType: "video/mp4",
    outputToR2Ms: 500,
    stillBytes: 300,
    imagesWebpMs: 20,
    imagesRgbaMs: 10,
  };
  const audio: Outcome = {
    ...video,
    expect: "audio",
    mediaKind: "audio",
    contentType: "audio/mpeg",
    stillBytes: null,
    imagesWebpMs: null,
  };

  it("is a success only when every step ran for the fixture's kind", () => {
    expect(endToEnd(video)).toBe(true);
    expect(endToEnd(audio)).toBe(true);
    expect(endToEnd({ ...video, op: "still", mediaKind: null, contentType: "image/png" })).toBe(true);
  });

  it("is a failure for an answer without the expected Kopje-Kind, or a video without its still and Images", () => {
    expect(endToEnd({ ...video, mediaKind: null })).toBe(false);
    expect(endToEnd({ ...video, mediaKind: "audio" })).toBe(false);
    expect(endToEnd({ ...audio, mediaKind: "video" })).toBe(false);
    expect(endToEnd({ ...video, stillBytes: null })).toBe(false);
    expect(endToEnd({ ...video, imagesWebpMs: null })).toBe(false);
    expect(endToEnd({ ...video, imagesRgbaMs: null })).toBe(false);
    expect(endToEnd({ ...video, outputToR2Ms: null })).toBe(false);
    expect(endToEnd({ ...video, error: "destroy: failed" })).toBe(false);
    expect(endToEnd({ ...video, status: 422 })).toBe(false);
    expect(endToEnd({ ...audio, op: "still" })).toBe(false);
    // The answer's media type is the expected kind's: a 200 whose body is not that media is no success.
    expect(endToEnd({ ...audio, contentType: "text/plain" })).toBe(false);
    expect(endToEnd({ ...video, contentType: null })).toBe(false);
    expect(endToEnd({ ...video, op: "still", mediaKind: null, contentType: "video/mp4" })).toBe(false);
  });
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
  });

  it("shows the failed stills in the denominator", () => {
    const still = (fields: Record<string, unknown>) =>
      run({ op: "still", fixture: "a.mp4", instance: "standard-1", imagesWebpMs: 30, imagesRgbaMs: 10, ...fields });
    const lines = timings(
      parseLines(
        [
          still({ run: "s1", ok: true }),
          ...Array.from({ length: 8 }, (_, i) => still({ run: `f${i}`, ok: false, error: "still: status 500" })),
        ].join("\n"),
      ),
    );
    expect(lines).toContain("| a.mp4 | 1/9 | 10.00 | 0.03 | 0.01 |");
  });

  // measure.sh records a request that failed before the bench answered with its operation, fixture, type and threading.
  it("counts a request that failed before the bench answered in its group, as a failure", () => {
    const failed = JSON.stringify({
      error: "request failed",
      kind: "run",
      op: "normalize",
      fixture: "b.mp4",
      expect: "video",
      instance: "standard-3",
      threads: "default",
    });
    const lines = timings(parseLines([run({ fixture: "b.mp4", run: "r1", ok: true }), failed].join("\n")));
    expect(lines).toContain("| b.mp4 | standard-3 | default | 1/2 | 10.0 | 6.0 | 12.0 | 2.00 | 8.0 |");
  });

  it("prices each fixture on its own runs, joined by run id, with its billed utilisation", () => {
    const records = parseLines(
      [
        run({ fixture: "short.mp4", run: "r1", ok: true }),
        run({ fixture: "long.mp4", run: "r2", ok: true, wallMs: 300_000 }),
        run({ fixture: "long.mp4", run: "r3", ok: false, wallMs: 200_000 }),
      ].join("\n"),
    );
    const gib = 1073741824;
    const lines = billing(records, [
      { run: "r1", cpuTimeSec: 30, allocatedMemory: 200 * gib, allocatedDisk: 0 },
      { run: "r2", cpuTimeSec: 600, allocatedMemory: 1000 * gib, allocatedDisk: 0 },
      { run: "r3", cpuTimeSec: 400, allocatedMemory: 1000 * gib, allocatedDisk: 0 },
      { run: "stray", cpuTimeSec: 5, allocatedMemory: 0, allocatedDisk: 0 },
    ]);
    // 30 vCPU-s over 10 s is 3.00; 1000 over 500 s is 2.00.
    // 30 × 0.00002 + 200 × 0.0000025 = 0.0011; 1000 × 0.00002 + 2000 × 0.0000025 = 0.025.
    expect(lines).toContain(
      "| short.mp4 | normalize | standard-3 | default | 1 | 1 | 30.0 | 3.00 | 200 | 0 | 0.0011 | 0.0011 |",
    );
    expect(lines).toContain(
      "| long.mp4 | normalize | standard-3 | default | 2 | 1 | 1000.0 | 2.00 | 2000 | 0 | 0.0250 | 0.0125 |",
    );
    expect(lines).toContain("| (runs not in the results) | | | | 1 | | 5.0 | - | 0 | 0 | 0.0001 | 0.0001 |");
  });
});
