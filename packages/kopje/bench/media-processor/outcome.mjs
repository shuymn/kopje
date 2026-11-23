// Whether a bench run (worker.ts) succeeded end to end, from what it recorded. `expect` is the fixture's kind from
// measure.sh's table, never the server's answer: the answer's Content-Type must be that kind's (video/mp4 or
// audio/mpeg; image/png for a still) and a normalize's Kopje-Kind that kind, its output must be in R2,
// and for a video both the still (in R2 for a normalize, the output itself for a still) and the two Images
// transforms must have run. A run with an error (a destroy that failed included) is no success. The body itself is not
// checked: a well-labelled answer that is not that media counts as a success here; the output verifier (PR2) is what
// reads it.

/**
 * @typedef {{ op: "normalize" | "still", expect: "video" | "audio", status: number | null, error: string | null,
 *   mediaKind: string | null, contentType: string | null, outputToR2Ms: number | null, stillBytes: number | null, imagesWebpMs: number | null,
 *   imagesRgbaMs: number | null }} Outcome
 */

/** @param {Outcome} r @returns {boolean} */
export function endToEnd(r) {
  if (r.error !== null || r.status !== 200 || r.outputToR2Ms === null) {
    return false;
  }
  if (r.op === "normalize" && r.mediaKind !== r.expect) {
    return false;
  }
  const type = r.op === "still" ? "image/png" : r.expect === "video" ? "video/mp4" : "audio/mpeg";
  if (r.contentType !== type) {
    return false;
  }
  if (r.expect === "audio") {
    return r.op === "normalize";
  }
  return r.stillBytes !== null && r.imagesWebpMs !== null && r.imagesRgbaMs !== null;
}
