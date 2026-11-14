import { describe, expect, it } from "vitest";

// statusReads' `hoisted` row (src/domain/audience.ts) is the derived table `hp`, whose columns the rule's fragments
// read as hp.author, hp.author_covered and hp.original_covered: no fragment of the statement may name a table, a
// subquery or a CTE `hp` of its own, which would capture those references. The statement is composed here as
// homeStatus (src/domain/timelines.ts), the read that hoists, issues it, and every `hp` in its text is either the
// derived table's one alias or a reference to one of its columns.

type Issued = { exec: (query: string) => { toArray: () => never[]; rowsWritten: number } };
// The Store's modules, loaded by a computed specifier: they are typed against the Workers runtime, which this suite's
// TypeScript project does not include.
const load = async <T>(path: string) => (await import(new URL(path, import.meta.url).href)) as T;
const { Db } = await load<{ Db: new (sql: Issued) => unknown }>("../src/db/sql.ts");
const { contextOf } = await load<{ contextOf: (id: string, now: number) => unknown }>("../src/domain/auth.ts");
const { homeStatus } = await load<{ homeStatus: (db: unknown, viewer: unknown, id: string) => unknown }>(
  "../src/domain/timelines.ts",
);

// The statements homeStatus issues for one status, over a Store that answers no rows.
function issued(): string[] {
  const texts: string[] = [];
  const sql: Issued = {
    exec: (query) => {
      texts.push(query.replace(/\s+/g, " "));
      return { toArray: () => [], rowsWritten: 0 };
    },
  };
  homeStatus(
    new Db(sql),
    contextOf("600000000000000001", Date.parse("2026-10-12T00:00:00.000Z")),
    "800000000000000001",
  );
  return texts;
}

describe("the hoisted row's alias", () => {
  it("is named by no fragment of the statement that reads it", () => {
    const hoisting = issued().filter((text) => /\bhp\.author\b/.test(text));
    expect(hoisting).toHaveLength(1);
    const [text] = hoisting as [string];
    const uses = [...text.matchAll(/\bhp\b(\.\w+)?/g)].map(([, column]) => column ?? "alias");
    expect(uses.filter((use) => use === "alias")).toHaveLength(1);
    expect(text).toContain(") hp WHERE hp.id IN (");
    expect(new Set(uses)).toEqual(new Set(["alias", ".id", ".author", ".author_covered", ".original_covered"]));
  });
});
