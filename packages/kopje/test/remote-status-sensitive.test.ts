import { describe, expect, it } from "vitest";

import { parseRemoteStatus } from "../src/federation/remote-status";
import { railsBoolean } from "../src/platform/rails-boolean";
import { sql } from "./api-helpers";
import { mastodonActor } from "./inbox-helpers";
import {
  announce,
  AS,
  create,
  followed,
  localStatus,
  mastodonNote,
  setup,
  statusRow,
  statuses,
  update,
} from "./inbox-status-helpers";

// A remote status's `sensitive` as Mastodon 4.7.5 assigns `@status_parser.sensitive || false` to its boolean column
// (create.rb:115, process_status_update_service.rb:184): ActiveModel::Type::Boolean's cast (activemodel 8.1.3.1,
// boolean.rb), whose results below were read from Ruby 4.0.9 and activemodel 8.1.3.1 in Mastodon's v4.7.5 image.

const NOT_SENSITIVE: [string, unknown][] = [
  ["false", false],
  ["0", 0],
  ['"0"', "0"],
  ['"f"', "f"],
  ['"F"', "F"],
  ['"false"', "false"],
  ['"FALSE"', "FALSE"],
  ['"off"', "off"],
  ['"OFF"', "OFF"],
];

const SENSITIVE: [string, unknown][] = [
  ["true", true],
  ["1", 1],
  ["-1", -1],
  ["0.5", 0.5],
  ['"true"', "true"],
  ['"yes"', "yes"],
  ['"False"', "False"],
  ['"Off"', "Off"],
  ['"no"', "no"],
  ['" "', " "],
  ["[]", []],
  ["[false]", [false]],
  ["[null]", [null]],
  ["[true]", [true]],
  ["{}", {}],
  ["an IRI", "https://mastodon.example/sensitive"],
];

const note = (extra: Record<string, unknown>) => ({
  id: "https://mastodon.example/users/bob/statuses/1",
  type: "Note",
  attributedTo: "https://mastodon.example/users/bob",
  content: "<p>hi</p>",
  to: ["https://www.w3.org/ns/activitystreams#Public"],
  ...extra,
});

describe("railsBoolean", () => {
  it.each(NOT_SENSITIVE)("casts %s to false", (_, value) => {
    expect(railsBoolean(value)).toBe(false);
  });

  it.each(SENSITIVE)("casts %s to true", (_, value) => {
    expect(railsBoolean(value)).toBe(true);
  });

  it('casts nil and "" to nil', () => {
    expect(railsBoolean(null)).toBeNull();
    expect(railsBoolean(undefined)).toBeNull();
    expect(railsBoolean("")).toBeNull();
  });
});

describe("a remote status's sensitive", () => {
  it.each([["absent", undefined], ["null", null], ...NOT_SENSITIVE])("%s is not sensitive", (_, value) => {
    const object = value === undefined ? note({}) : note({ sensitive: value });
    expect(parseRemoteStatus(object)?.sensitive).toBe(false);
  });

  it.each(SENSITIVE)("%s is sensitive", (_, value) => {
    expect(parseRemoteStatus(note({ sensitive: value }))?.sensitive).toBe(true);
  });

  it('reads "" as nil, which the Store refuses wherever Mastodon assigns it', () => {
    expect(parseRemoteStatus(note({ sensitive: "" }))?.sensitive).toBeNull();
  });

  it('stores no status from a Create whose sensitive is "", and stores one of "x" and [false] sensitive', async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const blank = mastodonNote(bob, { sensitive: "" });
    expect(await t.post(bob, create(bob, blank))).toBe(202);
    expect(await statusRow(t.store, blank.id)).toBeUndefined();
    // An Update of a status Kopje does not hold creates a recent one (as Mastodon's does), but not this one.
    expect(await t.post(bob, update(bob, blank, "2026-10-11T13:00:00Z"))).toBe(202);
    expect(await statuses(t.store)).toEqual([]);

    const marked = mastodonNote(bob, { sensitive: "x" });
    const listed = mastodonNote(bob, { sensitive: [false] });
    expect(await t.post(bob, create(bob, marked))).toBe(202);
    expect(await t.post(bob, create(bob, listed))).toBe(202);
    expect(await statusRow(t.store, marked.id)).toMatchObject({ sensitive: 1 });
    const row = (await statusRow(t.store, listed.id))!;
    expect(row.sensitive).toBe(1);
    expect((await t.api<{ sensitive: boolean }>(`/api/v1/statuses/${row.id}`)).body.sensitive).toBe(true);
  });

  // The other paths reach parseRemoteStatus through a fetch (fetchRemoteStatus): a Create given by id, and a boost of
  // an unknown original.
  it('stores no status fetched with sensitive "": a Create given by id, a boost of it', async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const blank = mastodonNote(bob, { sensitive: "" });
    t.web.serve(blank.id, { "@context": AS, ...blank });
    expect(await t.post(bob, { ...create(bob, blank), object: blank.id })).toBe(202);
    expect(await t.post(bob, announce(bob, blank.id))).toBe(202);
    expect(t.web.fetched).toContain(blank.id);
    expect(await statuses(t.store)).toEqual([]);

    const marked = mastodonNote(bob, { sensitive: "x" });
    t.web.serve(marked.id, { "@context": AS, ...marked });
    expect(await t.post(bob, announce(bob, marked.id))).toBe(202);
    expect(await statusRow(t.store, marked.id)).toMatchObject({ sensitive: 1 });
  });

  // Create#create_status counts a vote (poll_vote?) before it assigns anything, so a vote Note with "" counts.
  it('counts a vote whose sensitive is ""', async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const status = await localStatus(t, { status: "which?", poll: { options: ["cats", "dogs"], expires_in: 3600 } });
    const vote = { id: `${bob.uri}#votes/1`, type: "Note", name: "dogs", attributedTo: bob.uri, inReplyTo: status.uri };
    const activity = { "@context": AS, id: `${vote.id}/activity`, type: "Create", actor: bob.uri, to: [] };
    expect(await t.post(bob, { ...activity, object: { ...vote, to: [], sensitive: "" } })).toBe(202);
    expect(await sql(t.store, "SELECT tallies FROM polls")).toEqual([{ tallies: "[0,1]" }]);
  });

  // ProcessStatusUpdateService: an explicit update (a newer `updated`) assigns sensitive in its transaction, which the
  // NOT NULL refuses whole; an implicit one (no newer version) assigns none and still applies the poll's counts.
  it('applies the implicit update of a status whose sensitive is "", and refuses its explicit edit', async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const poll = (cats: number, dogs: number) => ({
      type: "Question",
      endTime: "2026-10-12T01:00:00Z",
      votersCount: cats + dogs,
      oneOf: [
        { type: "Note", name: "cats", replies: { type: "Collection", totalItems: cats } },
        { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: dogs } },
      ],
    });
    const question = mastodonNote(bob, poll(2, 1));
    await t.post(bob, create(bob, question));
    const stored = (await statusRow(t.store, question.id))!;
    const tallies = () => sql(t.store, "SELECT tallies, votes_count FROM polls WHERE status_id = ?", stored.id);
    expect(await tallies()).toEqual([{ tallies: "[2,1]", votes_count: 3 }]);

    const implicit = { ...create(bob, { ...question, ...poll(5, 2), sensitive: "" }), id: `${question.id}#u1` };
    expect(await t.post(bob, { ...implicit, type: "Update" })).toBe(202);
    expect(await tallies()).toEqual([{ tallies: "[5,2]", votes_count: 7 }]);
    expect(await statusRow(t.store, question.id)).toEqual(stored);

    const edit = { ...question, ...poll(9, 9), content: "<p>edited</p>", sensitive: "" };
    expect(await t.post(bob, update(bob, edit, "2026-10-11T13:00:00Z"))).toBe(202);
    expect(await tallies()).toEqual([{ tallies: "[5,2]", votes_count: 7 }]);
    expect(await statusRow(t.store, question.id)).toEqual(stored);
  });

  // The watermark's boundary (docs/mastodon-deviations.md, "Retractions and edits of remote statuses"): for a status
  // never edited, an `updated` equal to its `published` is the stored version, so the Update is implicit here and its
  // poll applies, where Mastodon (edited_at nil) takes it as an explicit edit and refuses it whole; an earlier one
  // changes nothing here.
  it('applies the poll of an Update whose updated is a never-edited status\'s published, with sensitive ""', async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const poll = (cats: number, dogs: number) => ({
      type: "Question",
      endTime: "2026-10-12T01:00:00Z",
      votersCount: cats + dogs,
      oneOf: [
        { type: "Note", name: "cats", replies: { type: "Collection", totalItems: cats } },
        { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: dogs } },
      ],
    });
    const question = mastodonNote(bob, poll(2, 1));
    await t.post(bob, create(bob, question));
    const stored = (await statusRow(t.store, question.id))!;
    const tallies = () => sql(t.store, "SELECT tallies FROM polls WHERE status_id = ?", stored.id);

    const equal = { ...question, ...poll(5, 2), content: "<p>edited</p>", sensitive: "" };
    expect(await t.post(bob, update(bob, equal, question.published as string))).toBe(202);
    expect(await tallies()).toEqual([{ tallies: "[5,2]" }]);
    expect(await statusRow(t.store, question.id)).toEqual(stored);

    const earlier = { ...question, ...poll(9, 9), content: "<p>edited</p>", sensitive: "" };
    expect(await t.post(bob, update(bob, earlier, "2026-10-11T11:00:00Z"))).toBe(202);
    expect(await tallies()).toEqual([{ tallies: "[5,2]" }]);
    expect(await statusRow(t.store, question.id)).toEqual(stored);
  });

  it('leaves the status an Update whose sensitive is "" edits, and applies one of "x"', async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const original = mastodonNote(bob);
    await t.post(bob, create(bob, original));
    const stored = (await statusRow(t.store, original.id))!;
    expect(stored).toMatchObject({ sensitive: 0, edited_at: null });

    const blank = update(bob, { ...original, content: "<p>edited</p>", sensitive: "" }, "2026-10-11T13:00:00Z");
    expect(await t.post(bob, blank)).toBe(202);
    expect(await statusRow(t.store, original.id)).toEqual(stored);

    const marked = update(bob, { ...original, content: "<p>edited</p>", sensitive: "x" }, "2026-10-11T13:00:00Z");
    expect(await t.post(bob, marked)).toBe(202);
    expect(await statusRow(t.store, original.id)).toMatchObject({
      content: "<p>edited</p>",
      sensitive: 1,
      edited_at: "2026-10-11T13:00:00.000Z",
    });
  });
});
