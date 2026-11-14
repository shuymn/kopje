# Mastodon-Compatible API Specification

This specification defines the requirements for implementing a Mastodon-compatible server. It targets ActivityPub
federation interoperability and broad client compatibility.

## Scope

This specification covers:

- **Federation Protocol** - ActivityPub, HTTP Signatures, WebFinger
- **Discovery Endpoints** - Server metadata and account lookup
- **Client REST API** - Authentication, timelines, statuses, accounts
- **Streaming API** - Real-time event delivery
- **Admin API** - Server administration (appendix)

## Baseline Version

This specification was written against **Mastodon v4.5.11**. Features introduced in newer versions are marked as
optional extensions. It records Mastodon's behaviour at that release; the release Kopje follows, and how it follows
newer ones, are in [mastodon-deviations.md](../mastodon-deviations.md).

Implementation references link to [`mastodon/mastodon@v4.5.11`](https://github.com/mastodon/mastodon/tree/v4.5.11).

Official API documentation source:
[`mastodon/documentation@960eeb05`](https://github.com/mastodon/documentation/commit/960eeb05f61209f2f7e8e97456239a3a8e143c6f)
([docs.joinmastodon.org](https://docs.joinmastodon.org/)).

Reference sources:

| Repository | Pin |
|------------|-----|
| [mastodon/mastodon](https://github.com/mastodon/mastodon) | `v4.5.11` |
| [mastodon/documentation](https://github.com/mastodon/documentation) | `960eeb05` |

## Client Compatibility

The Client API section prioritizes compatibility with:

- Official Mastodon apps (iOS, Android, Web)
- Ivory
- Elk
- Other popular third-party clients

## Document Structure

| Section | Description |
|---------|-------------|
| [Conformance](conformance.md) | MUST/SHOULD/MAY terminology and compliance levels |
| [Versioning](versioning.md) | Version baseline and extension markers |
| [Federation](federation/) | ActivityPub protocol and HTTP signatures |
| [Discovery](discovery/) | WebFinger, NodeInfo, OAuth metadata |
| [Client API](client-api/) | REST API for client applications |
| [Streaming](streaming/) | WebSocket real-time events |
| [Admin API](admin-api/) | Administrative endpoints (appendix) |

## Normative vs Informative

- **Normative sections** use RFC 2119 keywords (MUST, SHOULD, MAY)
- **Informative sections** provide context and examples
- These documents are a reading guide, not the checked description of Mastodon's API. The routes, scopes,
  parameters and entity fields Kopje is checked against are the fixture extracted from Mastodon's source
  (`test/fixtures/mastodon-<version>-api-access.json`, written by `scripts/mastodon-scopes.mjs`), and every accepted
  departure is in [mastodon-deviations.md](../mastodon-deviations.md).
- The scope hierarchy table in [client-api/auth-oauth.md](client-api/auth-oauth.md) is read by `test/vectors.test.ts`.

## Contributing

When updating this specification:

1. Name the fixture or the code that holds a list of routes, scopes, parameters or fields rather than restating it
2. Mark new features with version annotations
