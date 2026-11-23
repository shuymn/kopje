import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { avManifest } from "./av-fixtures.js";

// The output verifier's positive controls (test/fixtures/av/, made by scripts/av-fixtures.sh from the shipped image):
// the committed files are the manifest's, byte for byte, and the manifest holds one output for each input the script
// makes. Integrity only: the encoders may write other bytes on another CPU path, so a rerun is not compared.
const DIR = new URL("../test/fixtures/av/", import.meta.url);
const SCRIPT = readFileSync(new URL("../scripts/av-fixtures.sh", import.meta.url), "utf8");

describe("the committed AV fixtures", () => {
  it("are the manifest's files, with its sizes and SHA-256", () => {
    const manifest = avManifest();
    const files = readdirSync(DIR).filter((name) => name !== "manifest.json");
    expect(files.toSorted()).toEqual(manifest.map((f) => f.name).toSorted());
    for (const f of manifest) {
      const bytes = readFileSync(new URL(f.name, DIR));
      expect(bytes.length, f.name).toBe(f.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), f.name).toBe(f.sha256);
      // A few hundred KiB at most (#1828 PR2, A6).
      expect(bytes.length, f.name).toBeLessThan(256 * 1024);
      expect(f.name.endsWith(f.kind === "video" ? ".mp4" : ".mp3"), f.name).toBe(true);
    }
  });

  it("hold one output for every input the script makes", () => {
    // The script's inputs: the last argument of each `ff` line in its input block, but the upright source of the
    // rotated one, which it removes.
    const start = SCRIPT.indexOf("\n{\n");
    const block = SCRIPT.slice(start, SCRIPT.indexOf("\n}\n", start));
    const inputs = [...block.matchAll(/^\s*ff .*?(\S+\.(?:mp4|webm|m4a|flac|ogg|mp3|wav|aac))"?$/gm)]
      .map((m) => m[1] ?? "")
      .filter((name) => name !== "upright.mp4");
    // The HDR loop writes "$out": hlg.mp4 and pq.mp4.
    expect(block).toContain('out=hlg.mp4\n    [ "$trc" = smpte2084 ] && out=pq.mp4');
    const expected = [...inputs, "hlg.mp4", "pq.mp4"].toSorted();
    expect(
      avManifest()
        .map((f) => f.input)
        .toSorted(),
    ).toEqual(expected);
  });
});
