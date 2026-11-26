import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { readConfig } from "../src/platform/config";

describe("readConfig", () => {
  // The admin health report and the kopje.config.invalid log show these issues.
  it("names each invalid variable and its problem, never its value", () => {
    const { STORE: _store, ...withoutStore } = env;
    const config = readConfig({
      ...withoutStore,
      MAINTENANCE: "value-7f3a",
      SETUP_TOKEN: "",
      // A secret set as a JSON binding of another type.
      USER_KEK: 123456789,
      USER_KEK_PREVIOUS: { secret: "value-7f3a" },
      IMAGES_MONTHLY_TRANSFORMS: "4321.5",
      // An object Number() cannot convert: it throws, which is the same type issue.
      IMAGES_ACCOUNT_MONTHLY_TRANSFORMS: { toString: null },
      IMAGES_CARD_MONTHLY_TRANSFORMS: "value-7f3a",
      REMOTE_MEDIA_CACHE_BYTES: "-4321",
      MEDIA_CACHE_RETENTION_DAYS: "98765",
      CUTOVER_ROLLBACK: "value-7f3a",
      CUTOVER_JOURNAL_MAX_ENTRIES: "0",
      VAPID_JWK: "value-7f3a",
    });
    expect(config).toEqual({
      ok: false,
      issues: [
        "STORE: binding STORE is missing",
        'MAINTENANCE: Invalid option: expected one of "off"|"readonly"|"full"',
        "SETUP_TOKEN: Too small: expected string to have >=1 characters",
        "USER_KEK: Invalid input: expected string, received number",
        "USER_KEK_PREVIOUS: Invalid input: expected string, received object",
        "IMAGES_MONTHLY_TRANSFORMS: Invalid input: expected int, received number",
        "IMAGES_ACCOUNT_MONTHLY_TRANSFORMS: Invalid input: expected number, received object",
        "IMAGES_CARD_MONTHLY_TRANSFORMS: Invalid input: expected number, received NaN",
        "REMOTE_MEDIA_CACHE_BYTES: Too small: expected number to be >=0",
        "REMOTE_MEDIA_CACHE_BYTES: must be 0 or at least 268435456",
        "MEDIA_CACHE_RETENTION_DAYS: Too big: expected number to be <=36500",
        'CUTOVER_ROLLBACK: Invalid input: expected "journal"',
        "CUTOVER_JOURNAL_MAX_ENTRIES: Too small: expected number to be >=1",
        "VAPID_JWK: must be an EC P-256 private key JWK",
      ],
    });
  });

  // The video and audio upload budget (#1828 design 4.4, P4): a whole number of jobs a UTC month, 0 by default; a
  // budget without the MediaProcessor binding is a valid configuration that activates nothing (health says so).
  it("reads MEDIA_UPLOAD_MONTHLY_JOBS as 0 by default, a budget without the binding as valid, and names a bad one", () => {
    const { MEDIA_PROCESSOR: _processor, ...unbound } = env as Env & { MEDIA_PROCESSOR?: unknown };
    const unset = readConfig(unbound);
    expect(unset.ok && unset.config.MEDIA_UPLOAD_MONTHLY_JOBS).toBe(0);
    const budget = readConfig({ ...unbound, MEDIA_UPLOAD_MONTHLY_JOBS: "25" });
    expect(budget.ok && budget.config.MEDIA_UPLOAD_MONTHLY_JOBS).toBe(25);
    for (const [value, issue] of [
      ["-1", "MEDIA_UPLOAD_MONTHLY_JOBS: Too small: expected number to be >=0"],
      ["2.5", "MEDIA_UPLOAD_MONTHLY_JOBS: Invalid input: expected int, received number"],
    ] as const) {
      expect(readConfig({ ...unbound, MEDIA_UPLOAD_MONTHLY_JOBS: value })).toEqual({ ok: false, issues: [issue] });
    }
  });

  // The remote stills budget (#1828 PR5): the same shape, its own variable.
  it("reads MEDIA_STILL_MONTHLY_JOBS as 0 by default, a budget without the binding as valid, and names a bad one", () => {
    const { MEDIA_PROCESSOR: _processor, ...unbound } = env as Env & { MEDIA_PROCESSOR?: unknown };
    const unset = readConfig(unbound);
    expect(unset.ok && unset.config.MEDIA_STILL_MONTHLY_JOBS).toBe(0);
    const budget = readConfig({ ...unbound, MEDIA_STILL_MONTHLY_JOBS: "200" });
    expect(budget.ok && budget.config.MEDIA_STILL_MONTHLY_JOBS).toBe(200);
    expect(budget.ok && budget.config.MEDIA_UPLOAD_MONTHLY_JOBS).toBe(0);
    for (const [value, issue] of [
      ["-1", "MEDIA_STILL_MONTHLY_JOBS: Too small: expected number to be >=0"],
      ["2.5", "MEDIA_STILL_MONTHLY_JOBS: Invalid input: expected int, received number"],
    ] as const) {
      expect(readConfig({ ...unbound, MEDIA_STILL_MONTHLY_JOBS: value })).toEqual({ ok: false, issues: [issue] });
    }
  });
});
