// The media processor's seam (#1828), types only: what the layers below the top level may know of it. The container
// Durable Object and its client are src/media-processor.ts, the image is container/.

// An execution profile: an operation on an instance type. normalize runs on NORMALIZE_INSTANCE, the type the P27
// measurement chose (design #1828, section 5, F3; the results are on #1828): standard-3 and standard-4 were measured
// with ffmpeg's default threading and with 4 filter or all threads, and standard-4 with all threads at 4
// (container/server/args.go threadsDefault) is the choice. still runs on standard-1.
const NORMALIZE_INSTANCE = "standard-4";
export const PROBE_PROFILES = [`normalize@${NORMALIZE_INSTANCE}`, "still@standard-1"] as const;
export type ProbeProfile = (typeof PROBE_PROFILES)[number];

export function isProbeProfile(value: unknown): value is ProbeProfile {
  return (PROBE_PROFILES as readonly unknown[]).includes(value);
}

// What a smoke probe saw: the container started on the profile's instance type, answered /healthz, and ran its
// operation on the packaged fixture (container/probe.mp4) streamed as the request body. No verifier runs on the output
// yet: `ok` means a 200 of the expected type within the output limit and its declared length. Times are milliseconds
// of the Durable Object's clock; the stage times are the server's (its Kopje-*-Ms headers).
export type ProbeReport = {
  ok: boolean;
  profile: ProbeProfile;
  // Why it failed: a stage of the probe, or the server's error code.
  failure: string | null;
  // What ctx.container reports of the image: the configured reference and the running container's.
  image: { configured: string | null; running: string | null };
  startToReadyMs: number | null;
  operationMs: number | null;
  wallMs: number;
  stages: Record<string, number>;
  outputBytes: number | null;
  stillBytes: number | null;
  // destroy() returned and the container no longer runs.
  destroyed: boolean;
};

// ---- normalize (design 4.2, 4.3; #1828 PR4 plan, section 3 "PR4-2")

// What the container is given for one upload: its one input, streamed with its length, and the work deadline in
// milliseconds from the request (container/server/main.go), by which its response starts, of which it holds stillMs for
// a video's still.
export type NormalizeJob = {
  input: { body: ReadableStream<Uint8Array>; size: number };
  workMs: number;
  stillMs: number;
  signal?: AbortSignal;
};

// The container's refusals of the input itself: the plan's 422 codes (container/server/plan.go), envelope apart, and
// 413 too_large.
export const NORMALIZE_REFUSALS = [
  "unreadable",
  "format",
  "no_stream",
  "no_video",
  "pixels",
  "fps",
  "frames",
  "duration",
  "unbounded",
  "truncated",
  "too_large",
] as const;
// A5 of #1828 PR2: a 500 with one of these JSON codes is a processing outcome of that input (it could not be
// processed), not an infrastructure failure: the job fails `refused`, and nothing is recorded against the processor.
export const NORMALIZE_INPUT_FAILURES = [
  "encode_failed",
  "strip_failed",
  "still_failed",
  "no_output",
  "output_size",
] as const;

export type NormalizeResult =
  // The output, unread: `file` streams `length` bytes of `type`, which the caller verifies with `duration` (seconds,
  // the container's Kopje-Duration-Ms read by plannedDuration) as expectedDuration. still() answers a video's PNG,
  // read within STILL_OUTPUT_LIMIT and its declared length (not yet checked: the caller runs verifyStill and Images),
  // or null when the container made none (and always for audio).
  | {
      ok: true;
      kind: "video" | "audio";
      type: "video/mp4" | "audio/mpeg";
      file: ReadableStream<Uint8Array>;
      length: number;
      duration: number;
      still: () => Promise<Uint8Array | null>;
      stages: Record<string, number>;
    }
  // The input's outcome: refused (a refusal code, or an A5 failure), outside the envelope, or a stage past its cut.
  | { ok: false; outcome: "refused" | "envelope" | "timeout"; code: string; stages: Record<string, number> };

// No answer, a failed connection, or an answer outside the /normalize contract (a status or code it does not give, a
// 200 without its kind, length or declared duration): the processor is unavailable, whatever the input. `reason` is a
// code, never a body.
export class TranscoderUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`media processor unavailable: ${reason}`);
    this.name = "TranscoderUnavailable";
  }
}

// The processor as the app layer reaches it, through the binding the instance template's optional block adds.
export type MediaProcessorClient = {
  probeNow(profile: ProbeProfile): Promise<ProbeReport>;
  readonly stills: StillMaker;
};

// A still the container made, as the Durable Object answers it: the PNG read within STILL_OUTPUT_LIMIT and its declared
// length (not yet checked: the caller runs verifyStill and Images), the image the container reported, or the stage
// that failed. `busy`: the object already runs an operation (a probe object's single owner, design 4.5). `pending`: the
// container's destroy has not finished, so the caller keeps its lease until the object's alarm has cleaned up.
// The container's refusals of a still's input itself (container/server: the plan's refusals /still answers with 422,
// no_frame when ffmpeg read the input and wrote no frame at the seek nor at 0, and 413 for an input past its limit).
// The server answers unreadable only when ffprobe ran and exited with a status, no_frame only when ffmpeg succeeded and
// its output is absent or empty, and 500 internal when ffprobe or ffmpeg did not start, was killed, or the output could
// not be read back. Only these are about the input; every other failure of a still is the processor's or the platform's,
// and says nothing of the row.
export const STILL_INPUT_REFUSALS = [
  "unreadable",
  "format",
  "no_stream",
  "no_video",
  "pixels",
  "no_frame",
  "too_large",
] as const;
export type StillInputRefusal = (typeof STILL_INPUT_REFUSALS)[number];

export type StillOutcome =
  | { ok: true; png: Uint8Array; image: string | null }
  | { ok: false; failure: string; image: string | null; pending?: true; input?: StillInputRefusal };

// What the media rebuild uses of the processor (design 4.16): a still of an original, and the `still@standard-1`
// probe. Each runs on standard-1 in the caller's invocation, reads its one input key from the media bucket once and
// streams it as the request body (design 4.6), and destroys the container before it answers. `ms` bounds the call from
// its start on the object's clock. The app wiring passes it over the MEDIA_PROCESSOR binding; tests pass a fake.
export type StillMaker = {
  // On a fresh object (rb:<nonce>), input originals/<id>.
  still(key: string, ms: number): Promise<StillOutcome>;
  // On the profile's probe object (p:<version>:still@standard-1), input the copy of `probeInput` the rebuild wrote.
  probe(key: string, ms: number): Promise<StillOutcome>;
  // The packaged probe clip (container/probe.mp4).
  readonly probeInput: Uint8Array;
};
