// The media processor's outputs for the workerd suites, which cannot read files. AV_FIXTURES (vitest.config.ts): the
// committed ones (test/fixtures/av/, made by scripts/av-fixtures.sh), GET /manifest.json the manifest and GET /<name>
// a file it names. AV_FRESH (vitest.av-fresh.config.ts): the fresh ones scripts/container-smoke.sh lists at
// $AV_FRESH_LIST, GET /list.json the list and GET /<file> a file it names, from the list's directory.

import { createReadStream, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

const DIR = new URL("../test/fixtures/av/", import.meta.url);

export type AvFixture = { name: string; input: string; kind: "video" | "audio"; bytes: number; sha256: string };

export function avManifest(): AvFixture[] {
  return JSON.parse(readFileSync(new URL("manifest.json", DIR), "utf8")) as AvFixture[];
}

export function avFixtures(req: IncomingMessage, res: ServerResponse): void {
  const name = new URL(req.url ?? "/", "http://fixtures.invalid").pathname.slice(1);
  if (name !== "manifest.json" && !avManifest().some((f) => f.name === name)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(readFileSync(new URL(name, DIR)));
}

type AvFreshEntry = { file: string; type: "video/mp4" | "audio/mpeg" | "image/png"; expectedDuration?: number };

export function avFresh(req: IncomingMessage, res: ServerResponse): void {
  const list = process.env.AV_FRESH_LIST ?? "";
  const name = decodeURIComponent(new URL(req.url ?? "/", "http://fresh.invalid").pathname.slice(1));
  const entries = list === "" ? [] : (JSON.parse(readFileSync(list, "utf8")) as AvFreshEntry[]);
  if (name === "list.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(entries));
    return;
  }
  if (!entries.some((e) => e.file === name)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const path = join(dirname(list), name);
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(path).size });
  createReadStream(path).pipe(res);
}
