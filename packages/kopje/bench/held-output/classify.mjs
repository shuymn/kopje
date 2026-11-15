// The held-output bench's outcome rules (#1610): what `run.mjs` observed, classified. Every figure it reports is an
// observation over the clients and the hours measured, never a bound for every reader:
// - A run with a reset other than the headroom probe's own, or with frames handed and neither received nor ended by
//   the run's end (an unfinished tail), is inconclusive for what it measures; an unfinished tail's largest age is a
//   lower bound. An end after a reset is the reset's, never a client drop; what follows the run's `done` record is
//   the driver's cleanup, not the run's.
// - M1 (does held output count against the Store's memory?) is "counted" at a held volume when the headroom falls by
//   more than the probe's step plus the spread of its attempts; "not detected" when it does not, which excludes
//   accounting of more than (step + spread) / volume of what is held and no less; "inconclusive" when either run is.
//   Mixed results resolve to the more conservative: counted, then inconclusive, then not detected.
// - M2, M3 and M4 report each end, and the ages and backlogs seen: envelopes of what was observed.
// - M5 and M6 report aggregate scenario deltas (resident memory, headroom), each named with its scenario. They include
//   transport buffers and the allocator's retention, so they are no cost per frame or per connection.
//
//   node bench/held-output/classify.mjs <observations.jsonl>    prints the outcomes as JSON
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The headroom probe's step: /alloc holds one more MiB per request.
export const PROBE_STEP_BYTES = 1024 * 1024;

/**
 * @typedef {{ type: "run", run: string, measurement: string, at: number, volume?: number, frameBytes?: number,
 *   baseline?: string }} RunRecord
 * @typedef {{ type: "start", run: string, at: number, id: string, kind: "fresh" | "wake", since: number,
 *   listedBefore: number, heldMibBefore: number, probe: boolean }} StartRecord
 * @typedef {{ type: "hand", run: string, client: string, at: number, firstSeq: number, frames: number,
 *   bytes: number }} HandRecord
 * @typedef {{ type: "recv", run: string, client: string, at: number, frames: number, bytes: number,
 *   lastSeq: number, minAge: number, maxAge: number }} RecvRecord
 * @typedef {{ type: "pause" | "resume", run: string, client: string, at: number }} PauseRecord
 * @typedef {{ type: "closed", run: string, client: string, at: number, by: "object" | "client" }} ClosedRecord
 * @typedef {{ type: "end", run: string, client: string, at: number, side: "client" | "server",
 *   code: number | null, reason?: string }} EndRecord
 * @typedef {{ type: "listed", run: string, at: number, sockets: [string, number][] }} ListedRecord
 * @typedef {{ type: "headroom", run: string, at: number, attempt: number, stage?: string, bytes: number | null,
 *   capped?: boolean }} HeadroomRecord
 * @typedef {{ type: "rss", run: string, at: number, attempt: number, stage: string, bytes: number }} RssRecord
 * @typedef {{ type: "surface", run: string, at: number, surface: unknown }} SurfaceRecord
 * @typedef {{ type: "done", run: string, at: number }} DoneRecord
 * @typedef {RunRecord | StartRecord | HandRecord | RecvRecord | PauseRecord | ClosedRecord | EndRecord | ListedRecord
 *   | HeadroomRecord | RssRecord | SurfaceRecord | DoneRecord} Observation
 *
 * @typedef {{ ms: number, bound: "observed" | "lowerBound" }} Age
 * @typedef {{ at: number, side: "client" | "server", code: number | null, cause: "reset" | "closed" | "platform",
 *   sincePause: number | null, receivedFrames: number, handedFrames: number }} End
 * @typedef {{ client: string, handed: { frames: number, bytes: number }, received: { frames: number, bytes: number },
 *   outstandingBytes: number, largestBacklog: number, largestAge: Age | null,
 *   trend: "rising" | "falling" | "steady" | null, unfinishedTail: boolean, ends: End[], resumes: number[],
 *   listedUntil: number | null }} ClientOutcome
 * @typedef {{ scenario: string, stage: string, attempt: number | null, delta: number }} ScenarioDelta
 * @typedef {{ run: string, measurement: string, class: "inconclusive" | "observed", reasons: string[],
 *   resets: { at: number, since: number }[], outstandingBytes: number, clients: ClientOutcome[],
 *   scenarioDeltas: ScenarioDelta[] }} RunOutcome
 * @typedef {"counted" | "inconclusive" | "not detected"} M1Class
 * @typedef {{ run: string, volume: number, frameBytes: number | null, class: M1Class, difference: number | null,
 *   step: number, spread: number | null, fraction: number | null, excludesAbove: number | null }} M1Volume
 * @typedef {{ runs: RunOutcome[], m1: { class: M1Class, volumes: M1Volume[] } | null, surface: unknown }} Report
 */

/** @param {number[]} values */
function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = /** @type {number} */ (sorted[mid]);
  return sorted.length % 2 === 1 ? upper : (/** @type {number} */ (sorted[mid - 1]) + upper) / 2;
}

/** @param {number[]} values */
function range(values) {
  return Math.max(...values) - Math.min(...values);
}

/**
 * The resets of a run: starts that found no socket listed while the run held sockets or heap. A start that found
 * sockets listed is a wake from hibernation, which keeps them connected.
 * @param {StartRecord[]} starts
 */
function resetsOf(starts) {
  return starts.filter((s) => s.kind === "fresh" && (s.listedBefore > 0 || s.heldMibBefore > 0));
}

/**
 * The trend of the per-summary largest ages: rising when every summary of the last third saw an older frame than any
 * of the first third, falling for the reverse, steady otherwise.
 * @param {RecvRecord[]} recvs
 * @returns {"rising" | "falling" | "steady" | null}
 */
function trendOf(recvs) {
  if (recvs.length < 3) {
    return null;
  }
  const third = Math.floor(recvs.length / 3);
  const first = recvs.slice(0, third).map((r) => r.maxAge);
  const last = recvs.slice(-third).map((r) => r.maxAge);
  if (Math.min(...last) > Math.max(...first)) {
    return "rising";
  }
  return Math.max(...last) < Math.min(...first) ? "falling" : "steady";
}

/**
 * @param {Observation[]} records
 * @param {number} end the run's end (its `done`, or its last record)
 * @param {StartRecord[]} resets
 */
function clientsOf(records, end, resets) {
  /** @type {Map<string, { hands: HandRecord[], recvs: RecvRecord[], pauses: PauseRecord[], resumes: PauseRecord[],
   *   closed: ClosedRecord[], ends: EndRecord[] }>} */
  const byClient = new Map();
  /** @param {string} client */
  const of = (client) => {
    let entry = byClient.get(client);
    if (entry === undefined) {
      entry = { hands: [], recvs: [], pauses: [], resumes: [], closed: [], ends: [] };
      byClient.set(client, entry);
    }
    return entry;
  };
  /** @type {ListedRecord[]} */
  const listings = [];
  for (const record of records) {
    switch (record.type) {
      case "hand":
        of(record.client).hands.push(record);
        break;
      case "recv":
        of(record.client).recvs.push(record);
        break;
      case "pause":
        of(record.client).pauses.push(record);
        break;
      case "resume":
        of(record.client).resumes.push(record);
        break;
      case "closed":
        of(record.client).closed.push(record);
        break;
      case "end":
        of(record.client).ends.push(record);
        break;
      case "listed":
        listings.push(record);
        break;
      default:
        break;
    }
  }
  /** @type {ClientOutcome[]} */
  const outcomes = [];
  for (const [client, { hands, recvs, pauses, resumes, closed, ends }] of byClient) {
    const handed = { frames: 0, bytes: 0 };
    for (const hand of hands) {
      handed.frames += hand.frames;
      handed.bytes += hand.bytes;
    }
    const received = { frames: 0, bytes: 0 };
    let lastSeq = -1;
    let observedAge = -Infinity;
    for (const recv of recvs) {
      received.frames += recv.frames;
      received.bytes += recv.bytes;
      lastSeq = Math.max(lastSeq, recv.lastSeq);
      observedAge = Math.max(observedAge, recv.maxAge);
    }
    // The backlog over time: handed less received, at each hand and each summary.
    let largestBacklog = 0;
    let backlog = 0;
    const steps = [
      ...hands.map((h) => ({ at: h.at, delta: h.bytes })),
      ...recvs.map((r) => ({ at: r.at, delta: -r.bytes })),
    ].toSorted((a, b) => a.at - b.at || b.delta - a.delta);
    for (const step of steps) {
      backlog += step.delta;
      largestBacklog = Math.max(largestBacklog, backlog);
    }
    const lastHanded = hands.reduce((most, h) => Math.max(most, h.firstSeq + h.frames - 1), -1);
    const unfinishedTail = ends.length === 0 && lastHanded > lastSeq;
    /** @type {Age | null} */
    let largestAge = Number.isFinite(observedAge) ? { ms: observedAge, bound: "observed" } : null;
    if (unfinishedTail) {
      // Frames arrive in order, so the oldest outstanding frame is the one after the last received.
      const oldest = hands.find((h) => h.firstSeq <= lastSeq + 1 && lastSeq + 1 < h.firstSeq + h.frames);
      const waited = oldest === undefined ? -Infinity : end - oldest.at;
      largestAge = { ms: Math.max(observedAge, waited), bound: "lowerBound" };
    }
    // The listing that first left the client out after one that held it; the run's end while it is still listed.
    let listedUntil = null;
    let listedNow = false;
    for (const listing of listings) {
      const holds = listing.sockets.some(([name]) => name === client);
      if (listedNow && !holds) {
        listedUntil = listing.at;
      }
      listedNow = holds;
    }
    if (listedNow) {
      listedUntil = end;
    }
    outcomes.push({
      client,
      handed,
      received,
      outstandingBytes: handed.bytes - received.bytes,
      largestBacklog,
      largestAge,
      trend: trendOf(recvs),
      unfinishedTail,
      ends: ends.map((e) => {
        const pause = pauses.findLast((p) => p.at <= e.at);
        const reset = resets.find((r) => r.since < e.at);
        /** @type {End["cause"]} */
        let cause = "platform";
        if (reset !== undefined) {
          cause = "reset";
        } else if (closed.some((c) => c.at <= e.at)) {
          cause = "closed";
        }
        return {
          at: e.at,
          side: e.side,
          code: e.code,
          cause,
          sincePause: pause === undefined ? null : e.at - pause.at,
          receivedFrames: recvs.filter((r) => r.at <= e.at).reduce((sum, r) => sum + r.frames, 0),
          handedFrames: handed.frames,
        };
      }),
      resumes: resumes.map((r) => r.at),
      listedUntil,
    });
  }
  return outcomes;
}

/**
 * The aggregate deltas of a run's resident-memory samples and headroom stages, each against its scenario's baseline.
 * @param {Observation[]} records
 * @returns {ScenarioDelta[]}
 */
function scenarioDeltasOf(records) {
  /** @type {ScenarioDelta[]} */
  const deltas = [];
  const rss = records.filter((r) => r.type === "rss");
  for (const sample of rss) {
    const baseline = rss.find((r) => r.stage === "baseline" && r.attempt === sample.attempt);
    if (baseline !== undefined && sample !== baseline) {
      deltas.push({
        scenario: `${sample.run} resident memory`,
        stage: sample.stage,
        attempt: sample.attempt,
        delta: sample.bytes - baseline.bytes,
      });
    }
  }
  const headroom = /** @type {HeadroomRecord[]} */ (records.filter((r) => r.type === "headroom" && r.stage));
  /** @param {string} stage */
  const at = (stage) => headroom.filter((h) => h.stage === stage && h.bytes !== null).map((h) => Number(h.bytes));
  const base = at("baseline");
  for (const stage of new Set(headroom.map((h) => h.stage))) {
    const values = at(/** @type {string} */ (stage));
    if (stage !== "baseline" && base.length > 0 && values.length > 0) {
      deltas.push({
        scenario: `${headroom[0]?.run} headroom`,
        stage: /** @type {string} */ (stage),
        attempt: null,
        delta: median(values) - median(base),
      });
    }
  }
  return deltas;
}

/**
 * @param {string} run
 * @param {Observation[]} records
 * @returns {RunOutcome}
 */
function classifyRun(run, records) {
  const head = records.find((r) => r.type === "run");
  // What follows the `done` record is the driver's cleanup, whatever clock stamped it.
  const doneAt = records.findIndex((r) => r.type === "done");
  const done = records[doneAt];
  const measured = doneAt < 0 ? records : records.slice(0, doneAt);
  const end = done?.at ?? Math.max(...records.map((r) => r.at));
  const starts = measured.filter((r) => r.type === "start");
  const resets = resetsOf(starts);
  const clients = clientsOf(measured, end, resets);
  /** @type {string[]} */
  const reasons = [];
  const other = resets.filter((r) => !r.probe);
  if (other.length > 0) {
    reasons.push("a reset other than the headroom probe's own");
  }
  if (clients.some((c) => c.unfinishedTail)) {
    reasons.push("an unfinished tail");
  }
  if (done === undefined) {
    reasons.push("the run did not finish");
  }
  return {
    run,
    measurement: head?.measurement ?? run,
    class: reasons.length > 0 ? "inconclusive" : "observed",
    reasons,
    resets: other.map((r) => ({ at: r.at, since: r.since })),
    outstandingBytes: clients.filter((c) => c.ends.length === 0).reduce((sum, c) => sum + c.outstandingBytes, 0),
    clients,
    scenarioDeltas: scenarioDeltasOf(records),
  };
}

/** @type {M1Class[]} */
const CONSERVATIVE_ORDER = ["counted", "inconclusive", "not detected"];

/**
 * M1's class per held volume against its baseline run, and the class of all of them.
 * @param {Map<string, Observation[]>} byRun
 * @param {RunOutcome[]} outcomes
 */
function classifyM1(byRun, outcomes) {
  const heads = /** @type {RunRecord[]} */ (
    [...byRun.values()].flatMap((records) => records.filter((r) => r.type === "run" && r.measurement === "m1"))
  );
  if (heads.length === 0) {
    return null;
  }
  /** @param {string} run */
  const headroomOf = (run) => (byRun.get(run) ?? []).filter((r) => r.type === "headroom");
  /** @param {string} run */
  const conclusive = (run) => {
    const records = headroomOf(run);
    return (
      outcomes.find((o) => o.run === run)?.class === "observed" &&
      records.length > 0 &&
      records.every((h) => h.bytes !== null && h.capped !== true)
    );
  };
  /** @type {M1Volume[]} */
  const volumes = [];
  for (const head of heads) {
    if ((head.volume ?? 0) === 0) {
      continue;
    }
    const volume = /** @type {number} */ (head.volume);
    const baseline = head.baseline ?? "";
    /** @type {M1Volume} */
    const entry = {
      run: head.run,
      volume,
      frameBytes: head.frameBytes ?? null,
      class: "inconclusive",
      difference: null,
      step: PROBE_STEP_BYTES,
      spread: null,
      fraction: null,
      excludesAbove: null,
    };
    if (conclusive(head.run) && conclusive(baseline)) {
      const base = headroomOf(baseline).map((h) => Number(h.bytes));
      const held = headroomOf(head.run).map((h) => Number(h.bytes));
      const difference = median(base) - median(held);
      const spread = Math.max(range(base), range(held));
      entry.difference = difference;
      entry.spread = spread;
      entry.fraction = difference / volume;
      if (difference > PROBE_STEP_BYTES + spread) {
        entry.class = "counted";
      } else {
        entry.class = "not detected";
        entry.excludesAbove = (PROBE_STEP_BYTES + spread) / volume;
      }
    }
    volumes.push(entry);
  }
  const found = new Set(volumes.map((v) => v.class));
  const resolved = CONSERVATIVE_ORDER.find((c) => found.has(c)) ?? "inconclusive";
  return { class: resolved, volumes };
}

/**
 * @param {Observation[]} observations
 * @returns {Report}
 */
export function classify(observations) {
  /** @type {Map<string, Observation[]>} */
  const byRun = new Map();
  for (const record of observations) {
    const list = byRun.get(record.run) ?? [];
    list.push(record);
    byRun.set(record.run, list);
  }
  const runs = [...byRun].map(([run, records]) => classifyRun(run, records));
  const surfaces = observations.filter((r) => r.type === "surface");
  return { runs, m1: classifyM1(byRun, runs), surface: surfaces.at(-1)?.surface ?? null };
}

/**
 * @param {string} text the JSON lines `run.mjs` writes
 * @returns {Observation[]}
 */
export function parseObservations(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => /** @type {Observation} */ (JSON.parse(line)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("usage: node bench/held-output/classify.mjs <observations.jsonl>");
    process.exit(2);
  }
  console.log(JSON.stringify(classify(parseObservations(readFileSync(path, "utf8"))), null, 2));
}
