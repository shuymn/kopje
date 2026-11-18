// The observation the replay of a spec/feature-d/ fixture compares after each step: what the real Store must show of
// L's membership in R's collection C at that point, in the specification's abstract names. The fixtures
// (test/fixtures/feature-d/*.json) are written from the TLA+ specification by `pnpm --filter kopje spec:fixtures`
// and are not edited by hand; FeatureD.tla's Observation defines each field.
//
// Abstract names: R is the remote owner and C its collection; L is the local member; r1, r2 are R's FeatureRequests
// (in order), I1, I2 their items; a1, a2 are the FeatureAuthorizations Kopje issues, in order, and row1, row2 the
// rows that carry them. A replay maps each to the real id it creates.

export type Request = "r1" | "r2";
export type Item = "I1" | "I2";
export type Authorization = "a1" | "a2";

export interface Row {
  name: "row1" | "row2";
  state: "accepted" | "retired";
  authorization: Authorization;
  request: Request;
  /** The owner's item that last listed the row, or null while it is unlisted (hidden from others). */
  listedAs: Item | null;
}

/** An activity the step recorded for delivery. */
export interface Recorded {
  type: "Accept" | "Reject" | "Delete" | "Block" | "DeleteActor";
  /** The request answered, the authorization deleted, "R" for a Block or "L" for L's actor Delete. */
  object: Request | Authorization | "R" | "L";
  /** An Accept's authorization, else null. */
  result: Authorization | null;
  /** R's inbox, or X's (another owner on R's server) for a Delete answering X's Add. */
  to: "R" | "X";
  /** A retraction is never refused at a full delivery backlog; an ordinary activity is (RES-4). */
  class: "ordinary" | "retraction";
  outcome: "queued" | "refused";
}

/** A field the design leaves open at this step (FeatureD.tla's Unspecified): a replay does not compare it. */
export type Unspecified = "recorded" | "row.listedAs";

export interface Observation {
  row: Row | null;
  collection: "stored" | "absent";
  /** The status of GET on each authorization issued so far. */
  authorizationGet: Partial<Record<Authorization, 200 | 404>>;
  /** An anonymous viewer and a third account see L in C (its items and its count). */
  publicShows: boolean;
  /** L sees its own row (C's items, in_collections). */
  memberShows: boolean;
  /** The inbound POST's status, or null for a step that is not an inbound activity. */
  response: 202 | 503 | null;
  /** The activities this step recorded, in no particular order. */
  recorded: Recorded[];
  /** The step requested a read of R's collections. */
  readRequested: boolean;
  unspecified: Unspecified[];
}

/** The environment Kopje decides in during the step. */
export interface Environment {
  consent: boolean;
  slotsFull: boolean;
  /** How many of R's collections Kopje holds besides C: below 10, below 50, or 50. */
  held: "lt10" | "lt50" | "at50";
  backlogFull: boolean;
  retractionCapFull: boolean;
}

/** An envelope R sends Kopje, an instrument snapshot ("Instrument") or the pages a read fetches ("Pages"). */
export interface Envelope {
  type: "FR" | "Add" | "XAdd" | "Rem" | "Upd" | "RemC" | "DelR" | "Instrument" | "Pages";
  request?: Request;
  item?: Item | "IX";
  authorization?: Authorization;
  listing?: { item: Item | null; authorization: Authorization | null; truncated: boolean };
}

/** An activity of Kopje's being delivered, given up or retried. */
export interface Activity {
  type: Recorded["type"];
  object: Recorded["object"];
  result: Authorization | null;
  to: "R" | "X";
  class: Recorded["class"];
  /** "answer", "kept" (a Reject of another request while the row is kept), "revoke" or "block". */
  reason: string | null;
}

export interface Step {
  /** FeatureD.tla's action: K* are Kopje's steps, R* and XAdd R's, Drop the network's, Env the environment's. */
  action: string;
  input: { envelope?: Envelope; activity?: Activity; value?: string };
  environment: Environment;
  observation: Observation;
}

export interface Fixture {
  name: string;
  scenario: string;
  goal: string;
  /** "<test file>::<test name>" of the replay, which names the fixture in its source. */
  replayedBy: string;
  steps: Step[];
}

const RECORDED_KEYS: (keyof Recorded)[] = ["type", "object", "result", "to", "class", "outcome"];
const sortedRecorded = (values: readonly Recorded[]): string[] =>
  values.map((m) => JSON.stringify(RECORDED_KEYS.map((key) => m[key]))).toSorted();
const sortedEntries = (record: object) => Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The fields where actual differs from expected, each as "field: expected …, got …"; empty when they agree. The
 * fields expected names as unspecified are skipped, and recorded is compared as a multiset.
 */
export function compareObservation(expected: Observation, actual: Omit<Observation, "unspecified">): string[] {
  const skip = new Set<string>(expected.unspecified);
  const differences: string[] = [];
  const compare = (field: string, want: unknown, got: unknown) => {
    if (skip.has(field)) return;
    const w = JSON.stringify(want);
    const g = JSON.stringify(got);
    if (w !== g) differences.push(`${field}: expected ${w}, got ${g}`);
  };
  if (expected.row === null || actual.row === null) compare("row", expected.row, actual.row);
  else
    for (const key of Object.keys(expected.row) as (keyof Row)[])
      compare(`row.${key}`, expected.row[key], actual.row[key]);
  compare("collection", expected.collection, actual.collection);
  compare("authorizationGet", sortedEntries(expected.authorizationGet), sortedEntries(actual.authorizationGet));
  compare("publicShows", expected.publicShows, actual.publicShows);
  compare("memberShows", expected.memberShows, actual.memberShows);
  compare("response", expected.response, actual.response);
  compare("recorded", sortedRecorded(expected.recorded), sortedRecorded(actual.recorded));
  compare("readRequested", expected.readRequested, actual.readRequested);
  return differences;
}
