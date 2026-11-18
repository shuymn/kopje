// Writes the replay fixtures of spec/feature-d/ to test/fixtures/feature-d/<name>.json: for each goal of checks.json
// marked fixture, tla-ts's shortest witness under FeatureDFixtures.tla's ALIAS, one step per state. The projection
// only renames: the spec's NONE ("-") becomes null and is left out of a step's input, a response of 0 (no inbound
// activity) becomes null, an empty function {} and an activity's class its long name. test-node/feature-d-spec.test.ts
// checks that the files equal a fresh run, so a change of the spec that changes a witness needs this run.
//
//   pnpm --filter kopje spec:fixtures
//
// It refuses to write while the directory holds a fixture no goal produces (delete it by hand).
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { check } from "tla-ts";

import { goalConfig, readModule, readPlan } from "../scripts/feature-d-plan.mjs";
import type { Plan } from "../scripts/feature-d-plan.mjs";
import type {
  Activity,
  Authorization,
  Envelope,
  Environment,
  Fixture,
  Item,
  Observation,
  Recorded,
  Request,
  Row,
  Step,
} from "../test/feature-d-observe.js";

export const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/feature-d/", import.meta.url));
/** The workerd test that replays each fixture against the real Store, relative to packages/kopje. */
export const REPLAY_FILE = "test/feature-d-replay.test.ts";

const CLASS = { ord: "ordinary", ret: "retraction" } as const;

// FeatureDFixtures.tla's Alias, after none() has turned the spec's NONE into null.
type Nullable<T> = { [K in keyof T]: T[K] | null };
interface RawEnvelope {
  ty: Envelope["type"] | null;
  r: Request | null;
  i: Item | "IX" | null;
  a: Authorization | null;
  l: { i: Item | null; a: Authorization | null; tr: boolean };
}
interface RawIntent {
  ty: Activity["type"] | null;
  obj: Activity["object"] | null;
  res: Authorization | null;
  to: Activity["to"] | null;
  cls: keyof typeof CLASS | null;
  why: string | null;
}
interface RawObservation extends Omit<Observation, "row" | "authorizationGet" | "response" | "recorded"> {
  row: Row | Nullable<Row>;
  authorizationGet: Observation["authorizationGet"] | [];
  response: Observation["response"] | 0;
  recorded: (Omit<Recorded, "class"> & { class: keyof typeof CLASS })[];
}
interface RawStep {
  action: string;
  input: { env: RawEnvelope; msg: RawIntent; val: string | null };
  environment: Environment;
  observation: RawObservation;
}

const none = (value: unknown): unknown => {
  if (value === "-") return null;
  if (Array.isArray(value)) return value.map(none);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, none(inner)]));
  }
  return value;
};

/** The record without its null and undefined fields. */
const defined = <T extends object>(record: Record<string, unknown>): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined)) as T;

function envelope(raw: RawEnvelope): Envelope | undefined {
  if (raw.ty === null) return undefined;
  const listed = raw.l.i !== null || raw.l.tr;
  return defined<Envelope>({
    type: raw.ty,
    request: raw.r,
    item: raw.i,
    authorization: raw.a,
    listing: listed ? { item: raw.l.i, authorization: raw.l.a, truncated: raw.l.tr } : undefined,
  });
}

function activity(raw: RawIntent): Activity | undefined {
  const { ty, obj, res, to, cls, why } = raw;
  if (ty === null || obj === null || to === null || cls === null) return undefined;
  return { type: ty, object: obj, result: res, to, class: CLASS[cls], reason: why };
}

function observation(raw: RawObservation): Observation {
  return {
    row: raw.row.name === null ? null : (raw.row as Row),
    collection: raw.collection,
    // ToJson writes the empty function (no authorization issued yet) as an empty sequence.
    authorizationGet: Array.isArray(raw.authorizationGet) ? {} : raw.authorizationGet,
    publicShows: raw.publicShows,
    memberShows: raw.memberShows,
    response: raw.response === 0 ? null : raw.response,
    recorded: raw.recorded.map((m): Recorded => ({
      type: m.type,
      object: m.object,
      result: m.result,
      to: m.to,
      class: CLASS[m.class],
      outcome: m.outcome,
    })),
    readRequested: raw.readRequested,
    unspecified: raw.unspecified,
  };
}

function step(json: string): Step {
  const raw = none(JSON.parse(json)) as RawStep;
  return {
    action: raw.action,
    input: defined<Step["input"]>({
      envelope: envelope(raw.input.env),
      activity: activity(raw.input.msg),
      value: raw.input.val,
    }),
    environment: raw.environment,
    observation: observation(raw.observation),
  };
}

/** Every fixture of the plan, from a fresh run of tla-ts. */
export async function generateFixtures(plan: Plan): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  for (const goal of plan.goals.filter((g) => g.fixture)) {
    const result = await check({
      source: readModule("FeatureDFixtures") ?? "",
      config: goalConfig(goal, true),
      loadModule: readModule,
    });
    if (result.violation?.name !== "NotReached") {
      throw new Error(`${goal.name}: goal ${goal.goal} not reached in ${goal.scenario} (${result.status})`);
    }
    fixtures.push({
      name: goal.name,
      scenario: goal.scenario,
      goal: goal.goal,
      replayedBy: `${REPLAY_FILE}::${goal.name}`,
      steps: result.violation.trace.map((s) => {
        const { json } = s.state;
        if (typeof json !== "string") throw new Error(`${goal.name}: a trace state without the fixture alias`);
        return step(json);
      }),
    });
  }
  return fixtures;
}

// An array of strings on several lines, which oxfmt prints on one.
const STRING_ARRAY = /\[\n\s+("[^"\n]*"(?:,\n\s+"[^"\n]*")*)\n\s+\]/g;

/** The fixture as written: two-space JSON as oxfmt prints it, with a final newline. */
export const fixtureText = (fixture: Fixture): string =>
  `${JSON.stringify(fixture, null, 2).replace(STRING_ARRAY, (_, items: string) => `[${items.split(/,\n\s+/).join(", ")}]`)}\n`;

async function main() {
  const fixtures = await generateFixtures(readPlan());
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const names = new Set(fixtures.map((f) => `${f.name}.json`));
  const stale = readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json") && !names.has(file));
  if (stale.length > 0) throw new Error(`no goal produces ${stale.join(", ")} in ${FIXTURE_DIR}`);
  for (const fixture of fixtures) writeFileSync(`${FIXTURE_DIR}${fixture.name}.json`, fixtureText(fixture));
  console.log(`wrote ${fixtures.length} fixtures to ${FIXTURE_DIR}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
