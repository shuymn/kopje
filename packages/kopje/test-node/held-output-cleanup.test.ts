import { type ChildProcess, spawn } from "node:child_process";
import * as realFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withTarget } from "../bench/held-output/run.mjs";

// How the held-output bench's driver (bench/held-output/run.mjs, #1610) removes what it started: the driver runs in a
// process of its own, as the command does, against a fake wrangler whose Workers are files, and is stopped the way a
// terminal stops a command, with a signal to its whole process group, or killed outright.

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
const ACCOUNT = "acct-test";

// wrangler as the driver runs it: `whoami`, `deploy`, `delete` and `deployments status`, each logged, against Workers
// that exist while their files do. As wrangler does, it dumps an upload's body when its log is debug and unsanitized,
// and writes an output file when asked. Interrupted by SIGTERM, a deploy's command ends but its upload lands later,
// as a remote deploy may.
const FAKE_WRANGLER = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
const env = process.env;
const state = env.FAKE_STATE;
const modes = new Set((env.FAKE_MODE ?? "").split(","));
const log = (line) => appendFileSync(join(state, "log"), line + "\\n");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const missing = "This Worker does not exist on your account. [code: 10007]";
const remoteOf = (name) => join(state, "remote-" + name);
const option = (flag) => args[args.indexOf(flag) + 1];
const landLater = (name) =>
  spawn(
    process.execPath,
    ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], ''), 800)", remoteOf(name)],
    { detached: true, stdio: "ignore" },
  ).unref();
let name = "";
process.on("SIGTERM", () => {
  log(command + " interrupted");
  if (command === "deploy") landLater(name);
  process.exit(1);
});
if (command === "whoami") {
  console.log(JSON.stringify({ loggedIn: true, accounts: [{ id: "acct-test", name: "Test" }] }, null, 4));
} else if (command === "deploy") {
  name = JSON.parse(readFileSync(option("--config"), "utf8")).name;
  const token = JSON.parse(readFileSync(option("--secrets-file"), "utf8")).BENCH_TOKEN;
  log("deploy start " + token);
  const output = Object.keys(env).filter((key) => key.startsWith("WRANGLER_OUTPUT_FILE_"));
  const seen = [env.WRANGLER_LOG, env.WRANGLER_LOG_SANITIZE, env.CLOUDFLARE_ACCOUNT_ID, output.join("+") || "-"];
  log("deploy env " + seen.join(" "));
  if (env.WRANGLER_LOG === "debug" && env.WRANGLER_LOG_SANITIZE === "false") {
    console.log("BODY: " + Buffer.from("metadata " + token).toString("base64"));
  }
  if (env.WRANGLER_OUTPUT_FILE_DIRECTORY) {
    writeFileSync(join(env.WRANGLER_OUTPUT_FILE_DIRECTORY, "output.json"), JSON.stringify({ token }));
  }
  await wait(Number(env.FAKE_DEPLOY_MS));
  if (modes.has("log-unwritable")) {
    mkdirSync(join(env.FAKE_OUT, "wrangler-m2.log"), { recursive: true });
  }
  if (modes.has("deploy-leaks")) {
    const percent = [...Buffer.from(token)].map((b) => "%" + b.toString(16).padStart(2, "0")).join("");
    console.log("uploading with " + token);
    console.log("as base64 " + Buffer.from(token).toString("base64"));
    console.log("within base64 " + Buffer.from("x" + token + "y").toString("base64url"));
    console.log("percent-encoded " + percent + " " + percent.toUpperCase());
    console.error("failed: " + token);
    process.exit(1);
  }
  if (modes.has("deploy-lands-late")) {
    landLater(name);
    log("deploy failed");
    process.exit(1);
  }
  writeFileSync(remoteOf(name), "");
  log("deploy done");
  console.log("Deployed\\n  https://" + name + ".example.workers.dev");
} else if (command === "delete" || command === "deployments") {
  name = command === "delete" ? args[0] : option("--name");
  appendFileSync(join(state, "accounts"), env.CLOUDFLARE_ACCOUNT_ID + "\\n");
  if (command === "delete") {
    log("delete start");
    await wait(Number(env.FAKE_DELETE_MS));
    if (modes.has("delete-fails-always") || (modes.has("delete-fails-once") && !existsSync(join(state, "failed")))) {
      writeFileSync(join(state, "failed"), "");
      log("delete failed");
      console.error("A request to the Cloudflare API failed.");
      process.exit(1);
    }
    if (!existsSync(remoteOf(name))) {
      log("delete missing");
      console.error(missing);
      process.exit(1);
    }
    rmSync(remoteOf(name));
    log("delete done");
  } else if (existsSync(remoteOf(name))) {
    log("status present");
    console.log("{}");
  } else {
    log("status gone");
    console.error(missing);
    process.exit(1);
  }
}
`;

// The command's own entry (a run of M2, or `cleanup`), with the fake wrangler, short waits and its own records.
const HARNESS = `
const [run, wrangler, out, landingMs, records, command] = process.argv.slice(2);
const { cli } = await import(run);
const cleanup = { landingMs: Number(landingMs), retryMs: 100, attempts: 3 };
await cli(command === "cleanup" ? ["cleanup"] : ["--runs", "m2", "--out", out], { wrangler, cleanup, records });
`;

let dir: string;
let driver: ChildProcess | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "held-output-cleanup-"));
  writeFileSync(join(dir, "fake-wrangler.mjs"), FAKE_WRANGLER);
  writeFileSync(join(dir, "harness.mjs"), HARNESS);
  mkdirSync(join(dir, "tmp"));
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
const steps = () => lines().filter((l) => l.startsWith("delete") || l.startsWith("status"));
const records = () => (existsSync(join(dir, "records")) ? readdirSync(join(dir, "records")) : []);
const remotes = () => readdirSync(dir).filter((f) => f.startsWith("remote-"));
const tokenOf = () => lines()[0]?.replace("deploy start ", "") ?? "";

async function eventually(ready: () => boolean) {
  for (let i = 0; i < 300 && !ready(); i += 1) {
    await new Promise((done) => setTimeout(done, 50));
  }
  expect(ready()).toBe(true);
}

/**
 * Runs the command in a process group of its own; at each line in `signalAt`, once the fake logged it, `kill` goes to
 * the whole group. Resolves when the command ended.
 */
type Drive = {
  deployMs?: number;
  deleteMs?: number;
  landingMs?: number;
  signalAt?: string[];
  kill?: NodeJS.Signals;
  command?: "run" | "cleanup";
  env?: Record<string, string>;
};

async function drive(
  mode: string,
  { deployMs = 0, deleteMs = 0, landingMs = 0, signalAt = [], kill = "SIGTERM", command = "run", env = {} }: Drive = {},
) {
  const out = join(dir, "out");
  let output = "";
  const args = [RUN, join(dir, "fake-wrangler.mjs"), out, String(landingMs), join(dir, "records"), command];
  const child = spawn(process.execPath, [join(dir, "harness.mjs"), ...args], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CLOUDFLARE_ACCOUNT_ID")),
      TMPDIR: join(dir, "tmp"),
      FAKE_STATE: dir,
      FAKE_OUT: out,
      FAKE_MODE: mode,
      FAKE_DEPLOY_MS: String(deployMs),
      FAKE_DELETE_MS: String(deleteMs),
      ...env,
    },
  });
  driver = child;
  child.stdout.on("data", (data: Buffer) => (output += data.toString("utf8")));
  child.stderr.on("data", (data: Buffer) => (output += data.toString("utf8")));
  const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
  for (const line of signalAt) {
    await eventually(() => lines().some((l) => l.startsWith(line)));
    process.kill(-child.pid!, kill);
  }
  const code = await exited;
  return { code, output, out };
}

// Whether `text` holds the token in any form it decodes from: as is, percent-encoded, or base64 at any alignment.
function reveals(text: string, token: string) {
  const unpercented = text.replaceAll(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  if (unpercented.includes(token)) {
    return true;
  }
  for (const run of text.match(/[A-Za-z0-9+/_-]{16,}/g) ?? []) {
    for (let offset = 0; offset < 4; offset += 1) {
      if (Buffer.from(run.slice(offset), "base64").toString("latin1").includes(token)) {
        return true;
      }
    }
  }
  return false;
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
      expect(remotes()).toEqual([]);
      expect(records()).toEqual([]);
      expect(result.output).not.toContain("is not confirmed gone");
    },
  );

  it(
    "keeps the record until the Worker is confirmed gone long enough after its deploy ended",
    { timeout: 30_000 },
    async () => {
      // The deploy's command fails, and its upload lands 0.8 s later: after the first delete found nothing.
      const result = await drive("deploy-lands-late", { landingMs: 2_000 });
      expect(result.code).toBe(1);
      expect(steps().slice(0, 3)).toEqual(["delete start", "delete missing", "status gone"]);
      expect(steps()).toContain("delete done");
      expect(steps().at(-1)).toBe("status gone");
      await new Promise((done) => setTimeout(done, 500));
      expect(remotes()).toEqual([]);
      expect(records()).toEqual([]);
    },
  );

  it("retries a delete that failed until the Worker is confirmed gone", { timeout: 30_000 }, async () => {
    const result = await drive("delete-fails-once", { deployMs: 500, signalAt: ["deploy start"] });
    expect(steps()).toEqual([
      "delete start",
      "delete failed",
      "status present",
      "delete start",
      "delete done",
      "status gone",
    ]);
    expect(remotes()).toEqual([]);
    expect(records()).toEqual([]);
    expect(result.output).not.toContain("is not confirmed gone");
  });

  it("goes on removing the Worker when keeping wrangler's output fails", { timeout: 30_000 }, async () => {
    // The kept log cannot be written (a directory stands in its place), and the first delete fails.
    const result = await drive("delete-fails-once,log-unwritable", { deployMs: 500, signalAt: ["deploy start"] });
    expect(result.output).toContain("could not keep wrangler's output");
    expect(steps().filter((l) => l.startsWith("delete"))).toEqual([
      "delete start",
      "delete failed",
      "delete start",
      "delete done",
    ]);
    expect(remotes()).toEqual([]);
    expect(records()).toEqual([]);
  });

  it("leaves a record when killed outright, from which `cleanup` removes the Worker", { timeout: 30_000 }, async () => {
    await drive("", { deployMs: 1_500, signalAt: ["deploy start"], kill: "SIGKILL" });
    // The deploy outlives the driver, in its own process group, and makes the Worker.
    await eventually(() => lines().includes("deploy done"));
    expect(records()).toHaveLength(1);
    const text = readFileSync(join(dir, "records", records()[0]!), "utf8");
    expect(JSON.parse(text)).toMatchObject({ accountId: ACCOUNT, deployEndedAt: null });
    expect(reveals(text, tokenOf())).toBe(false);
    expect(remotes()).toHaveLength(1);
    // What the killed driver left of its temporary directory, the token's file in it.
    expect(readdirSync(join(dir, "tmp")).filter((d) => d.startsWith("kopje-bench-held-"))).toHaveLength(1);
    const cleanup = await drive("", { command: "cleanup", landingMs: 300 });
    expect(cleanup.code).toBe(0);
    expect(remotes()).toEqual([]);
    expect(records()).toEqual([]);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
    expect(new Set(readFileSync(join(dir, "accounts"), "utf8").trim().split("\n"))).toEqual(new Set([ACCOUNT]));
  });

  it(
    "prints the cleanup command when it cannot confirm the Worker gone, and keeps the record",
    { timeout: 30_000 },
    async () => {
      const result = await drive("delete-fails-always", { deployMs: 500, signalAt: ["deploy start"] });
      expect(result.output).toContain("pnpm --filter kopje bench:held-output cleanup");
      expect(records()).toHaveLength(1);
      expect(remotes()).toHaveLength(1);
      const cleanup = await drive("", { command: "cleanup" });
      expect(cleanup.code).toBe(0);
      expect(remotes()).toEqual([]);
      expect(records()).toEqual([]);
    },
  );

  it("keeps the token out of what it prints and keeps, in every form, and has wrangler dump nothing", async () => {
    const dumps = join(dir, "dumps");
    mkdirSync(dumps);
    // An environment asking wrangler for its debug log unsanitized, and for an output file.
    const env = { WRANGLER_LOG: "debug", WRANGLER_LOG_SANITIZE: "false", WRANGLER_OUTPUT_FILE_DIRECTORY: dumps };
    const result = await drive("deploy-leaks", { env });
    const token = tokenOf();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.code).toBe(1);
    expect(result.output).toContain("wrangler deploy exited with 1");
    expect(reveals(result.output, token)).toBe(false);
    const kept = readFileSync(join(result.out, "wrangler-m2.log"), "utf8");
    expect(kept).toContain("failed: <token>");
    expect(reveals(kept, token)).toBe(false);
    expect(lines()).toContain(`deploy env log true ${ACCOUNT} -`);
    expect(readdirSync(dumps)).toEqual([]);
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
