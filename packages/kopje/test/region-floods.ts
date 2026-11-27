import { expect } from "vitest";

import type { PageScan } from "../src/platform/html-scan";

// 1 MiB pages for the scan's work bounds (test/html-scan.test.ts) and its benchmark (test/bench/web-page-scan.bench.ts),
// and the region floods of #1559 with what each must have run: rel=me collection resumes after a plain <svg> or
// <noscript>, so these time the per-descendant handler calls and the end tag handlers.

export const MiB = 1024 * 1024;

// `unit` repeated between `prefix` and `suffix`, as many times as fit in 1 MiB of ASCII.
export function fill(unit: string, prefix = "", suffix = ""): string {
  return prefix + unit.repeat(repeats(unit, prefix, suffix)) + suffix;
}

function repeats(unit: string, prefix = "", suffix = ""): number {
  return Math.floor((MiB - prefix.length - suffix.length) / unit.length);
}

function flood(unit: string, prefix: string, suffix: string, check: (scan: PageScan, n: number) => void) {
  return { page: fill(unit, prefix, suffix), check: (scan: PageScan) => check(scan, repeats(unit, prefix, suffix)) };
}

// A </p> leaves svg, so the anchor after it is a candidate, refused inside the open region.
const OUT = "</p><a rel=me href=x>";
const AFTER = "<a rel=me href=x>";

export const REGION_FLOODS: Record<string, { page: string; check: (scan: PageScan) => void }> = {
  "an unclosed svg of <g/>": flood("<g/>", "<svg>", OUT, (scan, n) => {
    expect(scan).toMatchObject({ relMe: [], relMeAfterForeign: true, resumed: { svg: 0 } });
    // The <svg>, every <g/>, and the anchor's two handlers ("svg *" and "a[rel]").
    expect(scan.work.elements).toBe(1 + n + 2);
  }),
  "an svg of nested closed svgs, latched": flood("<svg></svg>", "<svg>", `</svg>${OUT}`, (scan, n) => {
    expect(scan).toMatchObject({ relMe: [], relMeAfterForeign: true, resumed: { svg: 0 } });
    // The outer <svg>, both handlers of every nested one, and the anchor after the outer </svg>.
    expect(scan.work.elements).toBe(1 + 2 * n + 1);
  }),
  "repeated closed svg regions": flood('<svg><path d="M0 0"/></svg>', "", AFTER, (scan, n) => {
    expect(scan.relMe).toEqual(["x"]);
    expect(scan.resumed.svg).toBe(n);
    // Each region's <svg> and <path>, and the anchor.
    expect(scan.work.elements).toBe(2 * n + 1);
  }),
  "repeated noscript regions": flood("<noscript><img src=x></noscript>", "", AFTER, (scan, n) => {
    expect(scan.relMe).toEqual(["x"]);
    expect(scan.resumed.noscript).toBe(n);
    expect(scan.work.elements).toBe(n + 1);
  }),
  "one 1 MiB noscript": flood("<img src=x>", "<noscript>", `</noscript>${AFTER}`, (scan) => {
    expect(scan).toMatchObject({ relMe: [], relMeAfterNoscript: true, resumed: { noscript: 0 } });
    expect(scan.work.elements).toBe(2);
    expect(scan.work.textChunks).toBeGreaterThan(0);
  }),
};
