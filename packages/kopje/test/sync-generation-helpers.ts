import { MAX_REMOTE_PINS, MAX_SYNC_ATTEMPTS } from "../src/domain/remote-collections";
import {
  COLLECTION_SYNCS_PER_ROUND,
  COLLECTIONS_CAPS,
  NETWORK_CAPS,
  PART_DOCUMENTS,
} from "../src/federation/collections";
import { MAX_REDIRECTS, REQUEST_MAX_FETCHES } from "../src/federation/loader";

// RES-6: the most HTTP requests one generation of a sync makes, computed from the constants
// (test/remote-collections.test.ts "the requests of one generation", test/reply-walk-rounds.test.ts).
// Each read claim spends at most one round's budget; a generation has the document part's claims (a refresh asked
// with it, before its read), MAX_SYNC_ATTEMPTS per read part (each claim after one without progress starts with
// another part) and one more, the claim a pending move opens (moveOpened), and MAX_SYNC_ATTEMPTS per pin row.
export function generationRequests(network: { documents: number; redirects: number }, sends = 1) {
  const parts = [
    PART_DOCUMENTS.moved * (1 + MAX_REDIRECTS) * sends,
    PART_DOCUMENTS.featured * (1 + MAX_REDIRECTS) * sends,
    network.documents * (1 + network.redirects) * sends,
    PART_DOCUMENTS.tags * (1 + MAX_REDIRECTS) * sends,
    PART_DOCUMENTS.collections * (1 + COLLECTIONS_CAPS.maxRedirects) * sends,
  ];
  const documentClaims = MAX_SYNC_ATTEMPTS;
  const readClaims = parts.length * MAX_SYNC_ATTEMPTS + 1;
  const readRound = Math.min(
    REQUEST_MAX_FETCHES,
    parts.reduce((sum, n) => sum + n, 0),
  );
  const pinClaims = MAX_REMOTE_PINS * MAX_SYNC_ATTEMPTS;
  return {
    readClaims,
    networkPerRound: Math.min(REQUEST_MAX_FETCHES, parts[2]!),
    networkPerGeneration: readClaims * Math.min(REQUEST_MAX_FETCHES, parts[2]!),
    networkHealthy: network.documents,
    perCall: COLLECTION_SYNCS_PER_ROUND * REQUEST_MAX_FETCHES,
    perGeneration: (documentClaims + readClaims) * readRound + pinClaims * REQUEST_MAX_FETCHES,
  };
}

// The network part as it reads the outbox: its three documents under NETWORK_CAPS.
export const NETWORK_READ = { documents: PART_DOCUMENTS.network, redirects: NETWORK_CAPS.maxRedirects };
