// The media processor bench's report (#1828, P27) over measure.sh's results.jsonl. Only a run that succeeded end to
// end counts (`ok`, which worker.ts sets by outcome.mjs): a 200 from the container whose output then failed to reach
// R2, or a video normalize without its still, is a failure, and none of its times enter a p95. Every run the driver
// made is in the denominator, a request that failed before the bench answered included (the driver records its
// operation, fixture, type and threading). Billed usage is joined to the runs by the run id each container carries
// as its `run` label, so each fixture is priced on its own runs, never pooled with another fixture's on the same type
// and threading; its billed utilisation is the vCPU-s over the joined runs' wall time.
//
//   node bench/media-processor/report.mjs <results.jsonl>                 the timing tables, as Markdown
//   node bench/media-processor/report.mjs <results.jsonl> <usage.json>    billed usage per fixture (billing.sh)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{ kind: "run", fixture: string, op: string, expect?: string, instance: string, threads: string, run?: string,
 *   ok?: boolean, status?: number | null, error?: string | null, wallMs?: number, operationMs?: number | null,
 *   startToReadyMs?: number | null, outputToR2Ms?: number | null, imagesWebpMs?: number | null,
 *   imagesRgbaMs?: number | null, destroyMs?: number | null, server?: Record<string, number> }} RunRecord
 * @typedef {{ kind: "ingress", fixture: string, bytes: number, ingressMs: number }} IngressRecord
 * @typedef {{ kind: "dispatch", dispatchMs: number }} DispatchRecord
 * @typedef {{ kind: "hold", seconds: number, status: string }} HoldRecord
 * @typedef {RunRecord | IngressRecord | DispatchRecord | HoldRecord} BenchRecord
 * @typedef {{ run: string, cpuTimeSec: number, allocatedMemory: number, allocatedDisk: number }} Usage
 *   one group of containersUsageAdaptiveGroups by the `run` label: vCPU-s, byte-seconds of memory and of disk
 */

// Containers list prices before the Workers Paid allowance (https://developers.cloudflare.com/containers/platform/pricing/).
const PRICE_VCPU_S = 0.00002;
const PRICE_GIB_S = 0.0000025;
const PRICE_GB_S = 0.00000007;

/** @param {string} text @returns {BenchRecord[]} */
export function parseLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => /** @type {BenchRecord} */ (JSON.parse(line)));
}

/** A run that succeeded end to end. @param {BenchRecord} r @returns {r is RunRecord} */
function succeeded(r) {
  return r.kind === "run" && r.ok === true;
}

/** Nearest rank. @param {number[]} values */
function p95(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
}

/** @param {number} ms @param {number} digits */
const seconds = (ms, digits) => (ms / 1000).toFixed(digits);

/** @param {number[]} values */
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} key
 * @returns {Map<string, T[]>}
 */
function groupBy(items, key) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

/** The timing tables. @param {BenchRecord[]} records @returns {string[]} */
export function timings(records) {
  const runs = records.filter((r) => r.kind === "run");
  const lines = [
    "| fixture | instance | threads | ok/runs | wall p95 | encode p95 | ffmpeg CPU s (mean) | utilisation (mean) | operation p95 |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const normalize = runs.filter((r) => r.op === "normalize");
  for (const group of groupBy(normalize, (r) => JSON.stringify([r.fixture, r.instance, r.threads])).values()) {
    const [first] = group;
    const ok = group.filter(succeeded);
    const cells =
      ok.length === 0
        ? "- | - | - | - | -"
        : [
            seconds(p95(ok.map((r) => r.wallMs ?? 0)), 1),
            seconds(p95(ok.map((r) => r.server?.encode ?? 0)), 1),
            seconds(mean(ok.map((r) => r.server?.["encode-cpu"] ?? 0)), 1),
            mean(ok.map((r) => (r.server?.["encode-cpu"] ?? 0) / (r.server?.encode ?? 1))).toFixed(2),
            seconds(p95(ok.map((r) => r.operationMs ?? 0)), 1),
          ].join(" | ");
    lines.push(
      `| ${first?.fixture} | ${first?.instance} | ${first?.threads} | ${ok.length}/${group.length} | ${cells} |`,
    );
  }
  const ok = runs.filter(succeeded);
  /** @param {string} name @param {(number | null | undefined)[]} values */
  const stage = (name, values) => {
    const v = values.filter((x) => typeof x === "number");
    return `| ${name} | ${v.length} | ${v.length > 0 ? seconds(p95(v), 2) : "-"} |`;
  };
  const stills = ok.filter((r) => r.op === "still");
  const normalized = ok.filter((r) => r.op === "normalize");
  lines.push(
    "",
    "## Stage p95s (seconds)",
    "",
    "| stage | samples | p95 |",
    "|---|---|---|",
    stage(
      "start to ready, normalize",
      normalized.map((r) => r.startToReadyMs),
    ),
    stage(
      "start to ready, still",
      stills.map((r) => r.startToReadyMs),
    ),
    stage(
      "input into the container (server)",
      ok.map((r) => r.server?.input),
    ),
    stage(
      "probe (server)",
      ok.map((r) => r.server?.probe),
    ),
    stage(
      "still in normalize (server)",
      ok.map((r) => r.server?.still),
    ),
    stage(
      "still operation (wall)",
      stills.map((r) => r.wallMs),
    ),
    stage(
      "Images WebP",
      ok.map((r) => r.imagesWebpMs),
    ),
    stage(
      "Images RGBA",
      ok.map((r) => r.imagesRgbaMs),
    ),
    stage(
      "output into R2",
      ok.map((r) => r.outputToR2Ms),
    ),
    stage(
      "destroy",
      ok.map((r) => r.destroyMs),
    ),
    stage(
      "alarm dispatch",
      records.map((r) => (r.kind === "dispatch" ? r.dispatchMs : null)),
    ),
  );
  const ingress = records.filter((r) => r.kind === "ingress");
  if (ingress.length > 0) {
    const bytes = ingress.reduce((a, r) => a + r.bytes, 0);
    const ms = ingress.reduce((a, r) => a + r.ingressMs, 0);
    lines.push(
      "",
      `Ingress into R2 through the Worker: ${(((bytes / ms) * 1000) / 1048576).toFixed(1)} MiB/s over ${ingress.length} fixtures (the client link included).`,
    );
  }
  for (const r of records) {
    if (r.kind === "hold") {
      lines.push(`- headers held ${r.seconds} s: HTTP ${r.status}`);
    }
  }
  return lines;
}

/**
 * Billed usage per fixture, operation, type and threading: each usage group joined to the run whose id its `run`
 * label carries. Usage whose run is not in the results (a run the driver lost, or another bench in the window) is
 * listed apart, never added to a fixture.
 * @param {BenchRecord[]} records
 * @param {Usage[]} usage
 * @returns {string[]}
 */
export function billing(records, usage) {
  /** @type {Map<string, RunRecord>} */
  const byRun = new Map();
  for (const r of records) {
    if (r.kind === "run" && typeof r.run === "string") {
      byRun.set(r.run, r);
    }
  }
  /** @param {Usage[]} rows */
  const sums = (rows) => {
    const cpu = rows.reduce((a, u) => a + u.cpuTimeSec, 0);
    const wallS = rows.reduce((a, u) => a + (byRun.get(u.run)?.wallMs ?? 0), 0) / 1000;
    const gibs = rows.reduce((a, u) => a + u.allocatedMemory, 0) / 1073741824;
    const gbs = rows.reduce((a, u) => a + u.allocatedDisk, 0) / 1e9;
    const price = cpu * PRICE_VCPU_S + gibs * PRICE_GIB_S + gbs * PRICE_GB_S;
    const utilisation = wallS > 0 ? (cpu / wallS).toFixed(2) : "-";
    return `${cpu.toFixed(1)} | ${utilisation} | ${gibs.toFixed(0)} | ${gbs.toFixed(0)} | ${price.toFixed(4)} | ${(price / rows.length).toFixed(4)}`;
  };
  const lines = [
    "| fixture | op | instance | threads | runs billed | ok | vCPU-s | billed utilisation | GiB-s | GB-s | $ list | $ per run |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const known = usage.filter((u) => byRun.has(u.run));
  const groups = groupBy(known, (u) => {
    const r = /** @type {RunRecord} */ (byRun.get(u.run));
    return JSON.stringify([r.fixture, r.op, r.instance, r.threads]);
  });
  for (const [key, rows] of groups) {
    const [fixture, op, instance, threads] = /** @type {string[]} */ (JSON.parse(key));
    const ok = rows.filter((u) => byRun.get(u.run)?.ok === true).length;
    lines.push(`| ${fixture} | ${op} | ${instance} | ${threads} | ${rows.length} | ${ok} | ${sums(rows)} |`);
  }
  const unknown = usage.filter((u) => !byRun.has(u.run));
  if (unknown.length > 0) {
    lines.push(`| (runs not in the results) | | | | ${unknown.length} | | ${sums(unknown)} |`);
  }
  return lines;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const [results, usageFile] = process.argv.slice(2);
  if (results === undefined) {
    console.error("usage: report.mjs <results.jsonl> [<usage.json>]");
    process.exit(2);
  }
  const records = parseLines(readFileSync(results, "utf8"));
  const lines =
    usageFile === undefined
      ? timings(records)
      : billing(records, /** @type {Usage[]} */ (JSON.parse(readFileSync(usageFile, "utf8"))));
  console.log(lines.join("\n"));
}
