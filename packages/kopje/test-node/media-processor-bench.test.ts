import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { endToEnd, type Outcome } from "../bench/media-processor/outcome.mjs";
import { billing, matrix, parseLines, timings } from "../bench/media-processor/report.mjs";

// The media processor bench (bench/media-processor/, #1828 P27): a run succeeds only end to end against the fixture's
// expected kind, its output accepted by the output verifier and its stills by design 4.10's checks (PR2 A4), every
// run the driver made is in the denominator, and billed usage is priced per fixture by run id. The boundary matrix
// (PR2 A3) expects of each fixture the verdict the planner's coefficients give, and reports estimate against encode.
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
    verdict: "ok",
    stillCheck: "ok",
  };
  const audio: Outcome = {
    ...video,
    expect: "audio",
    mediaKind: "audio",
    contentType: "audio/mpeg",
    stillBytes: null,
    imagesWebpMs: null,
    stillCheck: null,
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

  it("is a failure for an output the verifier refused or a still that failed its checks", () => {
    expect(endToEnd({ ...video, verdict: "duration_limit" })).toBe(false);
    expect(endToEnd({ ...video, verdict: null })).toBe(false);
    expect(endToEnd({ ...audio, verdict: "xing" })).toBe(false);
    expect(endToEnd({ ...video, stillCheck: "malformed" })).toBe(false);
    expect(endToEnd({ ...video, stillCheck: null })).toBe(false);
    // A still's own output is checked as a still, not by the AV verifier.
    const still = { ...video, op: "still" as const, mediaKind: null, contentType: "image/png", verdict: null };
    expect(endToEnd(still)).toBe(true);
    expect(endToEnd({ ...still, stillCheck: "long_edge" })).toBe(false);
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

describe("the boundary matrix", () => {
  const at = (fields: Record<string, unknown>, endpoint = "v1-90", expectVerdict = "admitted") =>
    run({ instance: "standard-4", threads: "all:4", matrix: { endpoint, encodeMs: 50_800, expectVerdict }, ...fields });

  it("reports each admitted run's estimate against its encode time, and the expected refusals apart", () => {
    const records = parseLines(
      [
        at({ fixture: "h264-50.mp4", ok: true, server: { estimate: 34_600, encode: 30_000 } }),
        at({ fixture: "h264-50.mp4", ok: true, server: { estimate: 34_600, encode: 36_330 } }),
        at({ fixture: "h264-53.mp4", ok: false, status: 422, error: "envelope", server: {} }, "v1-90", "refused"),
        // Wrong verdicts and a failure are listed; an unexpectedly admitted run with valid timings is in the ratio too.
        at({ fixture: "hevc-36.mp4", ok: true, server: { estimate: 36_000, encode: 1_000 } }, "v1-90", "refused"),
        at({ fixture: "hevc-34.mp4", ok: false, status: 422, error: "envelope", server: {} }),
        at({ fixture: "hlg-9.mp4", ok: false, status: 500, error: "encode_failed", server: { estimate: 30_000 } }),
        run({ fixture: "other.mp4", ok: true }),
      ].join("\n"),
    );
    const lines = matrix(records);
    expect(lines).toContain("| h264-50.mp4 | v1-90 | 50.8 | admitted | 34.6 | 30.0 | 0.867 |");
    expect(lines).toContain("| h264-50.mp4 | v1-90 | 50.8 | admitted | 34.6 | 36.3 | 1.050 |");
    expect(lines).toContain("Largest encode / estimate: 1.050 over 3 runs.");
    expect(lines).toContain("- h264-53.mp4 at v1-90 (50.8 s): refused at the probe, as expected");
    expect(lines).toContain("- hevc-36.mp4 at v1-90 (50.8 s): admitted, expected refused (estimate 36.0 s)");
    expect(lines).toContain("- hevc-34.mp4 at v1-90 (50.8 s): refused at the probe, expected admitted");
    expect(lines).toContain("- hlg-9.mp4 at v1-90 (50.8 s): failed, status 500 encode_failed");
    expect(lines.join("\n")).not.toContain("other.mp4");
    // The matrix's runs stay out of the timing tables.
    expect(timings(records).join("\n")).not.toContain("h264-50.mp4");
  });

  it("expects of each fixture the verdict plan.go's coefficients (A1, A8) and ladder give at each endpoint", () => {
    type Fixture = { name: string; codec: string; size: string; seconds: number; transfer: string; rate: string };
    type Matrix = {
      stages: Record<"dispatch" | "start" | "probe" | "still" | "commit" | "input", number>;
      endpoints: Record<string, { seconds: number; ingress: number; reply: number }>;
      fixtures: (Fixture & { expect: Record<string, string> })[];
    };
    const m = JSON.parse(
      readFileSync(new URL("../bench/media-processor/matrix.json", import.meta.url), "utf8"),
    ) as Matrix;
    const plan = readFileSync(new URL("../container/server/plan.go", import.meta.url), "utf8");
    const constant = (name: string) => Number(new RegExp(`\\b${name}\\s*=\\s*([0-9.]+)`).exec(plan)?.[1]);
    const decode = (codec: string) => Number(new RegExp(`"${codec}": ([0-9.]+)`).exec(plan)?.[1]);
    const [tonemap, encode, audio, fixed, safety] = [
      "tonemapNsPerPixel",
      "encodeNsPerPixel",
      "audioMsPerSecond",
      "fixedEstimateMs",
      "estimateSafety",
    ].map(constant) as [number, number, number, number, number];
    expect([decode("h264"), decode("hevc"), tonemap, encode, audio, fixed, safety]).toEqual([
      1, 1.5, 11, 21, 40, 1500, 0.7,
    ]);
    // The ladder (A2) and planNormalize's estimate on a rung, for a 30 fps source with audio: the output's even
    // dimensions, each at least 2.
    const ladder = [
      [120, 1920, 1080, 60],
      [300, 1280, 720, 30],
      [600, 854, 480, 30],
    ] as const;
    const estimate = (f: Fixture, [, long, short, fps]: (typeof ladder)[number]) => {
      const [w, h] = f.size.split("x").map(Number) as [number, number];
      const fit = Math.min(1, long / Math.max(w, h), short / Math.min(w, h));
      const out = Math.max(2, Math.trunc((w * fit) / 2) * 2) * Math.max(2, Math.trunc((h * fit) / 2) * 2);
      const perPixel = decode(f.codec) + (f.transfer === "sdr" ? 0 : tonemap);
      return (
        fixed +
        (w * h * 30 * f.seconds * perPixel) / 1e6 +
        (out * Math.min(30, fps) * f.seconds * encode) / 1e6 +
        f.seconds * audio
      );
    };
    // Admitted when the estimate fits on the duration's rung or a lower one (planVideo).
    const admitted = (f: Fixture, encodeMs: number) => {
      const first = ladder.findIndex(([upTo]) => f.seconds <= upTo);
      return ladder.slice(first < 0 ? ladder.length - 1 : first).some((r) => estimate(f, r) <= safety * encodeMs);
    };
    const s = m.stages;
    const stageTimes = s.dispatch + s.start + s.probe + s.still + s.commit;
    for (const f of m.fixtures) {
      for (const [endpoint, verdict] of Object.entries(f.expect)) {
        const e = m.endpoints[endpoint];
        expect(e, endpoint).toBeDefined();
        const encodeMs = ((e?.seconds ?? 0) - (e?.ingress ?? 0) - s.input - stageTimes - (e?.reply ?? 0)) * 1000;
        expect(admitted(f, encodeMs) ? "admitted" : "refused", `${f.name} at ${endpoint}`).toBe(verdict);
      }
      // Within AV_UPLOAD_LIMIT at the fixture's video bitrate and fixtures.sh's audio (160 kb/s H.264, 128 kb/s HEVC).
      const rate = Number(f.rate.replace("M", "e6")) + (f.codec === "h264" ? 160e3 : 128e3);
      expect((rate * f.seconds) / 8, f.name).toBeLessThan(94_371_840 * 0.95);
    }
    // Each edge is straddled: a fixture just below it admitted and one just above it refused, per class and endpoint.
    const verdicts = new Map<string, Set<string>>();
    for (const f of m.fixtures) {
      for (const [endpoint, verdict] of Object.entries(f.expect)) {
        const key = `${f.codec} ${f.size} ${f.transfer === "sdr" ? "sdr" : "hdr"} ${endpoint}`;
        verdicts.set(key, (verdicts.get(key) ?? new Set()).add(verdict));
      }
    }
    for (const key of ["hevc 3840x2160 sdr v1-90", "hevc 3840x2160 sdr v1-300", "hevc 3840x2160 hdr v2"]) {
      expect([...(verdicts.get(key) ?? [])].toSorted(), key).toEqual(["admitted", "refused"]);
    }
  });
});
