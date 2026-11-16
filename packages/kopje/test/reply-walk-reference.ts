import type { Shape } from "./reply-thread-helpers";

// A reference of context walks with scans and debts (#1607 D12, over #1592 D2, D3, D6 and D7 with the deferral of
// section 13), written from the designs' text and not from src/: oracle 1 of the generated test
// (reply-walk-generated.test.ts). It walks a thread whose every document is served, so a fetch never fails (the
// designs' premise F), and gives the status steps a walk hands out, in order; it keeps the stored statuses, the scan
// cursors and every root's debts, which the test compares with the Store's after each walk. What it leaves out, since
// the generated threads never reach it: failed fetches and their retries, removals, statuses too recent to fetch or
// the roots of a running refresh (should_not_fetch_replies), private or withdrawn rows, and create walks. Ids are the
// one input it does not decide: the Store draws a fetched status's id at random, so `idFor` names it.

const WALK_STATUSES = 200;
const WALK_PAGES = 100;
const NODE_ATTEMPTS = 2;
const READ_ENTRIES = 200;
const SCAN_ROWS = 200;
const INSTANCE_ORIGIN = "https://kopje.test";
export const [ROW, COLLECTION] = [0, 1];
const [ORDINARY, OWED, PATH] = [0, 1, 2];

// A status as its server serves it: its parent, and its replies collection as served() serves it.
export type RefDoc = { inReplyTo: string | null; shape: Shape; entries: readonly unknown[]; page: number };
export type RefStatus = { id: string; uri: string; parentId: string | null; local: boolean };
export type RefPlace = { page: string | null; offset: number };
export type RefDebt = {
  statusId: string;
  kind: number;
  place: RefPlace;
  depth: number;
  key: [number, number, number];
};

export class RefWorld {
  readonly statuses = new Map<string, RefStatus>();
  readonly byId = new Map<string, RefStatus>();
  // A status's stored public replies, by id in the Store's order (text).
  readonly children = new Map<string, string[]>();
  readonly cursors = new Map<string, string>();
  // root id → status id → debt.
  readonly debts = new Map<string, Map<string, RefDebt>>();

  constructor(readonly docs: ReadonlyMap<string, RefDoc>) {}

  store(status: RefStatus): void {
    this.statuses.set(status.uri, status);
    this.byId.set(status.id, status);
    if (status.parentId !== null) {
      this.link(status.id, status.parentId);
    }
  }

  move(statusId: string, parentId: string): void {
    const status = this.byId.get(statusId)!;
    if (status.parentId !== null) {
      const siblings = this.children.get(status.parentId)!;
      siblings.splice(siblings.indexOf(statusId), 1);
    }
    status.parentId = parentId;
    this.link(statusId, parentId);
  }

  private link(id: string, parentId: string): void {
    const siblings = this.children.get(parentId) ?? [];
    let at = siblings.length;
    while (at > 0 && siblings[at - 1]! > id) {
      at--;
    }
    siblings.splice(at, 0, id);
    this.children.set(parentId, siblings);
  }

  debtsOf(rootId: string): Map<string, RefDebt> {
    const debts = this.debts.get(rootId) ?? new Map<string, RefDebt>();
    this.debts.set(rootId, debts);
    return debts;
  }
}

const keyAfter = (a: readonly number[], b: readonly number[]) =>
  a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! > b[2]!;

// An entry as the reader takes it: an http(s) id (a string, or an object's id), else null, its position kept.
function entryId(entry: unknown): string | null {
  const id = typeof entry === "string" ? entry : (entry as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !/^https?:\/\//.test(id)) {
    return null;
  }
  try {
    return new URL(id).href;
  } catch {
    return null;
  }
}

// A URI a walk may record: http(s), not of this instance's origin.
const walkUri = (uri: string) => /^https?:\/\//.test(uri) && new URL(uri).origin !== INSTANCE_ORIGIN;

type Stage = "status" | "replies" | "collection" | "page";
type Node = {
  uri: string;
  seq: number;
  stage: Stage;
  state: "pending" | "done" | "deferred";
  waitsOn: string | null;
  lane: number;
  valid: boolean;
  depth: number;
  attempts: number;
  // The reading: the chain's page (1 the first) and its skip; whether a chain was read.
  page: number;
  skip: number;
  readChain: boolean;
  scanDue: boolean;
  applied: RefDebt | null;
};

const pageUri = (status: string, k: number) => `${status}/replies?page=${k}`;

// The pages of a status's collection as served() cuts them, and its chains: the first (all of them in the chain shape),
// then one a page.
function chainOf(doc: RefDoc, status: string, k: number): { entries: readonly unknown[]; next: string | null } {
  const size = Math.max(doc.page, 1);
  const pages: (readonly unknown[])[] = [];
  for (let i = 0; i < doc.entries.length; i += size) {
    pages.push(doc.entries.slice(i, i + size));
  }
  if (pages.length === 0) {
    pages.push([]);
  }
  if (doc.shape === "chain") {
    return { entries: doc.entries, next: null };
  }
  return { entries: pages[k - 1] ?? [], next: k < pages.length ? pageUri(status, k + 1) : null };
}

// One context walk of `rootUri`, run to its end: the URIs of the status steps it handed out, in order.
export function referenceWalk(world: RefWorld, rootUri: string, idFor: (uri: string) => string): string[] {
  const root = world.statuses.get(rootUri)!;
  const debts = world.debtsOf(root.id);
  const epoch = Math.max(0, ...[...debts.values()].map((d) => d.key[0])) + 1;
  const nodes = new Map<string, Node>();
  // The root is 0, as reply_walks.next_seq starts at 1 with the root recorded.
  let nextSeq = 0;
  let pages = 0;
  let considering = true;
  let after: [number, number, number] | null = null;
  let seen = 0;
  const fetched: string[] = [];

  const record = (uri: string, lane: number): Node => {
    const node: Node = {
      uri,
      seq: nextSeq++,
      stage: "status",
      state: "pending",
      waitsOn: null,
      lane,
      valid: false,
      depth: 0,
      attempts: 0,
      page: 1,
      skip: 0,
      readChain: false,
      scanDue: false,
      applied: null,
    };
    nodes.set(uri, node);
    return node;
  };
  const rootNode = record(rootUri, ORDINARY);
  rootNode.valid = true;
  const full = () => nodes.size >= WALK_STATUSES;
  // A next document the walk will not follow: no slot, or its pages spent.
  const stops = () => full() || pages >= WALK_PAGES;
  const statusOf = (node: Node) => world.statuses.get(node.uri);

  // Owes the status to the root: another root's debt at its status and depth is replaced; then a debt is inserted
  // unless the root owes the status already, which keeps it, but for the resumed reading of an applied collection
  // debt cut again, re-keyed with its new place.
  const owe = (statusId: string, kind: number, depth: number, key: RefDebt["key"], place: RefPlace, rekey = false) => {
    for (const [other, owed] of world.debts) {
      if (other !== root.id && owed.get(statusId)?.depth === depth) {
        owed.delete(statusId);
      }
    }
    const existing = debts.get(statusId);
    if (existing === undefined) {
      debts.set(statusId, { statusId, kind, place, depth, key });
    } else if (rekey && existing.kind === COLLECTION) {
      debts.set(statusId, { statusId, kind, place, depth, key });
    }
  };
  const settle = (node: Node, kinds: readonly number[]) => {
    const status = statusOf(node);
    const debt = status === undefined ? undefined : debts.get(status.id);
    if (debt !== undefined && kinds.includes(debt.kind)) {
      debts.delete(status!.id);
    }
  };

  // A reading ends: paid, and scan-due once it read a chain.
  const ended = (node: Node) => {
    node.state = "done";
    node.scanDue = node.readChain;
    settle(node, [COLLECTION]);
  };
  // A reading cut before its end: owed with its place, and scan-due once it read a chain.
  const cut = (node: Node, place: RefPlace) => {
    node.state = "done";
    node.scanDue = node.readChain;
    if (node.depth <= WALK_STATUSES - 2) {
      const rekey = node.applied?.kind === COLLECTION;
      owe(statusOf(node)!.id, COLLECTION, node.depth, [epoch, node.seq, 0], place, rekey);
    }
  };
  const placeOf = (node: Node, page: number, offset: number): RefPlace => ({
    page: page === 1 ? null : pageUri(node.uri, page),
    offset,
  });

  // Records the entries of a chain read at `from`; how many it took (all, unless the walk had no slot for one).
  const recordItems = (node: Node, entries: readonly (string | null)[]): number => {
    for (let i = 0; i < entries.length; i++) {
      const uri = entries[i];
      if (uri === null || uri === undefined || !walkUri(uri) || nodes.has(uri)) {
        continue;
      }
      if (full()) {
        return i;
      }
      record(uri, node.lane === ORDINARY ? ORDINARY : OWED);
    }
    return entries.length;
  };

  // A chain read: its entries recorded from `skip`; then a re-read past the cap, a next page, or the end.
  const readChain = (node: Node, stage: Stage, page: number) => {
    const doc = world.docs.get(node.uri)!;
    const chain = chainOf(doc, node.uri, page);
    node.readChain = true;
    const from = node.skip;
    const end = Math.min(chain.entries.length, from + READ_ENTRIES);
    const entries = from >= chain.entries.length ? [] : chain.entries.slice(from, end).map(entryId);
    const taken = recordItems(node, entries);
    if (taken < entries.length) {
      cut(node, placeOf(node, page, from + taken));
      return;
    }
    const more = from < chain.entries.length && end < chain.entries.length;
    if (more) {
      if (stops()) {
        cut(node, placeOf(node, page, from + taken));
        return;
      }
      node.stage = stage;
      node.page = page;
      node.skip = from + taken;
      node.attempts = 0;
      return;
    }
    if (chain.next !== null) {
      if (stops()) {
        cut(node, placeOf(node, page + 1, 0));
        return;
      }
      node.stage = "page";
      node.page = page + 1;
      node.skip = 0;
      node.attempts = 0;
      return;
    }
    ended(node);
  };

  // A document holding no chain: the skip carries to the next, the collection's first chain.
  const toFirst = (node: Node, stage: Stage) => {
    if (stops()) {
      cut(node, { page: null, offset: node.skip });
      return;
    }
    node.stage = stage;
    node.page = 1;
    node.attempts = 0;
  };

  // A valid node's reading from its status: from the start, or from its applied collection debt's place.
  const startReading = (node: Node) => {
    const doc = world.docs.get(node.uri)!;
    const place = node.applied?.kind === COLLECTION ? node.applied.place : null;
    node.skip = place?.offset ?? 0;
    if (place?.page !== null && place?.page !== undefined) {
      const k = Number(new URL(place.page).searchParams.get("page"));
      if (stops()) {
        cut(node, place);
        return;
      }
      node.stage = "page";
      node.page = k;
      node.attempts = 0;
      return;
    }
    if (doc.shape === "absent") {
      ended(node);
    } else if (doc.shape === "embedded" || doc.shape === "chain") {
      readChain(node, "replies", 1);
    } else {
      toFirst(node, doc.shape === "first" ? "page" : "collection");
    }
  };

  const validate = (node: Node, parent: Node | undefined) => {
    node.valid = true;
    node.depth = parent === undefined ? 0 : parent.depth + 1;
    settle(node, [ROW]);
    const back = [...nodes.values()].filter((n) => n.state === "deferred" && n.waitsOn === node.uri);
    for (const n of back.toSorted((a, b) => a.seq - b.seq)) {
      n.state = "pending";
      n.waitsOn = null;
      n.seq = nextSeq++;
    }
  };
  const failed = (node: Node) => {
    node.state = "done";
    if (node !== rootNode) {
      settle(node, [ROW, COLLECTION]);
    }
  };

  // A status step: judged on the stored row's parent (else the document's), stored once its parent is valid.
  const completeStatus = (node: Node) => {
    if (node !== rootNode) {
      const stored = statusOf(node);
      const parentUri = stored
        ? stored.parentId === null
          ? null
          : (world.byId.get(stored.parentId)?.uri ?? null)
        : world.docs.get(node.uri)!.inReplyTo;
      if (parentUri === null || !walkUri(parentUri)) {
        failed(node);
        return;
      }
      const parent = nodes.get(parentUri);
      if (parent !== undefined && parent.state === "done" && !parent.valid) {
        failed(node);
        return;
      }
      if (parent === undefined || !parent.valid) {
        node.state = "deferred";
        node.waitsOn = parentUri;
        return;
      }
      if (!stored) {
        world.store({ id: idFor(node.uri), uri: node.uri, parentId: statusOf(parent)!.id, local: false });
      }
      validate(node, parent);
    }
    if (node.lane === PATH) {
      node.state = "done";
      return;
    }
    startReading(node);
  };

  const complete = (node: Node) => {
    if (node.stage === "status") {
      fetched.push(node.uri);
      completeStatus(node);
    } else if (node.stage === "collection") {
      readChain(node, "collection", 1);
    } else {
      readChain(node, node.stage, node.page);
    }
  };

  // Charges a node: one of its attempts at its document, and a page at a reading stage; false when it ended instead.
  const charge = (node: Node): boolean => {
    if (node.attempts >= NODE_ATTEMPTS) {
      if (node.stage === "status") {
        failed(node);
      } else {
        cut(node, placeOf(node, node.page, node.skip));
      }
      return false;
    }
    if (node.stage !== "status") {
      if (pages >= WALK_PAGES) {
        cut(node, placeOf(node, node.page, node.skip));
        return false;
      }
      pages++;
    }
    node.attempts++;
    return true;
  };

  // A scan of the node: its window after its cursor, wrapping; each eligible row admitted, or owed when the walk is
  // full; then its cursor moved.
  const scan = (node: Node) => {
    node.scanDue = false;
    const status = statusOf(node)!;
    const ids = world.children.get(status.id) ?? [];
    const cursor = world.cursors.get(status.id) ?? null;
    let rows = ids.filter((id) => cursor === null || id > cursor).slice(0, SCAN_ROWS);
    if (cursor !== null && rows.length < SCAN_ROWS) {
      rows = [...rows, ...ids.filter((id) => id <= cursor).slice(0, SCAN_ROWS - rows.length)];
    }
    const depth = node.depth + 1;
    rows.forEach((id, i) => {
      const row = world.byId.get(id)!;
      if (!walkUri(row.uri) || nodes.has(row.uri) || row.local) {
        return;
      }
      if (!full()) {
        record(row.uri, node.lane === ORDINARY ? ORDINARY : OWED);
      } else if (depth <= WALK_STATUSES - 1) {
        owe(id, ROW, depth, [epoch, node.seq, i + 1], { page: null, offset: 0 });
      }
    });
    if (rows.length < SCAN_ROWS) {
      world.cursors.delete(status.id);
    } else {
      world.cursors.set(status.id, rows.at(-1)!);
    }
  };

  // The root's next debt in key order: applied to a node at its status stage, passed for a node past it, else
  // recorded after its stored path, or dropped or closing considering when the path does not fit.
  const consider = () => {
    if (full() || seen >= WALK_STATUSES) {
      considering = false;
      return;
    }
    const debt = [...debts.values()]
      .filter((d) => after === null || keyAfter(d.key, after))
      .toSorted((a, b) => (keyAfter(a.key, b.key) ? 1 : -1))[0];
    if (debt === undefined) {
      considering = false;
      return;
    }
    seen++;
    after = debt.key;
    const status = world.byId.get(debt.statusId)!;
    const node = nodes.get(status.uri);
    if (node !== undefined) {
      if (node.stage === "status" && node.state !== "done") {
        node.lane = OWED;
        node.applied = debt;
      }
      return;
    }
    const room = WALK_STATUSES - nodes.size - (debt.kind === COLLECTION ? 2 : 1);
    const unfit = () => {
      if (nodes.size === 1) {
        debts.delete(debt.statusId);
      } else {
        considering = false;
      }
    };
    if (status.local) {
      debts.delete(debt.statusId);
      return;
    }
    const path: string[] = [];
    let parentId = status.parentId;
    for (;;) {
      const parent = parentId === null ? undefined : world.byId.get(parentId);
      if (parent === undefined) {
        unfit();
        return;
      }
      if (nodes.has(parent.uri)) {
        break;
      }
      if (parent.local) {
        debts.delete(debt.statusId);
        return;
      }
      if (path.length >= room) {
        unfit();
        return;
      }
      path.push(parent.uri);
      parentId = parent.parentId;
    }
    if (path.length > room) {
      unfit();
      return;
    }
    for (const uri of path.toReversed()) {
      record(uri, PATH);
    }
    record(status.uri, OWED).applied = debt;
  };

  const first = (pick: (n: Node) => boolean) => [...nodes.values()].filter(pick).toSorted((a, b) => a.seq - b.seq)[0];

  // The hand-out order of D12's lanes: owed and path nodes pending, an owed node's scan, the next debt, then the
  // ordinary lane by seq and, with no node pending, an ordinary node's scan.
  const handOut = (): Node | undefined => {
    for (;;) {
      const owedNode = first((n) => n.lane !== ORDINARY && n.state === "pending");
      if (owedNode !== undefined) {
        if (charge(owedNode)) {
          return owedNode;
        }
        continue;
      }
      const owedScan = first((n) => n.lane !== ORDINARY && n.scanDue);
      if (owedScan !== undefined) {
        scan(owedScan);
        continue;
      }
      if (considering) {
        consider();
        continue;
      }
      const ordinary = first((n) => n.state === "pending");
      if (ordinary !== undefined) {
        if (charge(ordinary)) {
          return ordinary;
        }
        continue;
      }
      const ordinaryScan = first((n) => n.scanDue);
      if (ordinaryScan !== undefined) {
        scan(ordinaryScan);
        continue;
      }
      return undefined;
    }
  };

  for (let node = handOut(); node !== undefined; node = handOut()) {
    complete(node);
  }
  return fetched;
}
