import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROBE_FIXTURE_BASE64 } from "../src/media-probe-fixture.js";

// The media processor's image as the kopje package ships it (design #1828, P3): an instance builds container/Dockerfile
// from node_modules/kopje/container, so the packed artifact carries the Dockerfile, the server's sources and the probe
// fixture, and every base is pinned by digest.
const pkg = fileURLToPath(new URL("..", import.meta.url));
const container = new URL("../container/", import.meta.url);

// The files `pnpm pack` puts in the tarball, as the release packs it (without building dist/ again).
function packedFiles(): string[] {
  const out = execFileSync("pnpm", ["pack", "--dry-run", "--json", "--config.ignore-scripts=true"], {
    cwd: pkg,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const packed = JSON.parse(out) as { files: { path: string }[] };
  return packed.files.map((file) => file.path);
}

describe("the media processor's image in the kopje package", () => {
  it("packs the Dockerfile, the server's sources and the probe fixture, and no test", () => {
    const files = packedFiles();
    const sources = readdirSync(new URL("server/", container)).filter((name) => /\.go$|^go\.mod$/.test(name));
    const shipped = sources.filter((name) => !name.endsWith("_test.go")).map((name) => `container/server/${name}`);
    expect(sources.some((name) => name.endsWith("_test.go"))).toBe(true);
    expect(files.filter((file) => file.startsWith("container/")).toSorted()).toEqual(
      ["container/Dockerfile", "container/probe.mp4", ...shipped].toSorted(),
    );
    expect(shipped).toContain("container/server/main.go");
    expect(shipped).toContain("container/server/go.mod");
  });

  // The template's block builds this directory of the installed package.
  it("is where the instance template's block points", () => {
    const template = readFileSync(new URL("../../../deploy/wrangler.jsonc", import.meta.url), "utf8");
    const paths = [...template.matchAll(/"(dockerfile|build_context)": "\.\/node_modules\/kopje\/([^"]+)"/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(paths).toEqual([
      ["dockerfile", "container/Dockerfile"],
      ["build_context", "container"],
    ]);
    expect(packedFiles()).toContain("container/Dockerfile");
  });

  it("pins the frontend and every base image by digest and copies only the server into the build", () => {
    const dockerfile = readFileSync(new URL("Dockerfile", container), "utf8");
    // The frontend that parses the file too.
    expect(dockerfile.split("\n")[0]).toMatch(/^# syntax=docker\/dockerfile:[\d.]+@sha256:[0-9a-f]{64}$/);
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from).toHaveLength(3);
    for (const line of from) {
      expect(line).toMatch(/^FROM (--platform=\$BUILDPLATFORM )?[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}( AS \w+)?$/);
    }
    const copies = dockerfile.split("\n").filter((line) => line.startsWith("COPY ") && !line.startsWith("COPY --from"));
    expect(copies).toEqual(["COPY server/ ./"]);
    expect(dockerfile).toMatch(/^USER nonroot:nonroot$/m);
  });

  // The Worker's copy of the fixture (src/media-probe-fixture.ts) is the packaged file, which carries metadata the
  // processor must remove.
  it("embeds the packaged probe fixture in the Worker", () => {
    const file = readFileSync(new URL("probe.mp4", container));
    expect(Buffer.from(PROBE_FIXTURE_BASE64, "base64").equals(file)).toBe(true);
    expect(file.includes("KOPJEMARK_TITLE")).toBe(true);
    expect(file.subarray(4, 8).toString("latin1")).toBe("ftyp");
  });
});
