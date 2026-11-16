import { type ChildProcess, spawn } from "node:child_process";
import * as realFs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withTarget } from "../bench/held-output/run.mjs";

// How the held-output bench's driver (bench/held-output/run.mjs, #1610) removes what it started: the driver runs in a
// process of its own, as the command does, against a fake wrangler whose "Worker" is a file, and is stopped the way a
// terminal stops a command, with a signal to its whole process group.

const fault = vi.hoisted(() => ({ secretWrite: false, made: [] as string[] }));

// The disk fills while the token's file is written: two bytes short of its end, so the token itself is on disk.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof realFs>();
  return {
    ...fs,
    mkdtempSync: (prefix: string) => {
      const dir = fs.mkdtempSync(prefix);
      fault.made.push(dir);
      return dir;
    },
    writeFileSync: (file: string, data: string, options?: realFs.WriteFileOptions) => {
      if (fault.secretWrite && /(?:secrets\.json|\.dev\.vars)$/.test(file)) {
        fs.writeFileSync(file, data.slice(0, -2), options);
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      }
      fs.writeFileSync(file, data, options);
    },
  };
});

const RUN = pathToFileURL(fileURLToPath(new URL("../bench/held-output/run.mjs", import.meta.url))).href;

// wrangler as the driver runs it: `deploy`, `delete` and `deployments status`, each logged, against a Worker that
// exists while the file `remote` does. Interrupted by SIGTERM, a deploy's command ends but its upload lands a little
// later, as a remote deploy may.
const FAKE_WRANGLER = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const mode = process.env.FAKE_MODE ?? "";
const remote = join(state, "remote");
const log = (line) => appendFileSync(join(state, "log"), line + "\\n");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const missing = "This Worker does not exist on your account. [code: 10007]";
const landLater = () =>
  spawn(
    process.execPath,
    ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], ''), 300)", remote],
    { detached: true, stdio: "ignore" },
  ).unref();
process.on("SIGTERM", () => {
  log(command + " interrupted");
  if (command === "deploy") landLater();
  process.exit(1);
});
if (command === "deploy") {
  const token = JSON.parse(readFileSync(args[args.indexOf("--secrets-file") + 1], "utf8")).BENCH_TOKEN;
  log("deploy start " + token);
  await wait(Number(process.env.FAKE_DEPLOY_MS));
  if (mode === "deploy-leaks") {
    console.log("uploading with " + token);
    console.error("failed: " + token);
    process.exit(1);
  }
  if (mode === "deploy-lands-late") {
    landLater();
    log("deploy failed");
    process.exit(1);
  }
  writeFileSync(remote, "");
  log("deploy done");
  console.log("Deployed\\n  https://kopje-bench-held-test.example.workers.dev");
} else if (command === "delete") {
  log("delete start");
  await wait(Number(process.env.FAKE_DELETE_MS));
  if (mode === "delete-fails-once" && !existsSync(join(state, "failed-once"))) {
    writeFileSync(join(state, "failed-once"), "");
    log("delete failed");
    process.exit(1);
  }
  if (!existsSync(remote)) {
    log("delete missing");
    console.error(missing);
    process.exit(1);
  }
  rmSync(remote);
  log("delete done");
} else if (command === "deployments") {
  if (existsSync(remote)) {
    log("status present");
    console.log("{}");
  } else {
    log("status gone");
    console.error(missing);
    process.exit(1);
  }
}
`;

// The command's own entry, with the fake wrangler and short waits.
const HARNESS = `
const [run, wrangler, out, settleMs] = process.argv.slice(2);
const { cli } = await import(run);
const cleanup = { settleMs: Number(settleMs), retryMs: 100, attempts: 3 };
await cli(["--runs", "m2", "--out", out], { wrangler, cleanup });
`;

let dir: string;
let driver: ChildProcess | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "held-output-cleanup-"));
  writeFileSync(join(dir, "fake-wrangler.mjs"), FAKE_WRANGLER);
  writeFileSync(join(dir, "harness.mjs"), HARNESS);
});

afterEach(() => {
  if (driver?.pid !== undefined && driver.exitCode === null && driver.signalCode === null) {
    process.kill(-driver.pid, "SIGKILL");
  }
  driver = null;
  fault.secretWrite = false;
  rmSync(dir, { recursive: true, force: true });
});

const lines = () => (existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").split("\n") : []);

async function eventually(ready: () => boolean) {
  for (let i = 0; i < 300 && !ready(); i += 1) {
    await new Promise((done) => setTimeout(done, 50));
  }
  expect(ready()).toBe(true);
}

/**
 * Runs the command in a process group of its own; at each line in `signalAt`, once the fake logged it, a SIGTERM goes
 * to the whole group. Resolves when the command ended and anything a late deploy would land has landed.
 */
async function drive(mode: string, { deployMs = 0, deleteMs = 0, settleMs = 0, signalAt = [] as string[] } = {}) {
  const out = join(dir, "out");
  let output = "";
  const child = spawn(
    process.execPath,
    [join(dir, "harness.mjs"), RUN, join(dir, "fake-wrangler.mjs"), out, String(settleMs)],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FAKE_STATE: dir,
        FAKE_MODE: mode,
        FAKE_DEPLOY_MS: String(deployMs),
        FAKE_DELETE_MS: String(deleteMs),
      },
    },
  );
  driver = child;
  child.stdout.on("data", (data: Buffer) => (output += data.toString("utf8")));
  child.stderr.on("data", (data: Buffer) => (output += data.toString("utf8")));
  const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
  for (const line of signalAt) {
    await eventually(() => lines().some((l) => l.startsWith(line)));
    process.kill(-child.pid!, "SIGTERM");
  }
  const code = await exited;
  await new Promise((done) => setTimeout(done, 600));
  return { code, output, out, remains: existsSync(join(dir, "remote")) };
}

describe("held-output driver's cleanup", () => {
  it(
    "lets neither a deploy nor a delete be cut short by signals to its process group",
    { timeout: 30_000 },
    async () => {
      const result = await drive("", { deployMs: 1_000, deleteMs: 1_000, signalAt: ["deploy start", "delete start"] });
      expect(result.code).toBe(1);
      expect(lines().filter((l) => l.includes("interrupted"))).toEqual([]);
      expect(lines()).toEqual(expect.arrayContaining(["deploy done", "delete done", "status gone"]));
      expect(result.remains).toBe(false);
      expect(result.output).not.toContain("may remain");
    },
  );

  it("waits for a deploy that did not finish to land, then deletes it", { timeout: 30_000 }, async () => {
    const result = await drive("deploy-lands-late", { settleMs: 1_000 });
    expect(result.code).toBe(1);
    expect(lines().filter((l) => !l.startsWith("deploy start"))).toEqual([
      "deploy failed",
      "delete start",
      "delete done",
      "status gone",
      "",
    ]);
    expect(result.remains).toBe(false);
  });

  it("retries a delete that failed until the Worker is confirmed gone", { timeout: 30_000 }, async () => {
    const result = await drive("delete-fails-once", { deployMs: 500, signalAt: ["deploy start"] });
    expect(lines().filter((l) => l.startsWith("delete") || l.startsWith("status"))).toEqual([
      "delete start",
      "delete failed",
      "status present",
      "delete start",
      "delete done",
      "status gone",
    ]);
    expect(result.remains).toBe(false);
    expect(result.output).not.toContain("may remain");
  });

  it("prints and keeps wrangler's output with the token masked, also in the error it ends with", async () => {
    const result = await drive("deploy-leaks");
    const token = lines()[0]?.replace("deploy start ", "") ?? "";
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.code).toBe(1);
    expect(result.output).toContain("wrangler deploy exited with 1");
    expect(result.output).not.toContain(token);
    const kept = readFileSync(join(result.out, "wrangler-m2.log"), "utf8");
    expect(kept).toContain("failed: <token>");
    expect(kept).not.toContain(token);
  });

  it.each([
    ["deployed", false],
    ["local", true],
  ])("removes the token's file when writing it fails (%s)", async (_, local) => {
    fault.secretWrite = true;
    fault.made.length = 0;
    const fn = vi.fn(async () => {});
    const options = {
      local,
      compat: { date: "2026-10-11", flags: [] },
      out: dir,
      label: "x",
      signal: new AbortController().signal,
      log: () => {},
    };
    await expect(withTarget(options, fn)).rejects.toThrow("ENOSPC");
    expect(fn).not.toHaveBeenCalled();
    const made = fault.made.filter((d) => basename(d).startsWith("kopje-bench-held-"));
    expect(made).toHaveLength(1);
    expect(existsSync(made[0]!)).toBe(false);
  });
});
