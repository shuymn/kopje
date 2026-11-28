// An ActivityPub Document's width or height in pixels: a whole number from 1 to DOCUMENT_DIMENSION_MAX. The one rule of
// both sides: what Kopje's receiver reads (federation/remote-status.ts mediaOf) and what a local Note writes
// (domain/status-presenter.ts documentFacts), so Kopje never publishes a dimension it would drop on reading it back.
export const DOCUMENT_DIMENSION_MAX = 100_000;

export function isDocumentDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= DOCUMENT_DIMENSION_MAX;
}
