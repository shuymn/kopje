// The Store baseline bench (#1610, RES-3): the idle Store isolate's committed footprint, measured on the conservative
// side, the baseline the held stream output's allowances rest on. A measurement, not a test: it runs locally on the
// pinned workerd and changes nothing outside its temporary directory.
//
//   pnpm --filter kopje bench:store-baseline [--runs <n>] [--out <dir>]
//
// It packs the package once, then for each run (three by default), from an empty state directory: copies the
// repository's deploy/ template into a temporary directory, installs the packed package and the template's wrangler
// there, and starts `wrangler dev` (local mode, `--local-upstream i.test`) with an inspector port and an IMPORT_TOKEN
// and USER_KEK made for the run. Through `kopje-admin --import-token` it sets the domain, imports a dump of two local
// accounts with a token each (written by the package's own dump writer against the Store's catalog), and publishes.
// It then warms the Store with one GET, with the first account's token, to every GET route of the access fixture
// (test/fixtures/mastodon-*-api-access.json, `test/mastodon-access.test.ts`) and opens one streaming socket on `user`,
// and over the inspector's CDP session runs `HeapProfiler.collectGarbage`, `HeapProfiler.takeHeapSnapshot` and
// `Runtime.getHeapUsage`. The run's measure is `measure.mjs`'s sum. The largest of the runs is the baseline.
//
// The template's wrangler always gives miniflare's Durable Object wrapper, which writes its own table into the Store's
// SQLite at every start, and a Store holding a row refuses the token's import; the copy's wrangler (in the temporary
// directory only) is patched to leave the wrapper out. The run fails unless the copy's workerd is the one the package's
// own wrangler resolves (the pinned workerd).
//
// Output (the directory printed, default `store-baseline-<time>` where pnpm ran): runs.jsonl, one line a run with the
// workerd version (and V8's, when the inspector reports it), the four `getHeapUsage` fields, `native`, the node count,
// the snapshot's whole `self_size` and its `self_size` by node type; and summary.json with the largest sum and the
// date.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { measure } from "./measure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const require = createRequire(import.meta.url);
const DOMAIN = "i.test";
const WORKER = "kopje-bench-baseline";
const MINUTE_MS = 60_000;

/** @param {string} line */
function log(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

/** The workerd version the package's own wrangler resolves: the pinned workerd. */
function pinnedWorkerd() {
  const wrangler = dirname(require.resolve("wrangler/package.json"));
  const miniflare = dirname(createRequire(join(wrangler, "package.json")).resolve("miniflare/package.json"));
  const workerd = createRequire(join(miniflare, "package.json")).resolve("workerd/package.json");
  return /** @type {{ version: string }} */ (JSON.parse(readFileSync(workerd, "utf8"))).version;
}

/** @param {string} dir the packed package, as `kopje.tgz` in `dir` */
function pack(dir) {
  execFileSync("pnpm", ["--filter", "kopje", "pack", "--pack-destination", dir], {
    cwd: packageRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const tarball = readdirSync(dir).find((f) => /^kopje-.*\.tgz$/.test(f));
  if (tarball === undefined) {
    throw new Error("pnpm pack wrote no tarball");
  }
  return join(dir, tarball);
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

/**
 * The deploy template copied into `app`, the packed package and the template's wrangler installed, and the copy's
 * wrangler patched to leave miniflare's Durable Object wrapper out. Returns the copy's workerd version.
 * @param {string} app
 * @param {string} tarball
 */
function install(app, tarball) {
  cpSync(join(repositoryRoot, "deploy"), app, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|\.wrangler)([/\\]|$)/.test(source),
  });
  const config = join(app, "wrangler.jsonc");
  const text = readFileSync(config, "utf8");
  if (text.split('"name": "my-kopje",').length !== 2) {
    throw new Error('deploy/wrangler.jsonc has no single "name": "my-kopje": the template changed');
  }
  writeFileSync(config, text.replace('"name": "my-kopje",', `"name": "${WORKER}",`));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: app,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const cli = join(app, "node_modules", "wrangler", "wrangler-dist", "cli.js");
  const source = readFileSync(cli, "utf8");
  const [before, after] = ["unsafeInspectDurableObjects: true,", "unsafeInspectDurableObjects: false,"];
  if (source.split(before).length !== 2) {
    throw new Error(`${cli}: expected one ${before}: wrangler changed`);
  }
  writeFileSync(cli, source.replace(before, after));
  const workerd = createRequire(join(app, "node_modules", "miniflare", "package.json")).resolve("workerd/package.json");
  return /** @type {{ version: string }} */ (JSON.parse(readFileSync(workerd, "utf8"))).version;
}

/**
 * `wrangler dev` of the copy in its own process group, until `stop` is called.
 * @param {string} app
 * @param {{ port: number, inspector: number, state: string, logFile: string }} options
 */
function startWrangler(app, { port, inspector, state, logFile }) {
  const output = createWriteStream(logFile);
  const child = spawn(
    process.execPath,
    [
      join(app, "node_modules", "wrangler", "bin", "wrangler.js"),
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspector),
      "--persist-to",
      state,
      "--local-upstream",
      DOMAIN,
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    {
      cwd: app,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", X_LOCAL_EXPLORER: "false" },
    },
  );
  child.stdout?.pipe(output);
  child.stderr?.pipe(output);
  const exited = new Promise((done) => child.on("exit", done));
  return {
    exited,
    async stop() {
      const group = child.pid;
      if (group !== undefined) {
        try {
          process.kill(-group, "SIGINT");
        } catch {
          // Already gone.
        }
        const stopped = await Promise.race([exited.then(() => true), delay(15_000).then(() => false)]);
        if (!stopped) {
          try {
            process.kill(-group, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
      await new Promise((done) => output.end(done));
    },
  };
}

/**
 * Waits until `ready` returns a value other than undefined, or fails after `timeoutMs`.
 * @template T
 * @param {() => Promise<T | undefined>} ready
 * @param {number} timeoutMs
 * @param {string} what
 * @returns {Promise<T>}
 */
async function until(ready, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await ready();
      if (value !== undefined) {
        return value;
      }
    } catch {
      // Not yet.
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(1000);
  }
}

/**
 * Runs the copy's kopje-admin with the instance's URL and import token.
 * @param {string} app
 * @param {{ base: string, importToken: string }} instance
 * @param {string[]} args
 */
function admin(app, { base, importToken }, args) {
  return execFileSync(process.execPath, [join(app, "node_modules", "kopje", "cli", "kopje-admin.js"), ...args], {
    cwd: app,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KOPJE_ADMIN_URL: base, KOPJE_IMPORT_TOKEN: importToken },
  });
}

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

/**
 * A local account's key pair, its private key wrapped with the KEK as src/security/key-wrap.ts wraps it.
 * @param {string} kek
 */
async function accountKey(kek) {
  const { subtle } = webcrypto;
  const pair = await subtle.generateKey(
    { ...RSA, modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const salt = new Uint8Array(randomBytes(16));
  const material = await subtle.importKey("raw", new TextEncoder().encode(kek), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 10000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const privkey = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: salt }, key, pkcs8));
  const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey)).toString("base64");
  return { privkey, salt, pubkey: `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----` };
}

/**
 * A dump of two local accounts with a token each, written by the installed package's dump writer against the Store's
 * catalog. Returns the first account's id and token.
 * @param {string} app
 * @param {string} catalogJson `kopje-admin catalog --import-token`'s output
 * @param {string} kek
 * @param {string} path
 */
async function writeAccounts(app, catalogJson, kek, path) {
  const lib = (/** @type {string} */ rel) =>
    import(pathToFileURL(join(app, "node_modules", "kopje", "cli", "lib", rel)).href);
  /**
   * @typedef {import("node:sqlite").DatabaseSync} Db
   * @typedef {{ migrations: unknown[], tables: unknown[] }} Catalog
   */
  const { createKopjeDatabase, migrationRecords, readCatalog, writeDump } =
    /** @type {{ createKopjeDatabase: () => Db, migrationRecords: () => unknown[], readCatalog: (db: Db) => unknown[],
     *   writeDump: (db: Db, options: { path: string, catalog: unknown[], migrations: unknown[], createdAt: string,
     *   source: { build: string, version: string } }) => unknown }} */ (await lib("cutover/kopje-db.js"));
  const parsed = /** @type {Catalog & { catalog?: Catalog }} */ (JSON.parse(catalogJson));
  const target = parsed.catalog ?? parsed;
  const db = createKopjeDatabase();
  if (JSON.stringify(migrationRecords()) !== JSON.stringify(target.migrations)) {
    throw new Error("the Store's migrations are not the package's");
  }
  if (JSON.stringify(readCatalog(db)) !== JSON.stringify(target.tables)) {
    throw new Error("the Store's catalog is not the package's");
  }
  const insert = (/** @type {string} */ table, /** @type {Record<string, unknown>} */ values) => {
    const columns = Object.keys(values);
    db.prepare(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(...columns.map((c) => /** @type {import("node:sqlite").SQLInputValue} */ (values[c])));
  };
  const at = "2026-11-01T00:00:00.000Z";
  const clientId = randomBytes(24).toString("base64url");
  const ids = [0n, 1n].map((n) => ((BigInt(Date.parse(at)) << 16n) | n).toString());
  /** @type {{ id: string, secret: string }[]} */
  const tokens = [];
  for (const [i, username] of ["alice", "bob"].entries()) {
    const id = ids[i] ?? "";
    const key = await accountKey(kek);
    insert("accounts", {
      id,
      uri: `https://${DOMAIN}/ap/users/${username}`,
      username,
      domain: null,
      search_text: username,
      created_at: at,
    });
    insert("local_accounts", {
      account_id: id,
      email: `${username}@${DOMAIN}`,
      privkey: key.privkey,
      privkey_salt: key.salt,
      pubkey: key.pubkey,
      created_at: at,
    });
    tokens.push({ id, secret: randomBytes(32).toString("base64url") });
  }
  insert("oauth_clients", {
    id: clientId,
    secret: randomBytes(32).toString("base64url"),
    name: "kopje-bench-baseline",
    redirect_uris: "urn:ietf:wg:oauth:2.0:oob",
    scopes: "read write follow push",
    authorized: 1,
    created_at: at,
  });
  for (const { id, secret } of tokens) {
    insert("oauth_tokens", {
      token_hash: createHash("sha256").update(secret).digest("hex"),
      kind: "access",
      client_id: clientId,
      account_id: id,
      scopes: "read write follow push",
      created_at: at,
      epoch: 0,
    });
  }
  db.prepare("INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('last_local_id', ?)").run(ids[1] ?? "");
  writeDump(db, {
    path,
    catalog: target.tables,
    migrations: target.migrations,
    createdAt: new Date().toISOString(),
    source: { build: "kopje-bench-baseline", version: "0.0.0" },
  });
  const first = tokens[0];
  if (first === undefined) {
    throw new Error("no token");
  }
  return first;
}

/**
 * One GET to every GET route of the access fixture, with `token`, its path parameters taken as the account's id.
 * @param {string} base
 * @param {string} token
 * @param {string} accountId
 */
async function warm(base, token, accountId) {
  const fixtures = readdirSync(join(packageRoot, "test", "fixtures")).filter((f) =>
    /^mastodon-[\d.]+-api-access\.json$/.test(f),
  );
  if (fixtures.length !== 1) {
    throw new Error(`expected one access fixture, found ${fixtures.length}`);
  }
  const fixture = /** @type {{ routes: { method: string, path: string }[] }} */ (
    JSON.parse(readFileSync(join(packageRoot, "test", "fixtures", fixtures[0] ?? ""), "utf8"))
  );
  const paths = fixture.routes
    .filter((route) => route.method === "GET" && !route.path.startsWith("/api/v1/streaming"))
    .map((route) => route.path.replace(/:[a-z_]+/g, accountId));
  /** @type {Record<string, number>} */
  const statuses = {};
  for (const path of paths) {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    await response.arrayBuffer();
    statuses[response.status] = (statuses[response.status] ?? 0) + 1;
  }
  return { routes: paths.length, statuses };
}

/**
 * A streaming socket on `user`, open.
 * @param {string} base
 * @param {string} token
 * @returns {Promise<WebSocket>}
 */
async function streamingSocket(base, token) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/v1/streaming?stream=user`, [token]);
  await new Promise((done, fail) => {
    ws.addEventListener("open", done, { once: true });
    ws.addEventListener("error", () => fail(new Error("the streaming socket did not open")), { once: true });
    ws.addEventListener("close", () => fail(new Error("the streaming socket closed")), { once: true });
  });
  return ws;
}

/**
 * The inspector's CDP session on the Worker's isolate.
 * @param {number} inspector
 */
async function session(inspector) {
  const targets = /** @type {{ webSocketDebuggerUrl?: string, title?: string, url?: string }[]} */ (
    await (await fetch(`http://127.0.0.1:${inspector}/json`)).json()
  );
  const target = targets.find((t) => t.webSocketDebuggerUrl !== undefined);
  if (target?.webSocketDebuggerUrl === undefined || targets.length !== 1) {
    throw new Error(`expected one inspector target, found ${JSON.stringify(targets)}`);
  }
  // wrangler's inspector proxy takes a DevTools connection from a local origin only.
  const ws = new WebSocket(
    target.webSocketDebuggerUrl,
    // Node's WebSocket (undici) takes request headers beside the protocols, which the DOM type does not declare.
    /** @type {string[]} */ (/** @type {unknown} */ ({ headers: { origin: "http://localhost" } })),
  );
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the inspector session did not open in 60 s")), MINUTE_MS);
    ws.addEventListener("open", () => (clearTimeout(timer), done(undefined)), { once: true });
    ws.addEventListener("error", () => fail(new Error("the inspector session did not open")), { once: true });
  });
  let next = 0;
  /** @type {Map<number, { done: (value: unknown) => void, fail: (error: Error) => void }>} */
  const pending = new Map();
  /** @type {string[]} */
  let chunks = [];
  ws.addEventListener("message", (event) => {
    const message =
      /** @type {{ id?: number, method?: string, params?: { chunk?: string }, error?: unknown,
       *   result?: unknown }} */ (JSON.parse(String(event.data)));
    if (message.method === "HeapProfiler.addHeapSnapshotChunk") {
      chunks.push(message.params?.chunk ?? "");
      return;
    }
    const waiting = message.id === undefined ? undefined : pending.get(message.id);
    if (waiting !== undefined && message.id !== undefined) {
      pending.delete(message.id);
      if (message.error !== undefined) {
        waiting.fail(new Error(JSON.stringify(message.error)));
      } else {
        waiting.done(message.result);
      }
    }
  });
  // A method the runtime does not answer fails after `timeoutMs` instead of holding the run.
  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<unknown>}
   */
  const call = (method, params = {}, timeoutMs = 5 * MINUTE_MS) =>
    new Promise((done, fail) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, {
        done: (value) => (clearTimeout(timer), done(value)),
        fail: (error) => (clearTimeout(timer), fail(error)),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    target,
    call,
    async snapshot() {
      chunks = [];
      await call("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      return /** @type {unknown} */ (JSON.parse(chunks.join("")));
    },
    close() {
      ws.close();
    },
  };
}

/**
 * One run from an empty state directory.
 * @param {string} tarball
 * @param {string} out
 * @param {number} index
 * @param {string} pinned
 */
async function oneRun(tarball, out, index, pinned) {
  const dir = mkdtempSync(join(tmpdir(), "kopje-store-baseline-"));
  /** @type {{ stop: () => Promise<void> } | null} */
  let wrangler = null;
  active = {
    dir,
    stop: async () => {
      await wrangler?.stop();
    },
  };
  try {
    const app = join(dir, "app");
    const workerd = install(app, tarball);
    if (workerd !== pinned) {
      throw new Error(`the template's wrangler runs workerd ${workerd}, not the pinned ${pinned}`);
    }
    const importToken = randomBytes(36).toString("base64url");
    const kek = randomBytes(36).toString("base64url");
    writeFileSync(join(app, ".dev.vars"), `IMPORT_TOKEN=${importToken}\nUSER_KEK=${kek}\n`, { mode: 0o600 });
    const port = await freePort();
    const inspector = await freePort();
    const state = join(dir, "state");
    mkdirSync(state);
    wrangler = startWrangler(app, { port, inspector, state, logFile: join(out, `wrangler-${index}.log`) });
    log(`run ${index}: wrangler dev on port ${port}, inspector ${inspector}`);
    const instance = { base: `http://127.0.0.1:${port}`, importToken };
    await until(
      async () => ((await fetch(`${instance.base}/`)).status > 0 ? true : undefined),
      3 * MINUTE_MS,
      "wrangler",
    );
    // The first call schedules the empty Store's migrations; health answers once they ran.
    await until(
      () => {
        admin(app, instance, ["health", "--import-token"]);
        return Promise.resolve(true);
      },
      2 * MINUTE_MS,
      "health",
    );
    log(`run ${index}: migrated; domain, catalog, import, publish`);
    admin(app, instance, ["config", "--import-token", `domain=${DOMAIN}`]);
    const catalog = admin(app, instance, ["catalog", "--import-token"]);
    if (catalog.includes('"__miniflare_')) {
      throw new Error("the Store's catalog lists a __miniflare_ table");
    }
    const dump = join(dir, "accounts.dump");
    const user = await writeAccounts(app, catalog, kek, dump);
    admin(app, instance, ["import", dump, "--import-token"]);
    admin(app, instance, ["publish", "--yes", "--import-token"]);
    log(`run ${index}: published; warming`);
    const warmed = await warm(instance.base, user.secret, user.id);
    const socket = await streamingSocket(instance.base, user.secret);
    log(`run ${index}: warmed ${JSON.stringify(warmed)}; streaming socket open; inspector session`);
    const cdp = await session(inspector);
    try {
      const version = /** @type {Record<string, string>} */ (
        await (await fetch(`http://127.0.0.1:${inspector}/json/version`)).json().catch(() => ({}))
      );
      const browser = /** @type {{ jsVersion?: string } | null} */ (
        await cdp.call("Browser.getVersion", {}, 5000).catch(() => null)
      );
      await cdp.call("HeapProfiler.enable");
      // V8 answers collectGarbage from a task it posts to the isolate's foreground runner, which workerd does not run
      // while the isolate is idle: the call is recorded as answered or not, and the snapshot, which V8 takes after
      // collecting all available garbage, comes before getHeapUsage, so both read the collected heap.
      const collected = await cdp.call("HeapProfiler.collectGarbage", {}, 10_000).then(
        () => true,
        () => false,
      );
      const snapshot = await cdp.snapshot();
      const usage = await cdp.call("Runtime.getHeapUsage");
      const result = {
        run: index,
        at: new Date().toISOString(),
        workerd,
        v8: browser?.jsVersion ?? version["V8-Version"] ?? null,
        inspector: version,
        warmed,
        collectGarbage: collected ? "answered" : "unanswered",
        ...measure(usage, snapshot),
      };
      appendFileSync(join(out, "runs.jsonl"), `${JSON.stringify(result)}\n`);
      log(
        `run ${index}: sum ${result.sum} (heap ${result.totalSize}, external ${result.backingStorageSize}, cppgc ${result.embedderHeapUsedSize}, native ${result.native})`,
      );
      return result;
    } finally {
      cdp.close();
      socket.close();
    }
  } finally {
    await wrangler?.stop();
    // The directory holds the run's secrets (.dev.vars) and the dump's tokens' hashes.
    rmSync(dir, { recursive: true, force: true });
    active = null;
  }
}

/** The run in progress, stopped and removed on SIGINT, SIGTERM or SIGHUP. @type {{ dir: string, stop: () => Promise<void> } | null} */
let active = null;
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.once(signal, () => {
    const run = active;
    void (run === null ? Promise.resolve() : run.stop()).finally(() => {
      if (run !== null) {
        rmSync(run.dir, { recursive: true, force: true });
      }
      process.exit(130);
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: { runs: { type: "string", default: "3" }, out: { type: "string" } },
  });
  const runs = Number(values.runs);
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error("--runs takes a positive integer");
  }
  const out = resolve(values.out ?? `store-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  const pinned = pinnedWorkerd();
  const packDir = mkdtempSync(join(tmpdir(), "kopje-store-baseline-pack-"));
  try {
    log(`packing the package (pinned workerd ${pinned})`);
    const tarball = pack(packDir);
    const results = [];
    for (let i = 1; i <= runs; i += 1) {
      results.push(await oneRun(tarball, out, i, pinned));
    }
    const largest = Math.max(...results.map((r) => r.sum));
    const summary = { date: new Date().toISOString().slice(0, 10), workerd: pinned, v8: results[0]?.v8, runs, largest };
    writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    log(`STORE_BASELINE_BYTES ${largest} (${out})`);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

await main();
