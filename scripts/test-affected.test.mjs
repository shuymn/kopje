// Offline checks of test-affected.sh: the suites it picks for changed paths, and what it runs for them, with pnpm
// stubbed to log its arguments and exit with the code in pnpm.exit. Run: pnpm run test:scripts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const script = new URL("./test-affected.sh", import.meta.url).pathname;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

/** @type {string} */
let work;
/** @type {string} */
let bin;
/** @type {string} */
let repo;

/** @param {string[]} args */
function git(...args) {
  const result = spawnSync("git", ["-C", repo, ...GIT, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** @param {string[]} paths */
function suites(...paths) {
  const result = spawnSync("bash", [script, "suites"], { input: paths.join("\n"), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

// Runs the script in the checkout, which decides the suites itself unless env says otherwise.
/**
 * @param {Record<string, string>} [env]
 * @param {string[]} args
 */
function run(env = {}, ...args) {
  writeFileSync(join(work, "pnpm.log"), "");
  const result = spawnSync("bash", [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KOPJE: "", KOPJE_CODE: "", ...env },
  });
  return { status: result.status, stderr: result.stderr, pnpm: readFileSync(join(work, "pnpm.log"), "utf8").trim() };
}

/**
 * @param {boolean} kopje
 * @param {boolean} kopjeCode
 */
const B = (kopje, kopjeCode) => ({ kopje: `${kopje}`, kopje_code: `${kopjeCode}` });

describe("suites", () => {
  it("runs only the Node suite for Kopje Markdown", () => {
    assert.deepEqual(suites("packages/kopje/docs/visibility.md", "packages/kopje/CHANGELOG.md"), B(true, false));
    assert.deepEqual(suites("deploy/README.md"), B(true, false));
  });

  it("runs no suite for Markdown outside the packages", () => {
    assert.deepEqual(suites("AGENTS.md", "README.md", ".claude/rules/kopje-web.md"), B(false, false));
  });

  it("runs Kopje for the scope table its vectors import", () => {
    assert.deepEqual(suites("packages/kopje/docs/mastodon-api-spec/client-api/auth-oauth.md"), B(true, true));
  });

  // test-node/witness-recording.test.ts records the flows of witness-world.ts on the Store's sources and compares
  // recorded.json with them, so a change to any of the three runs the Node suite.
  it("runs the Node suite for the witness recording and what it records", () => {
    for (const path of [
      "packages/kopje/test/main-runtime/recorded.json",
      "packages/kopje/test/main-runtime/witness-world.ts",
      "packages/kopje/src/domain/audience.ts",
      "packages/kopje/src/domain/windows.ts",
    ]) {
      assert.deepEqual(suites(path), B(true, true), path);
    }
  });

  it("runs every suite for code, root config and an empty list", () => {
    assert.deepEqual(suites("packages/kopje/docs/x.md", "packages/kopje/src/store.ts"), B(true, true));
    assert.deepEqual(suites("pnpm-lock.yaml"), B(true, true));
    assert.deepEqual(suites(), B(true, true));
  });
});

describe("runs", () => {
  before(() => {
    work = mkdtempSync(join(tmpdir(), "test-affected-test-"));
    bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pnpm"),
      [
        "#!/usr/bin/env bash",
        `echo "$*" >>"${join(work, "pnpm.log")}"`,
        'echo "vitest output"',
        `exit "$(cat "${join(work, "pnpm.exit")}")"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "pnpm"), 0o755);
  });

  after(() => rmSync(work, { recursive: true, force: true }));

  // A checkout whose origin/main has one Kopje file and whose HEAD changes it.
  beforeEach(() => {
    repo = mkdtempSync(join(work, "repo-"));
    writeFileSync(join(work, "pnpm.exit"), "0");
    mkdirSync(join(repo, "packages/kopje/src"), { recursive: true });
    writeFileSync(join(repo, "packages/kopje/src/a.ts"), "1\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "a");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(repo, "packages/kopje/src/a.ts"), "2\n");
    git("commit", "-q", "-am", "b");
  });

  it("runs every Kopje suite for code, passing the vitest args on, and returns vitest's status", () => {
    assert.equal(
      run(undefined, "--shard", "1/4").pnpm,
      "run test --project kopje --project kopje-streaming --project kopje-main-runtime --project kopje-cli --shard 1/4",
    );
    writeFileSync(join(work, "pnpm.exit"), "1");
    assert.equal(run().status, 1);
  });

  it("runs only the Node suite when CI decided the change is Kopje Markdown", () => {
    assert.equal(run({ KOPJE: "true", KOPJE_CODE: "false" }).pnpm, "run test --project kopje-cli");
  });

  it("runs nothing when no suite reads the change", () => {
    git("reset", "-q", "--hard", "origin/main");
    writeFileSync(join(repo, "AGENTS.md"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "docs");
    const result = run();
    assert.equal(result.status, 0);
    assert.equal(result.pnpm, "");
    assert.match(result.stderr, /no suite reads/);
  });
});
