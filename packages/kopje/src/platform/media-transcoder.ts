// The media processor's seam (#1828), types only: what the layers below the top level may know of it. The container
// Durable Object and its client are src/media-processor.ts, the image is container/.

// An execution profile: an operation on an instance type. normalize runs on NORMALIZE_INSTANCES until the measurement
// of P27 (design #1828, section 5, F3) picks one; still runs on standard-1.
export const PROBE_PROFILES = ["normalize@standard-3", "normalize@standard-4", "still@standard-1"] as const;
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

// The processor as the app layer reaches it, through the binding the instance template's optional block adds.
export type MediaProcessorClient = {
  probeNow(profile: ProbeProfile): Promise<ProbeReport>;
};
