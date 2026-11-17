import { type DeliveryOutcome, LEASE_MS } from "../domain/deliveries";
import type { FailureStage } from "../domain/delivery-hosts";
import { errorFields } from "../platform/error-message";
import {
  assertPublicShape,
  type HostResolution,
  type RequestSigner,
  resolveDeliveryHost,
  RETRY_STATUSES,
} from "./loader";

// The delivery sink (NET-2, NET-3): one signed POST of one activity to one inbox.
//   - The inbox passes NET-1's host rules (https, no credentials, no literal IP or local name, public addresses by
//     DNS: resolveDeliveryHost) before every POST, since a stored inbox URL may resolve elsewhere by now.
//   - Redirects are never followed: a 3xx is a failure and retried. Following one would send a non-public body, and
//     its signature, to a target nobody checked (Fedify and Mastodon follow them; Kopje does not).
//   - The body is the stored activity, as application/activity+json (what Mastodon and Fedify send), signed by its
//     lane account's key (its author's, or a forwarding booster's, whose body goes as received) with draft-cavage HTTP
//     Signatures and a Digest (Fedify's signRequest via the keyring). A POST answered 400 or 401 (RETRY_STATUSES) is
//     sent once more at once, signed with RFC 9421 by the same key (PostTarget.retry), as Mastodon 4.7's
//     Request#perform does; the deadline, the host check and the target's own check (the Store's confirmation, for a
//     delivery) run again before it, and the first answer's body is cancelled unread. Fedify's own sending path
//     (sendActivity, its queue, doubleKnock) is not used: it follows redirects and owns retries and keys (the
//     kopje/fedify-usage lint rule).
//   - The whole path from the claim (key loading, DNS, signing, both POSTs, responses) is budgeted: it ends after
//     DELIVERY_TIMEOUT_MS or at the round's deadline inside the lease, whichever is first, and sends nothing after; a
//     retry it leaves no time for is a transient failure, never the first answer's.
//   - The last answer is classified as Mastodon's DeliveryWorker does: 2xx delivered; 401, 408, 429, other 4xx is
//     permanent except those three, 501 permanent, any other status or a network error retried. Fedify stops only on
//     404 and 410; Mastodon's wider rule spares servers that refuse an activity for good.
//   - A failure records the stage it stopped in (FailureStage: the host check's result, the key, the signature, the
//     POST, the budget, and whether a timeout ran the whole budget), which the Store judges to count it toward the
//     host or not (domain/delivery-hosts.ts hostCaused).
export const DELIVERY_TIMEOUT_MS = 30_000;
export const ACTIVITY_CONTENT_TYPE = "application/activity+json";
// Room left in the lease after the POST's deadline, for the completion to reach the Store.
export const COMPLETION_MARGIN_MS = 10_000;

if (DELIVERY_TIMEOUT_MS >= LEASE_MS) {
  throw new Error("a delivery must time out before its lease ends");
}

export type PostDeps = {
  fetch: typeof fetch;
  // The host check (default resolveDeliveryHost); only `public` lets the POST go.
  resolveHost?: ((url: URL) => Promise<HostResolution>) | undefined;
  userAgent: string;
  timeoutMs?: number | undefined;
  now: () => number;
};

// One delivery: the stored inbox and body, the author's signer (loaded lazily, inside the budget), and the time by
// which the POST must have been sent, which leaves the completion room inside the lease. retry, when given, is the
// signer of the one more POST of an answer in RETRY_STATUSES, loaded right before it: null sends nothing more and
// keeps the first answer. Without it (Web Push), every POST is sent once.
export type PostTarget = {
  inbox: string;
  body: string;
  signer: () => Promise<RequestSigner | null>;
  retry?: (() => Promise<RequestSigner | null>) | undefined;
  deadline: number;
};

const SALVAGEABLE_4XX = new Set([401, 408, 429]);

export function classifyStatus(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) {
    return { kind: "delivered", status };
  }
  if (status >= 300 && status < 400) {
    return { kind: "failed", status, error: `redirect not followed (HTTP ${status})`, permanent: false };
  }
  const permanent = status === 501 || (status >= 400 && status < 500 && !SALVAGEABLE_4XX.has(status));
  return { kind: "failed", status, error: `HTTP ${status}`, permanent };
}

class Timeout extends Error {}

const exhausted: DeliveryOutcome = {
  kind: "failed",
  status: null,
  error: "lease budget exhausted",
  permanent: false,
  failure: { stage: "budget" },
};
const unavailable: DeliveryOutcome = {
  kind: "failed",
  status: null,
  error: "signing key unavailable",
  permanent: false,
  failure: { stage: "key" },
};

// An answer as classifyStatus reads it, a failure marked as the POST's.
function answered(status: number): DeliveryOutcome {
  const outcome = classifyStatus(status);
  return outcome.kind === "failed" ? { ...outcome, failure: { stage: "post" } } : outcome;
}

// The whole path (DNS check, key loading, signing, each POST and its status) runs under one budget: the smaller of the
// POST timeout and the time left before the deadline. Nothing is sent once the budget is spent, even if a slow step
// finishes later, so a POST never leaves after its lease could have been claimed again (NET-2, RES-6).
export async function postActivity(deps: PostDeps, target: PostTarget): Promise<DeliveryOutcome> {
  let url: URL;
  try {
    url = new URL(target.inbox);
    assertPublicShape(url);
  } catch {
    // Never becomes deliverable: the stored URL itself is refused.
    return { kind: "failed", status: null, error: "refused inbox URL", permanent: true };
  }
  // One absolute deadline: the earlier of the POST timeout and the lease margin. The timer aborts at it, and the
  // clock is checked against it after the key is loaded and right before the POST, in case the timer runs late.
  const started = deps.now();
  const deadline = Math.min(started + (deps.timeoutMs ?? DELIVERY_TIMEOUT_MS), target.deadline);
  const budget = deadline - started;
  if (budget <= 0) {
    return exhausted;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Timeout()), budget);
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), { once: true });
  });
  const live = () => !controller.signal.aborted && deps.now() < deadline;
  // The stage the path is in, which a timeout or a thrown error is recorded with.
  let stage: FailureStage["stage"] = "resolve";
  // One POST: the host check (NET-3, before every POST), the signer, then the request, the clock checked after the
  // signer is loaded and right before the POST. Its status, or the outcome that ended it before anything was sent
  // (`unsigned` when the signer is null).
  const post = async (
    signer: () => Promise<RequestSigner | null>,
    unsigned: DeliveryOutcome,
  ): Promise<number | DeliveryOutcome> => {
    stage = "resolve";
    const resolution = await (deps.resolveHost ?? resolveDeliveryHost)(url);
    if (resolution.kind !== "public") {
      // DNS may fail for a while; retried like any transient failure until the attempts run out.
      return {
        kind: "failed",
        status: null,
        error: "refused or unresolved host",
        permanent: false,
        failure: {
          stage: "resolve",
          resolution: resolution.kind,
          code: resolution.kind === "error" ? resolution.code : null,
        },
      };
    }
    stage = "key";
    const sign = live() ? await signer() : null;
    if (!live()) {
      return exhausted;
    }
    if (sign === null) {
      return unsigned;
    }
    stage = "sign";
    const request = await sign(
      new Request(url, {
        method: "POST",
        headers: { "content-type": ACTIVITY_CONTENT_TYPE, accept: ACTIVITY_CONTENT_TYPE, "user-agent": deps.userAgent },
        body: target.body,
        redirect: "manual",
        signal: controller.signal,
      }),
    );
    if (!live()) {
      return exhausted;
    }
    stage = "post";
    const response = await deps.fetch(request);
    // Only the status matters; the body is not read.
    await response.body?.cancel().catch(() => {});
    return response.status;
  };
  const sending = (async (): Promise<DeliveryOutcome> => {
    const first = await post(target.signer, unavailable);
    if (typeof first !== "number") {
      return first;
    }
    const answer = answered(first);
    if (target.retry === undefined || !RETRY_STATUSES.has(first)) {
      return answer;
    }
    const second = await post(target.retry, answer);
    return typeof second === "number" ? answered(second) : second;
  })();
  sending.catch(() => {});
  try {
    return await Promise.race([sending, aborted]);
  } catch (error) {
    if (error instanceof Timeout) {
      const whole = budget >= (deps.timeoutMs ?? DELIVERY_TIMEOUT_MS);
      return {
        kind: "failed",
        status: null,
        error: `timed out after ${budget} ms`,
        permanent: false,
        failure: { stage, timeout: whole ? "whole" : "cut" },
      };
    }
    // DATA-5: the error class only; a message may carry the URL. In the POST it is the fetch's network error; earlier,
    // the signer's or the signature's.
    return {
      kind: "failed",
      status: null,
      error: `network error (${errorFields(error).error})`,
      permanent: false,
      failure: { stage },
    };
  } finally {
    clearTimeout(timer);
  }
}

// The Queue message that rings the delivery doorbell. It carries nothing: the Store's deliveries are the work.
export type DeliverMessage = { kind: "deliver" };

// Queues allow at most 12 hours of delay, which is also the longest retry wait.
export const MAX_DOORBELL_DELAY_SECONDS = 12 * 60 * 60;

export async function ringDoorbell(queue: Queue, delaySeconds = 0): Promise<void> {
  const delay = Math.max(0, Math.min(Math.ceil(delaySeconds), MAX_DOORBELL_DELAY_SECONDS));
  const message: DeliverMessage = { kind: "deliver" };
  await queue.send(message, delay === 0 ? {} : { delaySeconds: delay });
}

export function isDeliverMessage(body: unknown): body is DeliverMessage {
  return typeof body === "object" && body !== null && (body as { kind?: unknown }).kind === "deliver";
}
