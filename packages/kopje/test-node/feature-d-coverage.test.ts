// The drift record of spec/feature-d/ (scripts/feature-d-coverage.mjs): every Kopje source file the TLA+
// specification describes still has the blob recorded when the specification was last confirmed to describe it, and
// still defines the functions named. A failure names the file: rerun the specification and the replay
// (.claude/skills/verify-feature-d/SKILL.md), change the specification through a challenge if the behaviour changed,
// then move the record forward with `node scripts/feature-d-coverage.mjs forward`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { blobOf, readRecord } from "../scripts/feature-d-coverage.mjs";

const record = readRecord();
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

describe(`spec/feature-d's coverage record (confirmed at ${record.confirmed.slice(0, 12)})`, () => {
  for (const file of record.files) {
    it(`${file.path} is as recorded`, () => {
      expect(blobOf(file.path), `${file.path} changed since ${record.confirmed}: re-look (${file.spec})`).toBe(
        file.blob,
      );
    });
    if (file.blob === null || file.functions.length === 0) continue;
    it(`${file.path} defines ${file.functions.join(", ")}`, () => {
      const source = readFileSync(`${PACKAGE}${file.path}`, "utf8");
      const names = file.functions.map((name) => name.split(".").at(-1) ?? name);
      expect(names.filter((name) => !new RegExp(`\\b${name}\\b`).test(source))).toEqual([]);
    });
  }
});
