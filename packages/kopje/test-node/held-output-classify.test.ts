import { describe, expect, it } from "vitest";

import { classify, type Observation, PROBE_STEP_BYTES } from "../bench/held-output/classify.mjs";
import {
  CLIENT_BACKLOG_BYTES,
  framesToHand,
  OFFERED_BYTES_PER_SECOND,
  PACED_FRAME_BYTES,
  THROTTLED_RATES,
  TOTAL_BACKLOG_BYTES,
} from "../bench/held-output/run.mjs";
import { HEAP_PEAKS } from "../test/presented-maxima.js";

// The held-output bench's outcome rules (bench/held-output/classify.mjs, #1610) over recorded observations, and the
// driver's schedule for its paced clients (run.mjs framesToHand).

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
// The Store isolate's memory (docs/threat-model.md, RES-3: "the Store isolate's 128 MB").
const ISOLATE_BYTES = 128_000_000;
const MINUTE = 60_000;

const run = (id: string, measurement: string, extra: Partial<Observation> = {}) =>
  ({ type: "run", run: id, measurement, at: 0, ...extra }) as Observation;

// Frames handed in order: each hand's frames take the next sequence numbers.
function hands(id: string, client: string, times: number[], frames: number, frameBytes: number): Observation[] {
  return times.map((at, i) => ({
    type: "hand",
    run: id,
    client,
    at,
    firstSeq: i * frames,
    frames,
    bytes: frames * frameBytes,
  }));
}

// A summary of frames `first` to `last` received at `at`, each handed at `handedAt(seq)`.
function recv(
  id: string,
  client: string,
  at: number,
  first: number,
  last: number,
  frameBytes: number,
  handedAt: (seq: number) => number,
): Observation {
  const ages = Array.from({ length: last - first + 1 }, (_, i) => at - handedAt(first + i));
  return {
    type: "recv",
    run: id,
    client,
    at,
    frames: last - first + 1,
    bytes: (last - first + 1) * frameBytes,
    lastSeq: last,
    minAge: Math.min(...ages),
    maxAge: Math.max(...ages),
  };
}

const outcome = (observations: Observation[], id: string) => {
  const found = classify(observations).runs.find((r) => r.run === id);
  if (found === undefined) {
    throw new Error(`no outcome for ${id}`);
  }
  return found;
};

describe("held-output outcomes", () => {
  it("reads the window counterexample as an unfinished tail, inconclusive, with its age as a lower bound", () => {
    // Two sockets each handed sixteen 512 KiB frames every period (2W) and reading 1 MiB a period, for ten periods.
    const period = 20 * MINUTE;
    const frame = 512 * KIB;
    const handedAt = (seq: number) => Math.floor(seq / 16) * period;
    const observations: Observation[] = [run("m4", "m4")];
    for (const client of ["m4.a", "m4.b"]) {
      observations.push(
        ...hands(
          "m4",
          client,
          Array.from({ length: 10 }, (_, k) => k * period),
          16,
          frame,
        ),
      );
      for (let k = 0; k < 10; k += 1) {
        observations.push(recv("m4", client, k * period + period / 2, 2 * k, 2 * k + 1, frame, handedAt));
      }
    }
    observations.push({ type: "done", run: "m4", at: 10 * period });

    // What a window credit of W with a per-frame charge of 1 KiB would charge at most: one hand per socket per window.
    const window = period / 2;
    const charges = observations.flatMap((o) =>
      o.type === "hand" ? [{ at: o.at, charge: o.bytes + o.frames * KIB }] : [],
    );
    const windowCharge = Math.max(
      ...charges.map(({ at }) =>
        charges.filter((c) => c.at >= at && c.at < at + window).reduce((s, c) => s + c.charge, 0),
      ),
    );
    expect(windowCharge).toBe(16_809_984);

    const result = outcome(observations, "m4");
    expect(result.outstandingBytes).toBe(146_800_640);
    expect(result.class).toBe("inconclusive");
    expect(result.reasons).toEqual(["an unfinished tail"]);
    for (const client of result.clients) {
      expect(client.unfinishedTail).toBe(true);
      expect(client.trend).toBe("rising");
      // The oldest outstanding frame (seq 20, handed in the second period) has waited nine periods by the end, more
      // than the 8.5 periods of the oldest frame received.
      expect(client.largestAge).toEqual({ ms: 9 * period, bound: "lowerBound" });
    }
  });

  it("reads a throttled run cut by its own deployment's reset as inconclusive, with no client drop", () => {
    const frame = 16 * KIB;
    const reset = 30 * MINUTE;
    const handedAt = (seq: number) => seq * 1_000;
    const observations = (withReset: boolean): Observation[] => [
      run("m3", "m3"),
      ...hands(
        "m3",
        "m3.t16k",
        Array.from({ length: 1_800 }, (_, s) => s * 1_000),
        1,
        frame,
      ),
      ...Array.from({ length: 179 }, (_, k) =>
        recv("m3", "m3.t16k", (k + 1) * 10_000, k * 10, k * 10 + 9, frame, handedAt),
      ),
      ...(withReset
        ? [
            {
              type: "start",
              run: "m3",
              at: reset + 3_000,
              id: "second",
              kind: "fresh",
              since: reset - 2_000,
              listedBefore: 4,
              heldMibBefore: 0,
              probe: false,
            } as const,
          ]
        : []),
      { type: "end", run: "m3", client: "m3.t16k", at: reset, side: "client", code: 1006 },
      { type: "done", run: "m3", at: reset + 60_000 },
    ];

    const cut = outcome(observations(true), "m3");
    expect(cut.class).toBe("inconclusive");
    expect(cut.reasons).toEqual(["a reset other than the headroom probe's own"]);
    expect(cut.resets).toEqual([{ at: reset + 3_000, since: reset - 2_000 }]);
    expect(cut.clients[0]?.ends.map((e) => e.cause)).toEqual(["reset"]);

    // Without the reset, the same end is the platform's: the rule above is what kept it from reading as a drop.
    const dropped = outcome(observations(false), "m3");
    expect(dropped.class).toBe("observed");
    expect(dropped.clients[0]?.ends.map((e) => e.cause)).toEqual(["platform"]);
  });

  it("reads an unfinished tail without a reset as inconclusive, its largest age a lower bound, cleanup aside", () => {
    const frame = 16 * KIB;
    const handedAt = (seq: number) => seq * 1_000;
    const observations: Observation[] = [
      run("m3", "m3"),
      ...hands("m3", "m3.t1k", [0, 1_000, 2_000, 3_000], 1, frame),
      recv("m3", "m3.t1k", 20_000, 0, 1, frame, handedAt),
      ...hands("m3", "m3.c", [0, 1_000], 1, 64),
      recv("m3", "m3.c", 1_050, 0, 1, 64, handedAt),
      { type: "done", run: "m3", at: 60_000 },
      // The driver's cleanup closes it after the run, even within the same millisecond: that end is not the run's.
      { type: "closed", run: "m3", client: "m3.t1k", at: 60_000, by: "client" },
      { type: "end", run: "m3", client: "m3.t1k", at: 60_000, side: "client", code: 1006 },
    ];
    const result = outcome(observations, "m3");
    expect(result.class).toBe("inconclusive");
    expect(result.reasons).toEqual(["an unfinished tail"]);
    const [slow, control] = result.clients;
    // Frame 2, handed at 2 s, is still outstanding at 60 s.
    expect(slow?.largestAge).toEqual({ ms: 58_000, bound: "lowerBound" });
    expect(slow?.outstandingBytes).toBe(2 * frame);
    expect(control?.unfinishedTail).toBe(false);
    expect(control?.largestAge).toEqual({ ms: 1_050, bound: "observed" });
  });

  it("keeps M3's three clients within their backlog limits", () => {
    const offered = OFFERED_BYTES_PER_SECOND / PACED_FRAME_BYTES;
    // One second at a time for four hours: the driver hands, then each client reads at its rate.
    const simulate = (rates: number[], gated: boolean) => {
      const clients = rates.map((rate) => ({ rate, handed: 0, received: 0 }));
      let largest = 0;
      let largestTotal = 0;
      let held = false;
      const totals: number[] = [];
      for (let second = 0; second < 4 * 3_600; second += 1) {
        const counts = gated ? framesToHand(clients, PACED_FRAME_BYTES, offered) : clients.map(() => offered);
        clients.forEach((c, i) => {
          c.handed += (counts[i] ?? 0) * PACED_FRAME_BYTES;
          held ||= (counts[i] ?? 0) < offered;
        });
        const backlogs = clients.map((c) => c.handed - c.received);
        largest = Math.max(largest, ...backlogs);
        largestTotal = Math.max(
          largestTotal,
          backlogs.reduce((s, b) => s + b, 0),
        );
        for (const c of clients) {
          c.received += Math.min(c.rate, c.handed - c.received);
        }
        totals.push(clients.reduce((s, c) => s + c.handed - c.received, 0));
      }
      return { largest, largestTotal, held, totals };
    };

    expect(THROTTLED_RATES).toEqual([KIB, 16 * KIB, 256 * KIB]);
    const gated = simulate(THROTTLED_RATES, true);
    expect(gated.held).toBe(true);
    expect(gated.largest).toBeLessThanOrEqual(CLIENT_BACKLOG_BYTES);
    expect(gated.largestTotal).toBeLessThanOrEqual(TOTAL_BACKLOG_BYTES);

    // Ungated, the three backlogs grow 1,293,312 bytes a second together and pass 128 MB in the 99th second.
    const ungated = simulate(THROTTLED_RATES, false);
    expect(ungated.totals[0]).toBe(1_293_312);
    expect(ungated.totals.findIndex((total) => total > ISOLATE_BYTES) + 1).toBe(99);

    // Five clients at 1 KiB/s would reach 20 MiB at 4 MiB each: the aggregate limit holds them to 16 MiB.
    const many = simulate([KIB, KIB, KIB, KIB, KIB], true);
    expect(many.largest).toBeLessThanOrEqual(CLIENT_BACKLOG_BYTES);
    expect(many.largestTotal).toBeGreaterThan(TOTAL_BACKLOG_BYTES - PACED_FRAME_BYTES);
    expect(many.largestTotal).toBeLessThanOrEqual(TOTAL_BACKLOG_BYTES);
  });
  it("takes what was handed from the object's totals, and otherwise counts hands whose answer was lost", () => {
    const frame = 16 * KIB;
    const handedAt = (seq: number) => seq * 1_000;
    const observations = (totals: boolean): Observation[] => [
      run("m3", "m3"),
      ...hands("m3", "m3.t", [0, 1_000], 1, frame),
      // An answer lost: the driver cannot tell whether these two frames left.
      { type: "hand-unknown", run: "m3", client: "m3.t", at: 2_000, frames: 2, bytes: 2 * frame },
      recv("m3", "m3.t", 30_000, 0, 1, frame, handedAt),
      ...(totals
        ? [{ type: "totals", run: "m3", client: "m3.t", at: 59_000, frames: 2, bytes: 2 * frame, seq: 2 } as const]
        : []),
      { type: "done", run: "m3", at: 60_000 },
    ];
    // The object's totals say they did not: everything handed was received.
    const known = outcome(observations(true), "m3");
    expect(known.clients[0]).toMatchObject({ handed: { frames: 2, bytes: 2 * frame }, unfinishedTail: false });
    expect(known.class).toBe("observed");
    // Without them, the lost hand counts as handed, and the run is an unfinished tail.
    const unknown = outcome(observations(false), "m3");
    expect(unknown.clients[0]).toMatchObject({ handed: { frames: 4, bytes: 4 * frame }, unfinishedTail: true });
    expect(unknown.class).toBe("inconclusive");
  });
});

describe("M1, held output against the headroom", () => {
  const baselineBytes = 100 * MIB;
  // A run of `attempts` headroom probes, each ending in the probe's own reset, with stopped clients listed if held.
  type Held = { bytes: number; unknown: number; ended: number; endedDuringProbe: number };
  // What the stopped clients held when each probe began: the whole volume, unless an attempt says otherwise.
  const full = (volume: number): Held => ({ bytes: volume, unknown: 0, ended: 0, endedDuringProbe: 0 });
  function m1Run(
    id: string,
    volume: number,
    headroom: number[],
    extra: Observation[] = [],
    held: (attempt: number) => Held = () => full(volume),
  ): Observation[] {
    return [
      run(id, "m1", {
        volume,
        frameBytes: volume === 0 ? undefined : 512 * KIB,
        baseline: "m1-none",
      } as Partial<Observation>),
      ...headroom.flatMap((bytes, i): Observation[] => [
        {
          type: "start",
          run: id,
          at: (i + 1) * 1_000,
          id: `${id}-${i}`,
          kind: "fresh",
          since: (i + 1) * 1_000 - 500,
          listedBefore: volume === 0 ? 0 : 5,
          heldMibBefore: bytes / MIB,
          probe: true,
        },
        {
          type: "headroom",
          run: id,
          at: (i + 1) * 1_000 + 100,
          attempt: i + 1,
          bytes,
          capped: false,
          ...(volume === 0 ? {} : { held: held(i + 1) }),
        },
      ]),
      ...extra,
      { type: "done", run: id, at: 100_000 },
    ];
  }
  const baseline = m1Run("m1-none", 0, [baselineBytes, baselineBytes, baselineBytes]);

  it("counts a held 1 GiB that lowers the headroom by 6% of itself", () => {
    const lowered = Math.trunc(0.06 * GIB);
    expect(lowered).toBe(64_424_509);
    const held = m1Run(
      "m1-1g",
      GIB,
      [0, 1, 2].map(() => baselineBytes - lowered),
    );
    const result = classify([...baseline, ...held]).m1;
    expect(result?.class).toBe("counted");
    expect(result?.volumes).toEqual([
      {
        run: "m1-1g",
        volume: GIB,
        frameBytes: 512 * KIB,
        class: "counted",
        difference: lowered,
        step: PROBE_STEP_BYTES,
        spread: 0,
        fraction: lowered / GIB,
        excludesAbove: null,
      },
    ]);
    // With P, the groups answer with its backstop fired, it would pass the isolate's memory.
    expect(HEAP_PEAKS.groups.backstop + lowered).toBeGreaterThan(ISOLATE_BYTES);
  });

  it("reports no detection with what it excludes, and resolves mixed results to the more conservative", () => {
    // 64 MiB within the step and the spread: not detected, excluding accounting of more than (1 + 1) MiB / 64 MiB.
    const quiet = m1Run("m1-64m", 64 * MIB, [baselineBytes - MIB, baselineBytes, baselineBytes - 2 * MIB]);
    // 256 MiB cut by a reset that is not the probe's: inconclusive.
    const cut = m1Run(
      "m1-256m",
      256 * MIB,
      [baselineBytes, baselineBytes, baselineBytes],
      [
        {
          type: "start",
          run: "m1-256m",
          at: 50_000,
          id: "other",
          kind: "fresh",
          since: 49_000,
          listedBefore: 5,
          heldMibBefore: 0,
          probe: false,
        },
      ],
    );
    const counted = m1Run(
      "m1-1g",
      GIB,
      [0, 1, 2].map(() => baselineBytes - 64 * MIB),
    );

    const alone = classify([...baseline, ...quiet]).m1;
    expect(alone?.class).toBe("not detected");
    expect(alone?.volumes[0]?.spread).toBe(2 * MIB);
    expect(alone?.volumes[0]?.excludesAbove).toBe((PROBE_STEP_BYTES + 2 * MIB) / (64 * MIB));

    expect(classify([...baseline, ...quiet, ...cut]).m1?.class).toBe("inconclusive");
    const mixed = classify([...baseline, ...quiet, ...cut, ...counted]).m1;
    expect(mixed?.volumes.map((v) => v.class)).toEqual(["not detected", "inconclusive", "counted"]);
    expect(mixed?.class).toBe("counted");
  });
  it("counts no attempt whose stopped clients did not hold the volume through its probe", () => {
    const volume = 64 * MIB;
    const lowered = [0, 1, 2].map(() => baselineBytes - 32 * MIB);
    // The same headroom with each attempt's holding intact is counted: the cases below differ only in what was held.
    expect(classify([...baseline, ...m1Run("m1-64m", volume, lowered)]).m1?.class).toBe("counted");
    const shortfalls: [string, Partial<Held>][] = [
      ["a short fill", { bytes: volume - 1 }],
      ["a hand whose answer was lost", { unknown: 512 * KIB }],
      ["a client that ended before the probe", { ended: 1 }],
      ["a client that ended while the probe ran", { endedDuringProbe: 1 }],
    ];
    for (const [why, shortfall] of shortfalls) {
      const held = m1Run("m1-64m", volume, lowered, [], (attempt) => ({
        ...full(volume),
        ...(attempt === 2 ? shortfall : {}),
      }));
      expect([why, classify([...baseline, ...held]).m1?.class]).toEqual([why, "inconclusive"]);
    }
  });
});

describe("M5 and M6", () => {
  it("report aggregate scenario deltas, each named with its scenario, and nothing per frame or connection", () => {
    const observations: Observation[] = [
      run("m6-4", "m6"),
      { type: "rss", run: "m6-4", at: 1, attempt: 1, stage: "baseline", bytes: 50 * MIB },
      { type: "rss", run: "m6-4", at: 2, attempt: 1, stage: "held", bytes: 90 * MIB },
      { type: "rss", run: "m6-4", at: 3, attempt: 1, stage: "closed", bytes: 60 * MIB },
      run("m5-64", "m5"),
      { type: "headroom", run: "m5-64", at: 1, attempt: 1, stage: "baseline", bytes: 100 * MIB },
      { type: "headroom", run: "m5-64", at: 2, attempt: 1, stage: "drained", bytes: 97 * MIB },
      { type: "done", run: "m5-64", at: 3 },
      { type: "done", run: "m6-4", at: 4 },
    ];
    const report = classify(observations);
    expect(report.runs.map((r) => [r.run, r.scenarioDeltas])).toEqual([
      [
        "m6-4",
        [
          { scenario: "m6-4 resident memory", stage: "held", attempt: 1, delta: 40 * MIB },
          { scenario: "m6-4 resident memory", stage: "closed", attempt: 1, delta: 10 * MIB },
        ],
      ],
      ["m5-64", [{ scenario: "m5-64 headroom", stage: "drained", attempt: null, delta: -3 * MIB }]],
    ]);
  });
});
