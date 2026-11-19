// Part 2 of the specification's checks (./checks.ts says how they are split): its share of the checks of checks.json,
// and the replay fixtures.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FIXTURE_DIR, REPLAY_FILE, fixtureText, generateFixtures } from "../collection-consent-fixtures.js";
import { fixtureFiles, plan, readFixture, tlaTsChecks } from "./checks.js";

// A fresh run of every fixture's goal: about 95 s on a laptop, S2-ReadOverRetraction's about 40 s of it. On CI's
// runners it took 224.6 s, 226.6 s and 329.4 s, so the timeout leaves it more than twice its slowest time.
const FIXTURES_TIMEOUT_MS = 900_000;
const REPLAY_PATH = fileURLToPath(new URL(`../../${REPLAY_FILE}`, import.meta.url));

// Each of Kopje's steps in CollectionConsent.tla, an inbound activity by its envelope: the replay fixtures run each
// one.
const KOPJE_STEPS = [
  ...["FR", "Add", "XAdd", "Rem", "Upd", "RemC", "DelR"].map((type) => `KRecv.${type}`),
  "KApplyFetch",
  "KRevoke",
  "KBlock",
  "KSuspend",
  "KUnsuspend",
  "KCleanup",
  "KEvict",
  "KPurge",
  "KClaim",
  "KFetch",
  "KFetch1",
  "KFetch2",
  "KApply",
  "KLease",
  "KStale",
  "KExpire",
  "KDeliver",
  "KGiveUp",
  "KDup",
  "KRetry",
  "KLeaseHead",
  "KFail",
  "KReclaim",
];

// Steps the real Store cannot take: Kopje deletes no local account (src/domain/delivery-hosts.ts, hostCaused).
const MODEL_ONLY = ["KMemberGone"];

tlaTsChecks(import.meta.url);

describe("replay fixtures", () => {
  it("equal a fresh run of the specification", { timeout: FIXTURES_TIMEOUT_MS }, async () => {
    const fresh = await generateFixtures(plan);
    expect(fixtureFiles()).toEqual(fresh.map((f) => `${f.name}.json`).toSorted());
    for (const fixture of fresh) {
      expect(readFileSync(`${FIXTURE_DIR}${fixture.name}.json`, "utf8"), fixture.name).toBe(fixtureText(fixture));
    }
  });

  it("run each of Kopje's steps", () => {
    const covered = new Set(
      fixtureFiles().flatMap((file) =>
        readFixture(file).steps.map((s) => (s.action === "KRecv" ? `KRecv.${s.input.envelope?.type}` : s.action)),
      ),
    );
    expect(KOPJE_STEPS.filter((s) => !covered.has(s))).toEqual([]);
  });

  it("take no step the Store cannot take", () => {
    const taken = fixtureFiles().flatMap((file) =>
      readFixture(file)
        .steps.filter((s) => MODEL_ONLY.includes(s.action))
        .map((s) => `${file}: ${s.action}`),
    );
    expect(taken).toEqual([]);
  });

  it("each name their replay", () => {
    for (const file of fixtureFiles()) {
      const fixture = readFixture(file);
      expect(fixture.replayedBy).toBe(`${REPLAY_FILE}::${fixture.name}`);
    }
  });

  // The replay is the implementer's (a workerd test against the real Store, one test per fixture, titled by the
  // fixture's name). Until it exists only the names above are checked; then each fixture's name must appear as a string
  // literal in it, and it may skip none, so a fixture added later fails here until a test runs it. That each fixture's
  // test ran and passed is checked from the replay's own run (scripts/collection-consent-coverage.mjs forward).
  it.skipIf(!existsSync(REPLAY_PATH))("are each run by the replay they name", () => {
    const source = readFileSync(REPLAY_PATH, "utf8");
    const missing = fixtureFiles()
      .map((file) => readFixture(file).name)
      .filter((name) => !['"', "'", "`"].some((quote) => source.includes(`${quote}${name}${quote}`)));
    expect(missing).toEqual([]);
    expect(source.match(/\.(skip|skipIf|todo|only|fails)\b/g) ?? []).toEqual([]);
  });
});
