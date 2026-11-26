// RES-3's answer budgets. This module imports nothing, so test-node/presented-maxima.test.ts reads the values on Node
// and checks each figure the documents give of them; the code takes them through answer-budget.ts.

// RES-3: the UTF-8 bytes of one answer's JSON, containers and separators included; a composite answer's parts share
// it. Owners and admission: docs/response-inventory.md. Every atomic item is within 89% of it (docs/threat-model.md,
// "Maxima of presented units", which test/status-bounds.test.ts measures), so an answer always admits its first item.
export const ANSWER_BYTES = 8 * 1024 * 1024;

// RES-3: the budget of an answer that presents statuses (a REST status answer, a composite one such as search from its
// first admission): less than ANSWER_BYTES, since each byte an answer admits is held three times in the Store's heap
// model ("Heap at 8 MiB per answer"), whose timeline peak a status's tagged_collections at their maxima (#1589's D26)
// would otherwise pass. The largest multiple of 8 KiB that keeps that peak SPARE_FLOOR under half the isolate, as
// test/status-bounds.test.ts derives it; every atomic status item is within it, and a page it cuts continues from its
// last admitted item.
export const STATUS_ANSWER_BYTES = 7_815_168;

// The bytes of an outbox page's serialized activities at most (RES-3): ANSWER_BYTES less a reserve for the
// collection page around them, which the Worker builds (local-notes.ts getOutbox).
export const OUTBOX_BYTES = ANSWER_BYTES - 64 * 1024;
