import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// /api/v1/instance and /api/v2/instance advertise the pixel limit the upload path enforces (IMAGE_MATRIX_LIMIT,
// src/platform/images.ts), read from the constant rather than restated: test/instance.test.ts pins the value, this the
// source of it.

const SOURCE = readFileSync(new URL("../src/mastodon/instance.ts", import.meta.url), "utf8");

describe("image_matrix_limit", () => {
  it("is read from IMAGE_MATRIX_LIMIT, with no number restated", () => {
    expect(SOURCE).toMatch(/^import \{ IMAGE_MATRIX_LIMIT \} from "\.\.\/platform\/images";$/m);
    expect(SOURCE.match(/\bimage_matrix_limit\b.*$/gm)).toEqual(["image_matrix_limit: IMAGE_MATRIX_LIMIT,"]);
  });
});
