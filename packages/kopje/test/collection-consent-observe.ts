// The observation the replay of a spec/collection-consent/ fixture compares after each step: what the real Store must
// show of L's membership in R's collection C at that point, in the specification's abstract names. The fixtures
// (test/fixtures/collection-consent/*.json) are written from the TLA+ specification by `pnpm --filter kopje
// spec:fixtures` and are not edited by hand; CollectionConsent.tla's Observation defines each field.
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

/**
 * A field the specification leaves open at this step (CollectionConsent.tla's Unspecified): a replay does not compare
 * it.
 */
export type Unspecified = "row.listedAs";

/**
 * GET of an authorization: 200 with its body's interactingObject (C) and interactionTarget (L), as abstract names, or
 * 404.
 */
export type AuthorizationGet = { status: 200; collection: "C"; member: "L" } | { status: 404 };

export interface Observation {
  row: Row | null;
  collection: "stored" | "absent";
  /** GET of each authorization issued so far. */
  authorizationGet: Partial<Record<Authorization, AuthorizationGet>>;
  /** An anonymous viewer and a third account see L in C (its items and its count). */
  publicShows: boolean;
  /**
   * L sees its own row among C's items (GET /api/v1/collections/:id), or "refused" while L is suspended: the Store
   * refuses L's credential before it reads the row.
   */
  memberDetail: boolean | "refused";
  /** C is among L's in_collections, its row in any state, or "refused" while L is suspended. */
  inCollections: boolean | "refused";
  /** The step notified L added_to_collection (a new accepted row). */
  notified: boolean;
  /**
   * The inbound activity's final status, "fetch" when the Store answers that it needs the instrument fetched first, or
   * null for a step that is not an inbound activity.
   */
  response: 202 | 503 | "fetch" | null;
  /**
   * The activities this step recorded, in no particular order. L's actor Update, which its suspension and lifting
   * record, is outside the specification and left out.
   */
  recorded: Recorded[];
  /**
   * The activities this step may record besides those: the specification requires none of them and permits each (an
   * embedded listing's answer to an unserved authorization).
   */
  mayAlsoRecord: Recorded[];
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
  /** "answer", "revoke" or "block". */
  reason: string | null;
}

export interface Step {
  /**
   * CollectionConsent.tla's action: K* are Kopje's steps, R* and XAdd R's, Drop the network's, Env the environment's.
   */
  action: string;
  /**
   * value: a step's other input (the request R adds, the environment field changed, ...); a claim's "sameTime" when it
   * is made in the same millisecond as the row's last change; a lifting's "newCredential": L's views after it are read
   * with a credential issued after it, since the suspension's are still refused; a delivery's or a reclaim's "dropped"
   * when the Store's claim drops a suspended L's ordinary activity (by its class: an answer once Kopje holds no row is
   * ordinary) instead of sending it; a failed POST's or a reclaim's "superseded" when the Store drops the leased head
   * because a retraction answer of the same authorization to the same inbox was recorded while it was in flight.
   *
   * activity: for KLeaseHead, KDeliver, KDup, KGiveUp, KFail and KReclaim, the head of Kopje's lane to R's server,
   * which the replay checks is the head before it acts. KLeaseHead claims it, a corrective answer, for its POST;
   * KDeliver, KDup and KGiveUp complete a claimed head, or claim a waiting one and complete it; KFail fails the claimed
   * head's POST transiently; KReclaim lets its lease run out and the sweep reclaim it. With "dropped", the replay checks
   * that the Store sends nothing and the head is gone after it; with "superseded", that the head is gone and the later
   * answer waits; after any other KFail or KDup, that the head waits again; after any other KReclaim, that the head is
   * leased again under a new token and does not wait.
   */
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

/** The real Store's observation: what a replay reads after a step. */
export type Actual = Omit<Observation, "unspecified" | "mayAlsoRecord">;

/**
 * The fields where actual differs from expected, each as "field: expected …, got …"; empty when they agree. The
 * fields expected names as unspecified are skipped, and recorded is compared as a multiset: it holds expected's
 * activities and any of mayAlsoRecord's, each at most once.
 */
export function compareObservation(expected: Observation, actual: Actual): string[] {
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
  compare("memberDetail", expected.memberDetail, actual.memberDetail);
  compare("inCollections", expected.inCollections, actual.inCollections);
  compare("notified", expected.notified, actual.notified);
  compare("response", expected.response, actual.response);
  // Actual's activities, less one copy of each permitted activity it holds beyond those expected requires.
  const required = sortedRecorded(expected.recorded);
  const permitted = new Set(sortedRecorded(expected.mayAlsoRecord));
  const rest = sortedRecorded(actual.recorded);
  const count = (values: string[], value: string) => values.filter((v) => v === value).length;
  for (const m of new Set(rest)) {
    if (permitted.has(m) && count(rest, m) > count(required, m)) rest.splice(rest.indexOf(m), 1);
  }
  compare("recorded", required, rest);
  compare("readRequested", expected.readRequested, actual.readRequested);
  return differences;
}
