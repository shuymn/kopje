# Compatibility with Mastodon

This page states which Mastodon release Kopje follows, how it follows newer ones, and the departures it has decided.
Other documents point here rather than repeat the release.

## What Kopje follows

- **Client API.** Kopje follows the client API as **Mastodon v4.7.5** serves it, the reference release, apart from
  the departures below and the gaps open issues track. The claim is for that tag. A fix that a later Mastodon release
  makes may be followed before the reference release moves; the entry or code comment that describes the fixed
  behaviour names that release. The conformance checks compare Kopje with the reference release's source: the routes
  and their access (`test/mastodon-access.test.ts`), the routes Mastodon serves that Kopje does not route (the same
  test), the request parameters each route reads (`test/mastodon-params.test.ts`), and the fields of the main entities
  (`test-node/mastodon-entities.test.ts`). Their fixtures carry the release in their names and their `mastodon` field,
  and `test-node/mastodon-reference.test.ts` checks that they name the release this page does.
- **What clients are told.** `/api/v2/instance` advertises `version` 4.6.1 and `api_versions.mastodon` 11, and
  `/api/v1/instance` the same `version` (`src/mastodon/instance.ts`). Clients switch features on by these values, so
  they name the API level whose features Kopje serves, not the reference patch, Kopje's own release or its federation.
  They rise only when every feature a client switches on at the higher value is served. Mastodon v4.7.5 advertises
  `api_versions.mastodon` 11 too; `version` is 4.6.1, the first release to advertise 11 (4.6.0 advertised 10), and no
  client switches on by it a 4.6 or 4.7 feature Kopje does not serve. Each step past 7 signals a feature, all served:
  - 8, `exclude_direct` (`mastodon#37763`), with the departures under "Paged status lists with request conditions";
    from 8 the official Android and iOS apps also edit the profile through `/api/v1/profile`;
  - 9, the image descriptions of `/api/v1/profile` (`mastodon#38221`);
  - 10, collections under `/api/v1` (`mastodon#39210`), a remote account's read from its server, with the departures
    and gaps under "Collections": clients list any account's collections, open them and let a member revoke its item;
  - 11, the image descriptions of `update_credentials` (`mastodon#39574`); from 11 Tuba also edits the profile's
    display settings through `/api/v1/profile`.
- **Streaming.** Kopje serves the streaming API of the reference release over WebSocket only (MD-8), with bounds on the
  subscriptions a socket and an account hold, past which a subscription is refused (`src/mastodon/streaming.ts`,
  `src/stream-hub.ts`; threat model DATA-5, VIS-26, RES-6, RES-7). An event whose payload, encoded as the streaming API
  sends it, passes 254 KiB (`STREAM_LIMITS.payloadBytes`) is not sent and is logged (`kopje.stream.payload-skipped`,
  with its kind): the `update`, `status.update`, `notification`, `conversation` or `announcement` frame is missing, and
  the status, notification, conversation or announcement is there on the next REST read (its timeline, the notifications
  list, `GET /api/v1/conversations`, `GET /api/v1/announcements`). Mastodon sends every event. The payload is the
  event's media descriptions and everything else it shows, both as encoded: a description's character takes 1 byte
  (ASCII) to 4 (characters past U+FFFF, such as most emoji, and `"` and `\`), and at most 7, for the control characters
  written as `\u00XX`, such as U+0001 (a tab, newline, carriage return, backspace or form feed takes 3); the rest
  expands with formatted text (a link is written twice, in its address and its shown text, with `&` as `&amp;`; profile
  fields and poll choices likewise). An event whose rest takes R bytes is sent while its descriptions take at most
  260,096 − R. Beside plain text, a poll and profiles at their limits, a post and its quote with eight descriptions of
  10,000 ASCII characters (80,000 bytes) are sent (R about 141,000, and 179,000 for their boost), and skipped with eight
  descriptions of emoji (320,000) or beside three long links in each post (R about 281,000); a post without a quote is
  sent with four descriptions of emoji (160,000, R about 70,000) while its boost is not (R about 108,000), and skipped
  with four of U+0001 (280,000). A moderation warning whose account has its fields and texts at their limits (about
  336,000 bytes) and an announcement near its derived maximum (497,996) are skipped too, as are events whose statuses
  are near their stored bounds (remote statuses, or content filled by mentions). The figures are pinned by
  `test/streaming/public.test.ts` and `test/status-bounds.test.ts`, the skips of a notification and an announcement with
  their REST reads by `test/streaming/public.test.ts` and `test/streaming/announcements.test.ts`. Accepted, 2026-11-15,
  and at 254 KiB, 2026-11-17.
- **Streaming output.** Kopje cannot see whether a client reads what it is sent (the runtime gives no signal of unsent
  output and cannot ping), so it charges each connection everything it hands it, with the runtime's overhead per frame,
  until the connection ends. Before an event or an error reply would take a connection past `STREAM_OUTPUT.socketBytes`
  (5 MiB), or all connections together past `instanceBytes` (16 MiB), it closes that connection with 1013, after every
  frame sent before; while the instance's allowance is full it refuses new connections (503): at the shipped caps it
  holds 212 fresh connections, fewer as output is held, so the limit of 256 connections is reached only if it allows.
  After an upgrade it streams nothing and refuses new connections until the previous release's connections have ended. A
  connection that reads is closed after 491 to 800 frames of 4 to 2 KB (figures from the shipped caps). masto.js 7.12
  reconnects after 1 s (it clears its backoff when an open socket closes). Mastodon's web client (`@gamestdio/websocket`
  0.3.2) waits `floor(random × 2^n × 100)` ms after the nth close in the page's life, a count no successful open resets
  (a median of 13.65 minutes at the 14th), meanwhile polling home and notifications every 20 to 40 s; on reconnect it
  fetches the statuses newer than the newest it holds in home, local, federated and lists, so it keeps showing a status
  edited or deleted while it was away, or in the event that closed it, until the page is reloaded, and hashtag and
  direct columns miss what passed until reloaded. Mastodon closes no connection for its volume: it ends one that does
  not answer its pings within a minute. `src/stream-hub.ts`, `src/stream-output.ts`; `test/streaming/output.test.ts`,
  `test-node/stream-output.test.ts`. Accepted, 2026-11-17.
- **Federation.** Kopje federates with every Mastodon series upstream still supports (its `SECURITY.md`), so it names
  no single release here. A behaviour takes as its reference the release its code and the threat model name:
  remote-status ingestion and handle confirmation follow Mastodon v4.7.5, with Kopje's failure handling under NET-4, and
  local collections are published as its FEP-7aa9 documents. A supported series whose activities Kopje refuses or
  misreads is a gap.

## Following a Mastodon release

Every release of every supported series is read for the parts below. A change found is fixed, accepted here as a
departure, or opened as a gap, and the reference release moves only when every change up to it has had one of these.
The paths below are where to start: an entry of the changelog is traced to the services, models and libraries that
implement it, since a change there (what an account's deletion removes, say) shows in the API without touching a route.

- **A patch of the reference series.** Read its changelog and the diff of `config/routes*`, `app/controllers/api`,
  `app/controllers/oauth`, `app/controllers/concerns`, `app/serializers/rest` and `streaming/`. A patch can change
  access, required parameters and values without changing a route, a field or `api_versions`. To move the reference
  release, regenerate the access fixture from the new tag with `scripts/mastodon-scopes.mjs` (and add any new entity to
  its `ENTITIES`), rename the hand-written fixtures and their imports after re-checking them against it, review each
  new exception and each route the route check reports, and change the release on this page.
- **A new minor series.** Whether to follow it is decided on what it adds to the surface Kopje already serves, judged
  at its latest patch. Following it is the same move with a larger inventory (routes, parameters, entities, behaviour);
  raising `version` and `api_versions` is a separate step, as above. Before the reference series leaves upstream
  support (4.7: no date in v4.7.5's `SECURITY.md`), decide whether to follow a supported one.
- **Federation in any supported series.** Read the diff of `app/lib/activitypub`, `app/services/activitypub`,
  `app/serializers/activitypub`, `app/controllers/concerns/signature_verification.rb`, `app/lib/request*`,
  `app/helpers/context_helper.rb` and `app/helpers/json_ld_helper.rb`: what is sent and received, contexts, signatures
  and proofs, identifiers, forwarding, and which activities are authorized; and compare `full_context`
  (`NAMED_CONTEXT_MAP`, `CONTEXT_EXTENSION_MAP`) and `LinkedDataSignature#sign!` at the new tag with
  `MASTODON_NAMED_CONTEXTS`, `MASTODON_CONTEXT_TERMS` and `PROFILES`: a difference is a gap, tracked by an issue until a
  profile covers it. Re-capture `test/fixtures/ld-signed/` with its scripts at the new tag: a reading Mastodon changed
  fails its row. This applies whether or not the reference release moves.

The checks see whether a parameter is read and a field is present. A parameter that is read and then dropped, or a
wrong value, does not show in them, so the behaviour is reviewed by reading Mastodon's source.

## Deciding a difference

A difference the checks find is either a gap, tracked by an issue until it is fixed, or a departure that has been
decided. This page lists the decided ones. Each has an id (`MD-n`) that the checks' exceptions cite as
`{ status: 'accepted', deviation: 'MD-n' }`; every entry here is cited by at least one exception, and every id cited is
defined here once (`test-node/docs-ids.test.ts`, `test-node/mastodon-entities.test.ts`).

Behaviour the checks cannot see (how a value is judged, rather than whether a parameter or field is read) is listed
without ids under [Differences the checks cannot see](#differences-the-checks-cannot-see).

A cap that drops protocol-visible data (a field, an item or part of a value Mastodon presents or federates) is a
behaviour change: check what Mastodon does first, and cap only within it or as a departure decided here. A code comment
calling a difference deliberate is not a decision. To accept a departure, add an entry here with the reason, ending
"Accepted, <date>.", and change the exceptions that cite the gap.

A pull request that fixes a gap removes the exceptions that cite it.

## Departures

- **MD-1: Registration through the API is closed.** `POST /api/v1/accounts` answers 403, as Mastodon does with
  registrations closed, and `POST /api/v1/emails/confirmations` refuses, since no user signs up through an app. Besides
  the admin's, made by `/setup`, an account is made only by invitation: the first sign-in through Cloudflare Access of
  an email the Access admin invited ([setup.md](setup.md), "Adding accounts"; threat model AUTH-9). Accepted,
  2026-10-15; the invitation rule, 2026-10-27.
- **MD-2: Admin operations withheld from Mastodon's API.** Every admin route answers anyone but the OAuth admin 403
  `Forbidden` first, after a suspended owner's 403, as Mastodon 4.7.5's `Admin::PermissionsConcern` does, before the
  token's validity or scope, any lookup or the body is judged. A token of the OAuth admin that was revoked, or swept
  once expired, is deleted, so it answers `Forbidden` where Mastodon, whose Doorkeeper 5.9.9 finds such a token's owner
  until its vacuum, answers 401. To the OAuth admin, domain allows, IP, email domain and canonical email blocks, link
  publishers and admin tags answer 403 or 404, as Mastodon answers a role without the permission; dimensions and
  retention answer `[]`, retention after its 400 for a missing `start_at` or `end_at` and 422 for an invalid date, as
  Mastodon 4.7.5 does. Kopje has no sign-ups, recorded IPs or allowlist mode. Trends review through the Mastodon admin
  API (approve, reject) answers 403; the Access admin reviews trends (`kopje-admin trends`). Accepted, 2026-10-16. Of
  the measures (`POST /api/v1/admin/measures`), `active_users` (Kopje keeps login days only for the instance activity,
  from the upgrade that added them and for today, the 184 days before it and tomorrow, plus an imported backlog until
  the prune reaches it (RES-4 in `docs/threat-model.md`), where the measure takes any range), `interactions` (no count
  of replies, boosts, follows, votes and favourites by day survives their undo), `tag_accounts`, `tag_uses` and
  `tag_servers` (no hashtag history over an arbitrary range, and a hashtag's API id names no stored row) and
  `instance_statuses` (a server's statuses stay stored while their deletion runs) answer 422
  `measure <key> is not served` to the OAuth admin, the whole request; to the OAuth admin, Mastodon 4.7.5's 400 for a
  missing `keys` or object and 422 for an invalid date come first. Accepted, 2026-10-22. Kopje does not offer silencing
  or memorializing, admin operations of Mastodon (`silence` answers 422), and moderation that severs relationships
  writes no `severed_relationships` notification, so an Account's `limited` and `memorial` and a notification's `event`
  are never sent. Accepted, 2026-11-15.
- **MD-3: Features not built yet answer as Mastodon with the feature off.** Translation and the admin domain allows list
  answer empty or 404 until the feature is built; the backlog tracks them. Donation campaigns answer as with no campaign
  source configured: `GET /api/v1/donation_campaigns` answers 204 to a signed-in user. E-mail subscriptions answer as
  with the setting off: `POST /api/v1/accounts/:account_id/email_subscriptions` answers 404 (`Record not found` for an
  id that names no local account, an empty body otherwise), and Account has no `email_subscriptions`. Accepted,
  2026-10-20; donation campaigns and e-mail subscriptions, 2026-11-15.
- **MD-4: Announcements differ in what they embed and when they change.** `statuses` is always `[]`: Mastodon embeds the
  statuses the text links, each up to a whole quote, in a list with no paging; the links stay in `content`. At most 16
  mentions (of available accounts, among the first 64 references, each the account that holds the handle when the
  announcement is read, as Mastodon's `Announcement#mentions` resolves it) and 16 hashtags are listed; `content` links
  every hashtag. A text whose rendering passes 64 KiB of JSON is refused when written, and one that passes it later (a
  mentioned account's URL grew) is shown escaped with no link. A scheduled announcement is published by the 5-minute
  cron within 5 minutes after `scheduled_at`, with `published_at` = `scheduled_at`. At most 16 are published or
  scheduled and 1,000 kept. Reactions are grouped by name (Mastodon groups by name and emoji), and a Unicode reaction is
  any fully qualified RGI emoji or its unqualified form, a superset of Mastodon's emoji map. Accepted, 2026-10-20.
- **MD-5: Trends are worked out from Kopje's stored statuses.** Every 5 minutes Kopje counts again from the newest 4,000
  public originals with ids from yesterday 00:00 UTC on, classified by publication day (Mastodon counts on receipt); at
  most 100 hashtags per post and 8,000 in all are read, and the 400 hashtags with the most accounts today are scored.
  Only the 400 posts of that window with the most boosts and favourites (counted up to 10,000,000) are scored. A post
  published earlier but given a later id, or the reverse, is counted only within that window. The next scoring round
  excludes deleted posts and unavailable authors; status lists apply R41 on every read. At most 200 allowed hashtags and
  200 allowed posts are kept, with 50 of each awaiting review, and 3 posts per author; the lists end at the top 200
  allowed now, and an offset of 200 or more answers `[]`. A trending hashtag's `history` follows the Hashtags rules
  below (the trends lists' cap is 200), and a hashtag whose stored name is not in its own normalized form (an imported
  one) never trends. Reviews are made by the Access admin, take effect at once and send no e-mail. While trends are off,
  public lists are empty; the next cron round clears stored trends and leaves the Access admin lists empty too. Posts
  are ordered by the `Accept-Language` language among ISO 639-1 codes (no user locale, chosen languages or `lang`).
  `limit=0` answers `[]` without a Link, and a page cut by its byte budget continues after its last post. Links are
  counted from the same window by publication day: its public originals with a public card, and at most 4,000 public
  boosts of them from yesterday 00:00 UTC, at most 100 per post (boosts of older posts are not counted); the 400 links
  with the most accounts today are scored. A link is its card's URL after redirects: no canonical URL is read, a final
  URL the stored URL rule refuses leaves the card out of trends, and cards fetched before migration 0071, and copies
  made from them within the 14-day reuse, never trend. A link trends while one of its 8 newest public cards is
  appropriate for trends (Mastodon's `PreviewCard#appropriate_for_trends?`: an article link with a title, a description,
  a provider name and an image, here a stored one, in a supported language, on a public original); the newest such card
  whose title, description and provider name present as text is the one shown, and a link none of whose cards presents
  is not listed; a link whose stored texts were imported malformed can take one of the 400 candidate places without
  being shown. Its `history` counts at most its 200 newest public posts of the 7 days and 200 of their boosts (20 per
  post), so it may undercount. The hashtags' list rules above (the caps, offsets, `limit=0`, reviews and e-mail) apply
  to links too, and links are ordered by `Accept-Language`; a link's review is its own, else its publisher's by the
  longest reviewed domain suffix (no `trendable_by_default`, as Mastodon). `GET /api/v1/timelines/link` answers for a
  link listed and allowed now, as Mastodon's; while trends are off it answers 404 at once (Mastodon keeps serving it
  until its trends are cleared), and the next round clears link trends. It shows the public posts whose card has the
  link as its URL after redirects, each page read from a window of the link's public cards (an empty page cut at its
  window links on, as Kopje's other timelines); `local` and `remote` are not read, since Mastodon reads them only to
  require a user when a topic feed is not public. Its answer may be cached publicly only when no token was sent: as
  Mastodon, any request with an `Authorization` header gets a private answer (WEB-7). Accepted, 2026-10-20; the link
  rules, 2026-10-24.
- **MD-6: Media have no short link.** MediaAttachment `text_url` is always null. Mastodon shows it only for a local
  attachment with a shortcode, and has assigned no shortcode to new media since v3.5.0, so only its older local media
  show one; Kopje assigns none and serves no short link route. Accepted, 2026-10-22.
- **MD-7: Mastodon's web app API and FASP are not served.** `/api/web/*` (the settings, embeds and push subscriptions
  of Mastodon's web app) and `/api/fasp/*` (the registration, data sharing and debug callbacks of Fediverse Auxiliary
  Service Providers) answer 404. Kopje has no Mastodon web app: its pages are its own ([web-pages.md](web-pages.md)),
  and clients use `/api/v1/push/subscription` and `/api/oembed`. Kopje uses no FASP for search or discovery.
  Accepted, 2026-11-15.
- **MD-8: Streaming is WebSocket only.** Kopje serves the streaming API at `/api/v1/streaming` and any path below it as
  a WebSocket only: a request that is not an upgrade answers 404, so Server-Sent Events are not served. The one
  exception is `/api/v1/streaming/health`, which answers 200 `OK` as Mastodon's streaming server does. The token is read
  from the `Authorization` header or `Sec-WebSocket-Protocol`, never from the `access_token` query parameter
  (`src/mastodon/streaming.ts`). Mastodon's streaming server serves SSE and reads the query token too. From v4.5.11 to
  v4.7.5 it changed how it parses the request URL and how it ends an SSE heartbeat, and nothing a WebSocket client sees.
  No surveyed client uses SSE, and a token in a URL would reach the platform's invocation logs wherever they are enabled
  without query-string redaction; the shipped configuration records neither (DATA-5 in
  [threat-model.md](threat-model.md)). Accepted, 2026-11-15.
- **MD-9: Annual reports have no share page.** An annual report's `share_url` is always null, and Kopje serves no
  `/@:username/wrapstodon/:year/:share_key` page. No notification carries an `annual_report`: Mastodon 4.7.5 writes
  none, and Kopje has none from earlier versions. Accepted, 2026-11-15.

## Differences the checks cannot see

Profile credentials (`PATCH /api/v1/accounts/update_credentials`, `GET`, `PATCH` and `PUT /api/v1/profile`, the
settings page):

- `avatar` and `header` are multipart files; on the API routes they may also be a base64 data URI
  (`data:<type>;base64,…`) in a JSON, urlencoded, multipart text or query value, decoded as Paperclip decodes it. Any
  other non-empty text value answers 400 (Paperclip has no handler for it); an empty value reads as absent. Each image
  must be under 8 MB (8,388,608 bytes is refused) and JPEG, PNG, GIF or WebP by its signature, whatever type a data URI
  declares; AVIF is refused. The multipart body may be 17,858,560 bytes (two files and their part headers beside the
  text). A urlencoded or multipart form's text and the query share 1 MiB in UTF-8 bytes; a JSON body has its own 1 MiB,
  beside which (as beside any other body type) the query is bounded by Workers' 16 KB URL limit. An otherwise
  parseable request past its bound answers 413 (within the raw body limit, a form whose parameter shapes conflict
  answers 400 before the text is counted), so a data
  URI's image is at most about 786,000 bytes, where Mastodon takes one under 8 MB; a larger image is sent as a
  multipart file.
- An image past 33,177,600 pixels answers 422, an error of `avatar` or `header` (Mastodon keeps the account unchanged
  and answers 200). A GIF has no separate limit of 921,600 pixels, which in Mastodon bounds its own conversion of a
  GIF.
- An avatar is cropped to 400×400 around its centre and a smaller one enlarged, as Mastodon's, a GIF too: a 600×300
  GIF is 400×400 here and 200×200 in Mastodon, whose GIF path never enlarges. A header past 750,000 pixels is scaled
  down into a square whose side is the long edge of Mastodon's box, so an Exif-rotated image is boxed the same way;
  the result matches Mastodon's up to a pixel of rounding (896×864 is 882×851 here, 881×850 in Mastodon). Every image
  keeps within 3,840 px on its long edge, which Mastodon's box does not: 8000×50 is 3840×24 here and 8000×50 in
  Mastodon, 8000×200 is 3840×96 here and 5477×137 in Mastodon. When Cloudflare Images returns an animation's full
  image in another type or not of that shape, it is made again as a still of that shape.
- For an uploaded header whose served file is animated, `header_static` is a still of at most 640 px on the long edge
  (the upload's preview), where Mastodon's is the GIF's own size, and only for a GIF (a 1200×700 GIF header's is
  at most 640 px wide here, its height as Images rounds it, and 1200×700 in Mastodon). An animated avatar's
  `avatar_static` is a 400×400 still, as Mastodon's. Otherwise they equal `avatar` and `header`.
- A local animated WebP stays animated in `avatar` and `header` when the full image Images returns is an animated
  WebP of its shape, where Mastodon flattens it to one frame. A still WebP of that shape is kept as a still, and
  output of another type or shape is made again as a still (above). An APNG is served as a still PNG, as Images
  makes animated output only as GIF or WebP.
- A remote account's `avatar` and `header` are Kopje's cached copy on the instance's own origin (`/media/r/…`) once the
  cron has fetched it, and the remote URL until then or when no copy can be made, where Mastodon shows its own copy or
  `missing.png`; while a domain block with `reject_media` rules the account's stored domain, both are the default
  images, as Mastodon's (Media, below). A copy is the remote file's own bytes with their metadata stripped, never
  converted, cropped or resized. Only JPEG, PNG, GIF and WebP below 2 MiB are cached (Mastodon takes 8 MB), from https
  URLs, at most 16,777,216 pixels and with no rotation or mirroring in their metadata; anything else (AVIF, HEIC, SVG)
  keeps its remote URL. `avatar_static` and `header_static` are a still remuxed from the cached file, within 2 MiB: an
  animated GIF's or WebP's first frame (the WebP frame without its background colour) and an APNG's default image, the
  cached file itself when it is still or no still can be made; Mastodon makes a still for a GIF or an image it converts.
  Without a cached copy they equal the remote URLs. The cache's bytes are capped by `REMOTE_MEDIA_CACHE_BYTES` (default
  4 GiB), and a profile image is kept while its account shows it. A suspended account's copies are deleted, where
  Mastodon keeps them private.
- A remote account's `avatar`, `header`, `avatar_description` and `header_description` are read from its actor's
  `icon` and `image` as Mastodon 4.7 reads them (`process_account_service.rb:354-379`: the first value; an embedded
  `Image`'s `url` and its `summary` else its `name`; any other object's `href` and no description), but a description
  is cut at 150 code points, where Mastodon keeps 10,000 (`process_account_service.rb:368`). Every description Mastodon
  writes is within 150, its limit for a local account, and an account is embedded in nearly every answer (a
  conversation shows 14, a boosted quote 3), so 10,000 would put one conversation past the 8 MiB answer budget and a
  timeline's heap past half the isolate's memory. An image given by reference rather than embedded is not fetched, so
  the account has neither the image nor its description; Mastodon fetches it. A value Mastodon cannot read (a numeric
  `@value`) is none, where Mastodon fails the document. Accepted, 2026-11-15.
- A remote actor document is read as Mastodon 4.7 reads it, each member by its literal spelling, except that Fedify
  parses the members Kopje reads from its object (`FEDIFY_MEMBERS` in `src/federation/remote-actor.ts`: the id, type,
  username, inbox, name, bio, `movedTo`, `alsoKnownAs` and the keys) after JSON-LD expansion. Every other member, in any
  spelling, is read by spelling or not at all, so none refuses the actor. Mastodon stores the account in two cases where
  Kopje refuses the actor, because Fedify cannot decode a member it parses: a `publicKey` typed otherwise than a key,
  and a member the inventory keeps whose name the document's own context maps to another member's IRI (`name` mapped to
  `icon` and holding a `Document`). A name or bio given only as `nameMap` or `summaryMap` is not read, as Mastodon reads
  only `name` and `summary`.
- A remote actor's `manuallyApprovesFollowers`, `discoverable` and `indexable` are read by spelling as Mastodon 4.7.5
  assigns them, `@json[name] || false` through ActiveModel's boolean cast (`process_account_service.rb:252-256`;
  `test/fixtures/actor-booleans.json` holds its cast of each value), with two differences. An empty string, which the
  cast makes nil, leaves the stored `locked` and `indexable` as they are (false for a new account), stores no
  `discoverable` and stores the rest of the document, where Mastodon's `NOT NULL` `locked` and `indexable` refuse the
  account's save and nothing of the document is stored. A float zero (`0.0`, `0e0`) is false, where Mastodon's Float
  is true, as `JSON.parse` does not tell it from `0`. A remote account stored by an earlier release keeps the flags it
  was read with until its actor document is stored again: when Kopje fetches it (a search, a mention, a key refresh),
  when the actor delivers an `Update(Person)`, or when a status is fetched by an account whose document is 24 hours
  old or more (`ACCOUNT_STALE_MS`). Accepted, 2026-11-17.
- A remote account's profile URL is chosen from its actor's `url` as Mastodon 4.7.5 chooses it
  (`process_account_service.rb:454-465`, `json_ld_helper.rb:46-61`): one candidate, kept only when it begins with
  `http://` or `https://` and is on the actor id's host, whatever its scheme and port, and no later candidate once it is
  refused; an account without one shows its actor id. Kopje compares hosts as the URL parser reads them, where Mastodon
  compares Addressable's raw host ASCII case-insensitively, so a host spelled with a percent escape, in Unicode where
  the id's is in punycode or the reverse, or with non-ASCII capitals is kept where Mastodon keeps none; a URL the URL
  parser does not read (a port past 65535) or past 2,048 bytes once serialized is none, where Mastodon stores it; a kept
  URL is stored as the URL parser serializes it. Where Mastodon raises and stores no account (a `url` that is a number
  or `true`, a `Link` whose `href` is neither a string nor null, an array that reaches a value neither a `Link` nor a
  string before the one it takes, a URL Addressable cannot parse), Kopje stores the account with no profile URL, or with
  the URL parser's reading of the URL (a tab in the host, which it drops). `test/fixtures/profile-url/urls.json` holds
  Mastodon's answer for each form. A stored profile URL Kopje does not show, which only an import holds (one that is not
  http(s), where Mastodon's `url_for` gives none, or one past 2,048 bytes once serialized, where it gives the URL),
  gives the actor id instead in mentions, announcements, notification fallbacks and the link-card mention test, as the
  account shows it, and a link to that stored URL is an ordinary link; an actor id that is not http(s), or past 2,048
  bytes as JSON writes it, shows a `/@username` page instead, as for a local account, where Mastodon shows the id.
  Accepted, 2026-11-17.
- A new remote account's `created_at` is its actor's `published` as Mastodon assigns it
  (`process_account_service.rb:231`, ActiveRecord's time-zone-aware cast in UTC) on the forms `railsTime` in
  `src/federation/json-shapes.ts` reads: a date, then optionally a time, its seconds and fraction, and a zone (`Z`,
  `±HH`, `±HHMM` or `±HH:MM`), with a day past the month's end rolled over (`2021-02-29` is 1 March), `24:00` the next
  midnight and second 60 the next minute, and a day 31 of a shorter month that the offset carries into the next day the
  last day of the month before, as Ruby's `Time.new` stores it (`2020-04-31T23:59:60-00:01` is 31 March); the fraction
  is cut to milliseconds, where Mastodon keeps microseconds. Any other value is none and the account is created at the
  Store's time, a value past 128 characters included, where Mastodon fails the actor: its first save stores the row,
  then the update every resolve runs (`process_account_service.rb:77,219`) writes nil into the `NOT NULL` column, so the
  resolve answers 500 and leaves a row with no name or key. Accepted, 2026-11-17. Mastodon reads more forms and stores
  their time where Kopje stores its own: day-first and named dates, compact and one-digit fields, signed, longer or `BC`
  years, text after the date or time, week and ordinal dates (read against the current day), an hour alone, `infinity`,
  zone names and offsets it ignores or reads otherwise, a zone after a date alone, a `.` with no digits or a fraction
  after the minutes (ignored), other spacing, and a JSON number as it is (`test/fixtures/rails-time.json` lists each
  form with Mastodon's value). A known account's `created_at` stays the first one Kopje stored and is never later than
  the time it was stored, where Mastodon assigns `published` on every update, a future time included; so an update whose
  `published` it cannot cast is applied here, where Mastodon writes nil into the `NOT NULL` column and drops the update.
- A remote account's `show_featured`, `show_media` and `show_media_replies` change only when its actor's
  `showFeatured`, `showMedia` or `showRepliesInMedia` is a JSON boolean, and keep their stored values otherwise, as
  when the key is absent (`process_account_service.rb:258-260`). Mastodon casts any other value as a form value (a
  non-empty string other than a false value is true) and fails the document on `null` and on an empty string, which
  casts to `nil`.
- Images uploaded before still renditions were made keep `avatar_static` and `header_static` equal to the image until
  they are replaced, unless `kopje-admin media-rebuild` makes their missing files, which sets an animated one's still.
- The `preview_url` of an animated upload (status media included) is a still.
- `indexable` decides whether a status text search with `account_id` reaches the account's public statuses outside the
  viewer's own posts and interactions, as Mastodon's public index does; the interactions are those of Mastodon's
  `searchable_by` (kept boosts, favourites, bookmarks, active mentions, and votes in the poll's current generation). A
  search with `account_id` of another account takes as candidates, per request, the account's newest 2,500 originals and
  the viewer's newest 2,500 boosts, favourites, bookmarks and mentions, each within the request's `max_id` and `min_id`,
  and the polls of the viewer's newest 2,500 vote rows, taken before `max_id` and `min_id` apply; it keeps those the
  viewer may search and pages them by offset. A status outside every candidate window of the requests a client makes is
  not found, where Mastodon's index finds it. For example, an indexable account has a public status S and an older
  public status T the viewer favourited, then 2,500 newer matching posts the viewer may see but never interacted with:
  those fill the account's window, so the first page holds T alone (found through the viewer's favourites); paging with
  `max_id=T` passes S, and `min_id=T` or `offset=1` returns nothing. Before this change, a client reached S by paging
  through those newer posts, which were results. Separately, Kopje answers no page past an offset of 10,000
  (`MAX_SEARCH_OFFSET`), so a candidate further down is beyond the pages a client may request; 10,001 eligible hits
  alone lose nothing, since an offset of 10,000 still returns up to `limit` of them. A search without `account_id` reads
  the viewer's own posts and interactions only, never the public statuses of indexable accounts. It includes statuses
  the viewer is only addressed in (silent mentions), which Mastodon leaves out, and it does not include polls the viewer
  voted in, which Mastodon includes.
- An attribution domain (`attribution_domains[]`) whose written form passes 1,020 UTF-8 bytes is refused as not a valid
  domain name. As in Mastodon, a label of 64 or more characters as written is refused, even of characters IDNA ignores
  (U+00AD), so only a host padded in many labels is that long; Mastodon accepts such a host up to about 128 labels of
  padding. Domains and lists past the presented bounds, whether saved before this check or imported, stay stored and
  are hidden from `source.attribution_domains` and the actor's `attributionDomains`: an entry whose JSON string passes
  1,022 bytes is left out, and a list past 102,302 bytes in all (100 such domains pass it) is shown as none. Accepted,
  2026-11-15.
- A refusal lists at most 100 invalid attribution domains, in `error` and in `details`, before the count's error;
  Mastodon lists every one. Each listed domain is written twice, so the cap bounds the answer (`test/accounts.test.ts`
  derives its maximum). Accepted, 2026-11-16.
- An unknown `source[privacy]`, `source[quote_policy]` or `source[language]` is refused with 422, an error of
  `privacy`, `quote_policy` or `language` after the account's own, and nothing is saved; Mastodon saves the account's
  other changes and answers 500. Accepted, 2026-11-16.
- A JSON `true` or `false` sent as a text parameter (`display_name`, `note`, `avatar_description`,
  `header_description`, an `attribution_domains[]` entry, a field's `name` or `value`) is stored and shown as `true` or
  `false`, as Kopje reads every JSON scalar where it expects text (a number as JSON writes it, as Mastodon stores a
  number it casts to text too); Mastodon casts a boolean to `t` or `f`, and leaves a field whose name or value is not
  a string out of every read. Either is a client's error, `true` is what the client sent, and every text parameter
  reads JSON the same way. Accepted, 2026-11-16.
- A bio (`note`) longer than 10,000 UTF-16 code units as sent is refused as too long before it is counted, as a post's
  text is (`MAX_RAW_LENGTH`); Mastodon counts each link as 23 characters whatever its length, so it accepts a longer
  bio of long links. Which runs of a bio count as links is linkify-it's, as for posts: a link right after `#` or `@`
  counts as 23, where Mastodon's pattern reads no link there. Accepted, 2026-11-16.
- A bio that is only whitespace once stripped (Rails' `blank?`, Unicode spaces included) is stored empty, so its
  `source.note` is `''`, where Mastodon gives the whitespace back; its `note` is `''` in both. Kopje stores the bio
  once, as the HTML it presents and federates, so `source.note` gives line breaks as `\n` and one blank line between
  paragraphs, where Mastodon gives the bio back as sent (`\r\n` kept), and `note` writes a line break `<br>`, where
  Mastodon writes `<br />`; the text and paragraphs are the same. Accepted, 2026-11-16.
- A profile change sends an `Update(Person)` only when the published actor document changed, where Mastodon sends one
  after every update (`ActivityPub::UpdateDistributionWorker`, `credentials_controller.rb:17`,
  `profiles_controller.rb:16`). An image description is published only on its image (the actor's `icon` and `image`, as
  `ActivityPub::ActorSerializer` writes them), so a description changed while the image is absent sends none; followers
  get it with the image's next Update.
- The Profile's `featured_tags` are the account's first 10 featured hashtags in the order they were featured, as
  Kopje's writers keep at most 10; Mastodon lists every one of the association, in no stated order. Only an imported
  account can have more, and its others stay listed by `GET /api/v1/featured_tags`.
- Unlocking accepts the pending follow requests in job rounds after the response, at most 20 per round (the 5-minute
  cron resumes them); relocking stops it. Requests from an unavailable requester, or one the account or its blocked
  domains cover, stay pending.
- While a media rebuild holds its lease, a profile edit answers 503, since replacing an image dooms the upload behind
  it.
- Field verification (`fields[].verified_at`, local accounts only) runs in the 5-minute cron's round after a save,
  not at once as Mastodon queues it, one account per round, and checks of an account are at least 5 minutes apart: a
  save during a check waits for its end. A check that ran and did not verify a value is retried only after the next
  save, as in Mastodon; values a round could not check (its time or budget ran out, or a domain policy could not be
  read) are checked by the next claim after 5 minutes, without checking again those it checked; one whose round died
  is retried once after 5 minutes, from the values it had not recorded. A suspension drops a pending check; a
  request already under way for it may still be sent, and records nothing.
- A value is checked only when it is printable ASCII of at most 255 bytes, `https` with no userinfo, the default port
  (or `:443`), a host of lowercase letters, digits, `_` and `-` labels of at most 63 characters, and a path with no `%`
  and no dot segment (Mastodon's `verifiable?` also accepts other ports, percent-encoded paths, IPv6 literals and
  more: `test/field-verification.test.ts` lists them). Redirects and the HEAD probe use the default port only; literal
  IPs, local and single-label names, and hosts the instance's domain policy refuses are never contacted.
- Only a 200 `text/html` or `application/xhtml+xml` page whose Content-Encoding is absent, `identity`, `gzip` or `br`
  is read, exactly its first 1 MiB after decoding (Mastodon reads to the end of the chunk that crosses 1 MiB), decoded
  by its BOM, its Content-Type charset, a meta prescan, then UTF-8. No rel=me is found after a `<select>` or `<math>`
  start tag, after an `<svg>` that holds anything but plain shapes (`<path>`, `<g>`, `<rect>` and the like) and a text
  `<title>` or `<desc>`, or that is not closed by its own `</svg>`, after a `<noscript>` that holds anything but text
  and plainly written images, links, iframes, styles and simple elements (a comment, an unlisted tag, a rel=me link, an
  unfinished tag, NUL, or more than 4,096 characters), inside a `<template>` or after a template that held one, held a
  table-structure element (`<col>`, `<tr>`, `<td>` and the like) or was not closed by its own `</template>`, or at or
  after an `<a>` or `<link>` whose rel passes 2,048 characters, and none in a page with `<frameset`
  (`src/platform/html-scan.ts` states the rules); a page with such markup before its rel=me links does not verify where
  Mastodon's does. The first rel=me is not HEADed when its href is relative or passes 2,048 characters, or when a rel=me
  came after a `<table>` start tag, where a link misplaced in the table can come first in Mastodon's reading: such a
  page verifies only by a link back among its rel=me hrefs.
- Converted or imported fields past 16 KiB of JSON or 4 entries are never verified.
- Remote accounts' fields are checked in the same 5-minute round, after local accounts, not after Mastodon's random
  0–599 s delay; at most one claim per account per 5 minutes. Only the first 4 shown fields whose value is a link are
  tracked and shown verified, of the 16 shown (Mastodon checks up to 50). A field is a candidate only when the actor's
  `attachment` is an array and its `type` exactly `PropertyValue` (Mastodon's `property_values`), and its original
  value, of at most 2,047 bytes with no NUL, is one lowercase `<a>` with double-quoted, distinct attributes separated by
  HTML whitespace, text and `<span>`s of text only, no character reference but `&amp;`, whose href (at most 1,016 bytes
  of printable ASCII, none of ``"<>\^`{|}``) equals its text and passes the local rule above
  (`test/field-verification.test.ts` lists what Mastodon accepts beyond this).
- A remote verified time is kept while the href and the link back stay, where Mastodon re-verifies at every processing
  of the account (so a revoked rel=me goes unnoticed until the href or the profile URL changes); an unverified link is
  checked again at a store at most once a day; a pending check expires after a day; accounts stored before the
  upgrade are checked at their next store. For an account that is not suspended, Mastodon's `only_key` refresh (a key
  refetch) replaces its fields, dropping their times, and schedules no check; Kopje has no such refresh, every store
  of the document arms its links as above. A suspended account's document updates its inboxes only, in Kopje and in
  Mastodon alike, so its fields and their times stay as they were.
- The link back is the stored, WHATWG-serialized profile URL when it is on the actor id's host (else the actor id), and
  is compared with rel=me hrefs lowercasing ASCII only, where Mastodon compares the document's raw string with Ruby's
  Unicode `downcase`; so Kopje's verified set is not a strict subset of Mastodon's (a profile URL written
  `https://actor.example` matches a backlink to `https://actor.example/`).
- A verified remote value shows the shortened link Kopje writes for local text: 30 characters shown, where Mastodon
  shows 31 when the hidden rest would be one character, and `rel="nofollow noopener noreferrer"` without
  `translate="no"`.

Link previews (a status's `card`, Mastodon's `FetchLinkCardService`):

- `embed_url` is always `''` (a privacy choice: it names a third-party media URL, which Mastodon's web client never
  reads).
- `authors[].account` is always null, where Mastodon shows the account a page's `fediverse:creator` names when that
  account's attribution domains cover the page's host. An Account in every status's card would take the status lists
  past their answer budgets (RES-3), and Kopje stores neither the handle nor remote accounts' attribution domains.
  Clients lose only the card's link to the author's profile. Accepted, 2026-10-23.
- `missing_attribution` is `true` only for the local account a page's `fediverse:creator` names directly: by its
  username alone or with the instance's domain (in any ASCII case, with one trailing `/`). A creator naming the
  instance by another spelling (the Unicode form of its domain, an explicit port) or by an alias domain names no
  account, so the card's `missing_attribution` is `false` for everyone, where Mastodon's WebFinger lookup may resolve
  such a name to the local account.
- A quoted status (a status's `quote.quoted_status`) shows no card, where Mastodon's `ShallowStatusSerializer` shows
  it, so a status with its quote stays within the answer budgets (RES-3); the quoted status's own read shows it.
- A local status's Note lists its card as a FEP-8967 `Link` after its media, as Mastodon 4.7 does, only where the API
  shows the card (a public or unlisted status, the card fetched, its title not blank), so a Note of another visibility
  lists none, where Mastodon lists the card it fetched for any visibility.
- Only public and unlisted originals get a card, a privacy choice: Mastodon fetches the link of every visibility,
  which tells the linked site that the instance holds the post. A status with a shown attachment or any quote, a boost,
  and one whose author is unavailable get none.
- A remote status's link is its first `Link` attachment (an `attachment` with a non-blank `href`) whose `href` is an
  `http(s)` URL with an authority (`https://`), as Mastodon 4.7 reads FEP-8967: one of another scheme, without an
  authority (`https:b.example`) or with an empty one that ends the `href` or precedes a query or fragment
  (`https://?x`), whatever its length, or one that does not parse is skipped; one with an empty authority before a
  path (`https:///b`) is taken and gives no card; one whose `href` is not a string is skipped, where Mastodon fails the
  activity. A `Link` naming a mentioned account's URL or the instance is taken, as Mastodon takes it. Only without one
  is the link the first of its first 16 anchors that is not a hashtag's (`rel` holding `tag`), a microformats one
  (`class` holding `u-url` or `h-card`), a mentioned account's URL, relative, of another scheme or the instance's own
  (by host and non-default port); anchors inside the elements the sanitizer drops whole are not seen. A local status's
  is the first `http(s)` link of its text that is not the instance's. That link is final: when it is
  `http`, has a port, names an IP literal or a local name, passes 2,048 characters, holds a character outside printable
  ASCII or one of ``"<>\^`{|}``, or does not parse, there is no card (Mastodon fetches `http` links and other ports).
  Hosts the domain policy refuses are never contacted, after any redirect either.
- The mention test starts from the anchor, so it sees every mention a converted or imported status keeps: a local
  account by its username, a remote one by its actor id or by its stored url, compared in its stored spelling as
  Mastodon compares it. Of the remote accounts that store one url, it reads the first 200 in the order of their rows,
  so an anchor naming the url of a mentioned account past them is an ordinary link, where Mastodon skips it. A url is
  now stored only on its actor's host, so a host would have to give more than 200 of its own actors one url; until
  each account is stored again, though, a url an earlier release stored or a dump imported may name another host, and
  such rows count toward the 200 too. Accepted, 2026-11-17.
- Fetched by a round of the 5-minute cron, at most 6 a round (3 at a time), not within a minute as Mastodon queues
  them; a link still unfetched a day after its post is dropped. A claim the round could not run (its budget, its
  deadline, a policy read that failed) is tried again; one that never finished is retried once, then dropped.
- Read through the web-page sink (NET-3): `Accept-Language: en, *;q=0.5`, exactly the first 1 MiB of a 200
  `text/html` or `application/xhtml+xml` page (Mastodon reads to the end of the chunk that crosses it). The scan keeps
  at most 128 metas and 4 JSON-LD scripts of 32,768 characters each, values of at most 2,048 characters, and the first
  HTML `<title>` anywhere (Mastodon reads head's). No canonical URL.
- oEmbed, as Mastodon tries it before OpenGraph, in at most two GET chains a claim (up to eight HTTP GETs, each chain
  at most 3 redirects): a page then the endpoint it declares, or a host's cached endpoint then the page for OpenGraph
  only. Mastodon fetches the cached endpoint again after it fails (a reused service object); Kopje never fetches a
  further endpoint there, even another one the page declares.
- A card from a host's cached endpoint is kept without fetching the page. Mastodon fetches the page after a cached
  endpoint succeeds too (its `unless html.nil?` runs first), so a transport failure of that page throws away its cached
  result there and gives no card.
- Discovery reads JSON endpoints only (`application/json+oembed` or `text/json+oembed`; no XML), among the page's first
  64 `<link>` elements. An `http` endpoint is upgraded to `https` as Mastodon does; one of another scheme, with a port,
  an IP literal or a local name is not tried (the page's OpenGraph is the card), where Mastodon tries it.
- An endpoint's answer is read whole within 64 KiB (Mastodon: 1 MiB; a longer one is no card), as UTF-8 by
  JavaScript's `JSON.parse` (Mastodon: Ruby's), within 10,000 values and 32 levels (past them, OpenGraph); a `version`
  of the number `1` passes as `1.0` does (`JSON.parse` cannot tell them apart). The User-Agent is the cards' own, with
  " Bot".
- A `type` that is not a string, and a `title`, `author_name` or `provider_name` that is not one, are no card and `''`
  where Rails would cast them; an oEmbed card with a blank title falls back to OpenGraph, where Mastodon saves it. A
  `twitter:player` page with a blank title is no card, where Mastodon saves one with its html.
- `width` and `height` (oEmbed's top-level ones, OpenGraph's `twitter:player:width` and `:height`) are a JSON integer
  or a string of one to five digits within 0 to 65,535, else 0, where Rails casts more forms and has no ceiling.
- A video's `html` is Kopje's fixed template, the twitter:player iframe as Mastodon's serializer sanitizes it
  (`allowfullscreen`, `scrolling` and `frameborder` forced, the sandbox added, a width or height omitted when the
  iframe has none or one past the same rule), from the src alone: an oEmbed `html` must hold exactly one iframe and no
  other `audio`, `video` or `source` (text around it is dropped; htmlparser2 reads it, not Nokogiri), and its src, like
  a player's, must be an absolute `http(s)` URL of at most 512 bytes (and 512 once `&` is escaped) without a refused
  character. A video without such an iframe is a `link` card with the same fields.
- A card's image (`og:image`, an oEmbed `link` or `video` card's `thumbnail_url`, a `photo` card's `url`) is fetched
  only from an `https` URL that passes the same URL rules as the link (Mastodon fetches `http` too), with a final
  `200` only (Mastodon reads any `2xx`); `image_description` is `og:image:alt` (`''` for oEmbed), shown with or without
  an image. Images are off by default and fetched by a round of the 5-minute cron, at most 3 a round, one at a time;
  the month's starts are capped by `IMAGES_CARD_MONTHLY_TRANSFORMS` (attempts, not stored images: each image charges
  one before its WebP and one before the RGBA its blurhash is computed from, which Images may bill as one
  transformation; a start whose output is refused still counts).
- The image is read below 8 MiB (as Mastodon), of JPEG, PNG, GIF or WebP by its signature (AVIF is refused), within
  16,777,216 pixels (921,600 for a GIF; Mastodon allows 33,177,600) and 65,535 pixels an edge, then re-encoded once by
  Images to a still WebP without any metadata, ICC profile included, of at most 512 KiB (a larger output is no image).
  Mastodon keeps a small image that is not a GIF as fetched, resizes a larger one in its own format keeping the ICC
  profile, and turns a GIF into JPEG.
- An image of more than 230,400 pixels is resized to fit a square of `floor(sqrt(230400 × L / S))` for its long edge L
  and short edge S, its aspect kept: Images turns the image by its Exif orientation before it resizes, and a square
  bounds the long edge either way. Mastodon rounds each edge, so Kopje's long edge is at most one pixel shorter
  (1,200 × 500 asks for 743 × 743 and is stored at 743 × 310, where Mastodon's is 744 × 310). A `link` card with an
  image takes the image's size, as Mastodon's does.
- The blurhash (4 × 4 components, alpha dropped) is computed from the image fitted within 100 pixels by area
  averaging, where vips resamples; when Images' RGBA output of it fails or is not of the image's size, or the month's
  share ran out between its two outputs, the card keeps its image without a blurhash (null), where Mastodon drops the
  image or fails the job; a claim given up at its deadline or one whose fence was lost is not stored.
- A stored image is reused by another card of the same image URL within 14 days of being stored, then fetched again
  (close to Mastodon, which downloads it again whenever it processes the card after 14 days); it is kept while any
  card names it. A card copied from another status whose image failed is fetched again (Mastodon's `missing_image?`).
- The endpoint cache holds at most 2,048 hosts (a new host past them is not cached), for 24 hours from when the page
  declared it; a failed cached endpoint does not renew it.
- JSON-LD shapes Mastodon fails on or reads oddly (an `@type` that is an array, a number in the root array, a string
  author read as a substring) are skipped; a language-tagged `headline` or `description` is read as its `@value`, as
  Mastodon does, and a value that is not a string, such an `@value` included, reads as absent; times are read as ISO
  8601 only, an offset past 23 hours or 59 minutes refused. The texts' second decoding follows HTMLEntities (a numeric
  reference to its code point, a double-escaped NUL then removed), but keeps a reference to a surrogate or past
  U+10FFFF as written, where Mastodon raises, and reads names by the HTML5 table. The texts are cut to their bounds,
  Kopje's own (Mastodon bounds only the url): a title of 512 JSON-escaped UTF-8 bytes, a description of 1,024, an
  author or provider name of 512 each; an author or provider URL past 1,024 bytes or with a refused character is
  dropped (`''`).
- A failure attaches nothing, where Mastodon may attach an older card of a redirect's or canonical URL.
- Each status keeps its own copy: a status that links a URL another status fetched within 14 days copies that card
  without a request, but a later fetch does not update earlier copies, and an edit that keeps the URL fetches it again
  unless another status holds a fresh copy. The edits that reset a card are Mastodon's: a local edit that changes the
  text, and a remote update that is significant, which a change of the `Link` attachments or of the quote alone is not
  (`process_status_update_service.rb` judges significance before it reads the quote).

Accounts (the `Account` and credential account entities):

- A local account's fields (in the `Account`, `source.fields` and the actor's attachments) are, among its first 4
  stored entries, those that are a name and a value of strings within 255 code points each, in their order; a stored
  value past 16 KiB of JSON, or one that is not a JSON array, shows none. Mastodon presents every stored field.
  Kopje's own writer stores at most 4 within those limits, so only a converted or imported row can differ.
- A remote account shows at most its first 16 fields, within 32 KiB of names and values as presented, each name cut at
  255 UTF-16 code units and each value at 4,096 before it is sanitized (`remoteAttachmentSql` in
  `src/domain/account-columns.ts`); Mastodon keeps 50 and cuts each at 2,047 characters. Each name and value is
  stripped as Ruby's `strip` strips it, as Mastodon's `Account::Field` does, but after Kopje's cut where Mastodon
  strips first, so a name or value whose leading whitespace pushes its text past the cut keeps less of it.
- `noindex` is `false` for every local account, Mastodon's default: no setting stores it, and the profile and status
  pages do not ask search engines to skip them. A remote account shows none, as in Mastodon.
- `roles` of a local account is the OAuth admin's Owner role (`id`, `name` and `color`) while that account is
  available, otherwise `[]`: Kopje has no other role to highlight. A remote account shows none, as in Mastodon.
- `uri` is `''` for an imported actor id whose JSON passes 2,048 bytes; ingestion stores none.
- An account whose handle another account has taken (its stored username is `! <id>`, as Mastodon's
  `invalidate_username!` writes it) shows `invalid_handle`, its id as `username` and `<id>@handle.invalid` as `acct`,
  as Mastodon 4.7 does, and `GET /api/v1/accounts/lookup` finds it by that placeholder. No other address names it:
  lookup, an account search's exact match, a new post's mention and the web's featured hashtag page ignore
  `! <id>@<domain>`, where Mastodon's lookup matches the stored username as given (`Account.find_remote`,
  `finder_concern.rb:27-35`); an account search can still list it among its username-prefix and recent matches, by its
  search text. A search with `resolve=true` of `<id>@handle.invalid` answers as without `resolve`,
  where Mastodon's `ResolveAccountService` answers the account (`resolve_account_service.rb:31-34`). Its featured
  hashtags' URLs name it by the placeholder, which Kopje's web sends on to its profile; Mastodon's name its stored
  username.
- A remote account's handle is the one its actor document claims, its `webfinger` (FEP-2c59), else its
  `preferredUsername` at its host, once WebFinger confirms it for that actor, as Mastodon 4.7's
  `ProcessAccountService#check_webfinger!` does (threat model NET-4). Where Mastodon drops a whole document whose new
  handle it cannot confirm, Kopje keeps the stored handle and stores the rest of the document (profile, keys, inboxes,
  `movedTo`), as Mastodon's key-only refresh does (`process_account_service.rb:49-51`), so an unconfirmed rename never
  blocks a key rotation. A new actor id that confirms a handle another account holds gets an account of its own, and
  the holder's handle is invalidated (above); Mastodon moves the held account to the new id and has its local
  followers follow it again (`process_account_service.rb:53-55`). Kopje keys an account's identity, its revision fence
  (ID-1) and its tombstones (ID-7) by actor id, and a WebFinger answer alone does not move local follows to another
  actor: the old account keeps its followers, and a server that changes implementation can send `Move`. An invalidated
  account is refreshed as Mastodon's `AccountRefreshWorker` refreshes it, by a refetch of its document that the
  invalidation asks for, and a status fetched by it refetches it first however recently it was fetched; the refetches
  an invalidation asks for run at most once per account a day, where Mastodon bounds none, so two actors whose
  WebFinger answers alternate stop taking the handle from each other, the last one invalidated staying so until its
  own document, a search or the next day's invalidation refreshes it.
- A remote account's shared inbox is read as Mastodon 4.7.5 reads it (`endpoints.sharedInbox` when `endpoints` is an
  object, else the document's `sharedInbox`; an array's first value, an object's `id`; `process_account_service.rb:225`,
  `:235-245`) and kept only when it is spelled so that Kopje and Mastodon send to the same URL: lower-case `http` or
  `https` and `//`, a host of ASCII letters, digits and hyphens whose labels are not empty and whose last label begins
  with a letter, no userinfo, a port of 1 to 65535, a path of RFC 3986's `pchar` literals and upper-case `%HH` escapes
  below `%80` that encode no such literal, no dot segment, no query and no fragment (`sharedInboxUri` in
  `src/federation/remote-actor.ts`). Any other spelling is none and the account's personal inbox is used, where Mastodon
  delivers to its normalized form (`Addressable::URI#normalize`, `request.rb:97`, `:212-214`): a port `0`, a trailing
  dot in the host, a backslash, tab or line break in the path, an escape Mastodon decodes or re-cases, a query among
  them (`test/fixtures/shared-inbox/spellings.json` lists Mastodon's destination for each). Accepted, 2026-11-16.
- A remote account its `Delete` removes stays stored, unavailable (R1 in `docs/visibility.md`), while its purge runs;
  Mastodon destroys it after purging its content in the Delete handler (`app/services/delete_account_service.rb`).
  Meanwhile `GET /api/v1/accounts/:id`, every `/api/v1/accounts/:id/...` route and lookup answer 404 for it, and
  `GET /api/v1/accounts` and relationships leave it out whatever `with_suspended`, as Mastodon 4.7 answers for a
  deleted account (`without_requested_deletion`, `accounts_controller.rb:86-91`, `accounts/base_controller.rb:7`,
  `lookup_controller.rb:16`, `relationships_controller.rb:8-9`); nested in another entity it is shown redacted. Kopje's
  `identity_proofs` placeholder answers 404 for it too, as for an id that names no account, where Mastodon answers
  `[]` for any id.
- An actor whose own URI answers 410 to a fetch Kopje makes of it is deleted as by its `Delete`, as Mastodon's
  `FetchRemoteActorService` deletes a stored account on a 410 (`fetch_remote_actor_service.rb:21-24,46-54`); a 404 is
  not. Kopje follows same-origin redirects on an actor fetch where Mastodon follows none (`json_ld_helper.rb:242`), and
  deletes only on a 410 at the actor URI itself: a 410 at the end of a redirect deletes nothing. The 410 counts only
  under the Store revision read before that fetch (ID-1 in `docs/threat-model.md`), so a search by a URL first reads
  whether it is a stored actor's id, and resolves such a URL as that actor; the 410 of any other URL's probe, a
  status's included, deletes nothing.
- `last_status_at` is the publication date of the newest stored status that reaches followers, computed when read:
  deleting that status moves it back, where Mastodon 4.7.5 keeps the newest it counted (`account/counters.rb:53-75`).
- `moved` is the latest of two writes: every stored actor document sets it from its `movedTo` or clears it, and a
  verified `Move` sets it when Kopje first processes it; a replay of a known `Move` writes nothing. The member is read
  by its literal spelling, as Mastodon reads `@json['movedTo']` (`process_account_service.rb:293`), with no JSON-LD
  context applied (`namedMove` in `src/domain/collection-requests.ts`): a string, an array's first value, or an object's
  `id`, which must be an absolute `http:` or `https:` URI with an authority and without whitespace, a backslash, a
  control character or a `%` not followed by two hex digits, other than the actor's own id. Only the literal top-level
  `movedTo` key is read as a move, and it is not handed to Fedify; another key that a context maps to `as:movedTo` is
  not read as one. It names the stored account, local or remote, whose actor id is that URI without its fragment, as
  Mastodon looks up a remote account (`split('#').first`, `tag_manager.rb:300`), so a stored row whose id carries the
  fragment is never named; Mastodon recognizes a local account by its routes, and Kopje by its actor id alone. Mastodon
  fails the account's processing on an array or an object (a `TypeError`), where Kopje reads them. A relative, empty,
  compact (`as:foo`) or non-http value names none, as Mastodon finds no account for it; so do an `@id` object, a nested
  array and an array whose first value is not a string or an object, on which Mastodon fails, and a value with
  surrounding whitespace, which Mastodon does not verify. Kopje looks the URI up as the URL parser normalizes it (the
  scheme and host lowercased), where Mastodon looks up the spelling it was given. A move an earlier release stored from
  Fedify's reading of the same document (which resolved relative and empty values against the actor's id, read `@id` and
  nested arrays, applied the document's context, and kept the fragment) is recomputed only when the account's document
  is next stored: such a move can then clear, and a `movedTo` with a fragment or under a context that renames the member
  can then resolve. When a verified `Move` stores a remote target's fetched document, it does so before it moves the
  followers, so the target's own `movedTo` is read the same way, and decides whether the followers move (R21 in
  `docs/visibility.md`): a relative one no longer stops them, and one with a fragment naming a stored account now does.
  A `movedTo` naming an account Kopje does not know is fetched one hop after the document is stored, by the account's
  background collection sync (`src/federation/collections.ts`, the move part), where Mastodon fetches it while it
  processes the account (`process_account_service.rb:516-519`): until a round runs, `moved` is absent. Only an `https:`
  id on a public host, with no fragment and not on this instance, is fetched. The fetch is signed as the instance actor,
  as Mastodon's `FetchRemoteAccountService` signs it, follows no redirect, and takes the account only when its document
  spells its `id` exactly as that URL (`json['id'] == uri`, `json_ld_helper.rb:242-252`), names no `movedTo` of its own
  (Rails' `present?`, `fetch_remote_actor_service.rb:33`) and WebFinger confirms its handle; a destination that cannot
  be fetched for now is loaded once per read claim until the read is given up, and one refused or gone leaves `moved`
  absent until the source's document is stored again. An account stored by an earlier release resolves its destination
  only when its document is next stored. Mastodon processes a `Move` once per source account for 7 days (`move.rb:38`),
  Kopje once per activity id while its job is kept (30 days). Mastodon refreshes an account on a signature only after
  verification with the stored key fails (`signature_verification.rb:59-61`), and `possibly_stale?` chooses a full
  refresh or one of the key alone, which leaves `movedTo` as it was (`signature_verification.rb:123-127`,
  `process_account_service.rb:103`); Kopje stores every fresh document it fetches, its `movedTo` included, unless a
  newer store superseded it (below). A local account never has one: Kopje sends no `Move`. Followers move only on a
  verified `Move` whose target lists the source.
- An account that has moved cannot be followed: the follow API answers 403 `This action is not allowed`, also to change
  the options of an existing follow, after the 404 of an unavailable account, as Mastodon's `FollowService` does
  (`follow_service.rb:23-24,57`), and `/authorize_interaction` shows the follow refused. A move counts when `moved`
  shows its target, so an imported id naming no account, or a target whose domain passes 253 bytes, is no move. A `Move`
  whose target has itself moved leaves each follower on the source with its lists, as Mastodon's `UnfollowFollowWorker`
  does, and a follow request held for an account that has moved since is not sent while the move lasts.
- While an account's move is being resolved (its stored document names, as its `movedTo`, an account Kopje does not
  hold and may fetch, and its collection sync has not yet settled that fetch), following it answers 503 `Remote data
  could not be fetched`, also to change the options of an existing follow, after the 404 of an unavailable account and
  the 403 of a refused one; nothing is written, and the jobs round that resolves the move is asked for.
  `/authorize_interaction` shows the account as still being checked, and a held follow request to it is not sent until
  the move settles. Mastodon fetches the destination while it processes the account and answers the follow 200 or 403
  (`FetchRemoteAccountService`; its 503 with this body is a failed fetch, `error_handling.rb:22-24`). Once the move
  resolves, following answers 403; once it settles with nothing (the destination refused or gone, or the read given up
  `MAX_SYNC_ATTEMPTS` claims after its opening claim or its last progress), the follow is judged as for any
  account. The state lasts one read of the account's collection sync, so a fresh store of the account's document that
  still names an unresolved destination starts it again, and another request for the sync renews its attempts: a peer
  that keeps sending profile updates or collection changes while its destination keeps failing, or that stores its
  document again before each fetch of the destination completes (a fetch whose read was overtaken is not used), keeps
  the account in this state.
- A verified `Move` whose target's own move is being resolved moves no follower: the job is admitted covering none, and
  a batch after a first one moves none once the target's move is being resolved or set, so the followers left keep the
  source with its lists; the source's move is set and blocks and mutes are carried as for any `Move`. A new `Move`
  stores the target's document afresh, which can leave its move being resolved again. Mastodon fetches the destination
  while it processes the target, so when that destination proves gone or has itself moved, Mastodon finds no moved
  account and moves the followers to the target (`move_worker.rb`, `follow_service.rb:18`), where Kopje keeps them on
  the source (`test/inbox.test.ts`, "keeps the follower on the source when the target's destination then proves
  gone").
- A remote actor's document is stored only while the Store revision read before its fetch holds (ID-1 in
  `docs/threat-model.md`): a document fetched before another store of the actor committed is not stored. Mastodon
  serializes the processing of one account (`process_account_service.rb:30`) but stores whatever document it processes
  last (`process_account_service.rb:95-103`). So an `Update(Person)` whose document or fetch raced another store
  answers 503, having written nothing, and a retry is judged afresh; a `Move` whose target was stored meanwhile answers
  503 too; another activity, a stale-author refresh and a search resolution use the stored account.
- An `Update(Person)` applies the profile, the handle (confirmed by WebFinger when it changes) and `movedTo` of the
  actor it embeds, as Mastodon's `ProcessAccountService` does (`update.rb:23-27`), but not its keys or inboxes, which
  stay those of the last document Kopje fetched; Mastodon takes both from the embedded actor
  (`process_account_service.rb:222-232`, `:264-270`). A key rotation or inbox move sent only by `Update(Person)` applies
  at Kopje's next fetch of the actor's document, which nothing schedules: the actor's first activity signed by a key
  Kopje does not hold fresh (one it does not hold, one that fails, or one its last fetched document listed 24 hours ago
  or more), an `Update(Person)` that embeds no actor (its object the actor's URI, or not an actor), which is fetched
  whatever its key, a stale-author refresh, a search for the actor, or a collection sync's refresh of it. An actor that
  sends nothing keeps the old keys and inboxes until one of these happens (`test/inbox-actor-update.test.ts`, "an inbox
  move sent only by an embedded actor", "an Update(Person) that embeds no actor"). Reason: a holder of a still-trusted
  key could otherwise renew its trust and move the actor's deliveries without a fetch (ID-1 in `docs/threat-model.md`).
  An embedded actor Kopje cannot read applies nothing, as Mastodon drops it. An `Update(Person)` that carries an LD
  signature is read as received (Reading inbound activities, below): an embedded actor whose `inbox` is `[null]` is
  read, where Mastodon's reading makes it `[]` and drops the update. Accepted, 2026-11-16.
- The account `moved` nests is a bounded projection, not the full account: its identity, counts, flags, display
  settings and images, `note`, `avatar_description` and `header_description` `''` and `fields` `[]`, the display name
  cut at 100 code points, URLs and `uri` read as unset past 512 bytes, and only the emojis its display name references
  within 2,048 bytes of JSON; it never shows a `moved` of its own, as in Mastodon. A target whose domain passes 253
  bytes, or an id that names no account, shows no `moved`. Mastodon's web client stores a nested account as the
  target's own entity (`actions/importer/index.js:39-40`, which `reducers/accounts.ts` replaces), so it shows the target
  with an empty bio, no image descriptions and no fields until it fetches the target again, and each later import of
  the source does so again.
- A remote account's `followers_count`, `following_count` and `statuses_count` are the `totalItems` of its followers,
  following and outbox collections, as `ProcessAccountService#set_fetchable_attributes!` sets them
  (`process_account_service.rb:162-164`), but read by the background collection sync that each stored actor document
  asks for (`src/federation/collections.ts`, which also fetches the destination of an unknown `movedTo`, above), not
  while the document is stored: an account shows 0 until its first
  sync, and an account stored by an earlier release shows 0 until its document is stored again. Mastodon also moves
  the counts by its own deliveries between refreshes (`status.rb:480-493`, `follow.rb:62-70`); Kopje recounts local
  accounts only, so a remote account keeps the reported counts until the next refresh. A collection that may be read
  later (a timeout, a 5xx, the round's budget) is read again in a later round, where Mastodon keeps the count; one on
  another origin than the actor's is not read. A count is taken from a JSON number only, its integer part, a negative
  one as 0 (`AccountStat` shows `max(value, 0)`); one past 2^53−1 is not taken, where Mastodon's `bigint` column takes
  up to 2^63−1 (and a larger value raises, unverified). A document past the network part's caps (threat-model.md
  RES-6, `NETWORK_CAPS`) is unreadable, as Mastodon reads a collection it cannot fetch: no count, and a following or
  followers collection past them hides the network. Mastodon also refreshes a remote account in the background a week
  after its last fetch, up to six hours later, when a `Create` or `Update` of it arrives (`account.rb:69-70,258-261`;
  `create.rb:5`); Kopje refreshes only when it stores the actor's document, and before storing a status it fetched by a
  stale account (below), an account with an invalidated handle included. Mastodon signs the count fetches as
  `Account.representative` (`json_ld_helper.rb:232-235`); Kopje signs them as its other collection fetches (DATA-7: a
  local follower's key, else the instance actor's).
- Before storing a status it fetched by another account than the activity's sender (the original of a boost, a quoted
  status), Kopje refetches that account when its document was stored at least a day ago, as
  `FetchRemoteStatusService#account_from_uri` refetches a `possibly_stale?` account
  (`fetch_remote_status_service.rb:67-71`, `account.rb:71,254-256`). An account the instance suspended or a domain block
  covers is not refetched (R38), and its status is refused as in Mastodon (`:44`). The refetch confirms a handle its
  document claims by WebFinger when it is not the stored one, as `ProcessAccountService` does; an account with an
  invalidated handle is refetched whenever it was last fetched (`possibly_stale?`). An account whose refetch answers 404
  or 410 has no new status stored, as in Mastodon, and a 410 at its URI deletes it (above); a 404 or 410 that arrives
  after another request's failed refetch of the same account is not applied. Where any other failure would make Mastodon
  store nothing or retry the job, Kopje stores the status under the stored account and tries that account again only a
  day later. A sender's own statuses are stored under the sender, as fresh as its key (24 hours, ID-1). The pinned
  statuses a collection sync fetches use the stored account however long ago the sync was asked for, where Mastodon
  checks the account when it fetches them. Search always fetches the account.
- `source.follow_requests_count` counts, among the account's newest 120 pending follow requests, those of available
  accounts (R1 in `docs/visibility.md`), at most 40, as the first page of `GET /api/v1/follow_requests` lists them.
  Mastodon 4.7.5 counts up to 40 requests of accounts that are neither suspended (`suspended_at`) nor pending deletion
  (`requested_deletion_at`) among all of them (`credential_account_serializer.rb:17`, `account/suspensions.rb:7-9`). The
  counts differ in two ways.
  - **The window.** When more than 80 of the newest 120 requesters are unavailable, Kopje's count can be lower. An
    individual suspension keeps a requester's request pending, while a `suspend` block and a deleted account's purge
    remove it. Counting among all of them would let the stored requests of suspended accounts make every
    `verify_credentials` read grow without a bound (RES-7).
  - **What unavailable means.** Kopje also leaves out a requester whose deletion has started or that a `suspend` block
    covers, from that moment. Mastodon already leaves out an account marked pending deletion (`requested_deletion_at`),
    and otherwise counts a requester until its purge removes the request or until the block's suspension of the domain's
    accounts reaches it.

  Accepted, 2026-11-15.

Remote collections (an account's featured statuses and hashtags, and the collections its counts come from;
Mastodon's `JsonLdHelper#collection_items`; RES-6 in [threat-model.md](threat-model.md)):

- Kopje reads an account's collections only on its actor's origin, within one request's fetch budget per round
  (`src/federation/collections.ts`):
  - the featured collection and its first page, of whose items the first 20 are pinned;
  - the `featuredTags` collection and at most 3 of its pages;
  - one document each of the following, followers and outbox collections, for their counts (Accounts, above).

  Mastodon 4.7.5 reads every item of the featured collection's first page, and the featured hashtags until it has 10
  or has read 10 pages, both only on the actor's host. Accepted, 2026-11-15.

- A pinned status a sync stores, or finds already stored, has its quote verified only when the status reaches Kopje
  another way (a delivery, a boost, an `Add`, a search); until then its quote stays pending. Mastodon 4.7.5 verifies a
  pinned status's quote as any status's (`fetch_featured_collection_service.rb:34`, `create.rb:417-419`) and bounds
  the fetches that follow from one only per request (`DISCOVERIES_PER_REQUEST`, 1,000 accounts and 1,000 statuses,
  each count expiring 5 minutes after its last increment). Kopje gives quote verification work only to statuses that a
  delivery or a user's request brought, so that reading an account's collections leads to no other account (RES-6).
  Accepted, 2026-11-15.

- An actor's collection (its `followers`, `following`, `featured`, `featuredTags` or `outbox`) is the URI Mastodon
  4.7.5's `valid_collection_uri` stores for it (`process_account_service.rb:235-245`: Addressable's parse, written back,
  or `''` for none, which an addressing or quote policy entry `""` matches as in Mastodon), but Kopje cannot tell that
  URI for a value holding a NUL (PostgreSQL refuses it, so Mastodon stores no account), a lone surrogate or U+FFFD, a
  line feed in its authority, or a port that percent-decodes to one holding a line feed. Mastodon stores some of these
  (a line feed in the userinfo as spelled, the port `4%0A` as `:4`). The Store's JSON functions read a lone surrogate's
  escape as bytes that come back as U+FFFD, so its SQL readers and `JSON.parse` would read two strings, and a line feed
  moves the splits of Ruby's line-anchored expressions. No addressing names such a collection, so a status addressed to
  it is direct where Mastodon may make it private. The entries of a quote policy (`canQuote`) and of an actor's
  `canFeature` are read in Mastodon's order (one spelling of the public collection, then the followers collection, then
  the following one, then the author itself, each match taken before the next: `status_parser.rb:179-196`,
  `interaction_policy_parser.rb:22-40`), and past such a collection a string adds nothing but the public collection's
  flag (the author itself still makes a `canFeature` half that adds nothing `disabled`), while a value that is not a
  string, which no collection matches, adds `unsupported_policy` as in Mastodon: Mastodon may store the collection as
  the very string a later entry lists and read the entry as it, so neither a later collection's flag nor
  `unsupported_policy` for a string (which lets anyone ask to quote) is known to be Mastodon's. Every entry is read,
  and every string entry compared as Mastodon compares it, whatever its length (a policy's entries are the received
  object's, within its 1 MiB body bound and 10,000 values; the stored collection compared with them has no fixed
  bound), so each entry's flags are within Mastodon's, and no one may quote, feature or ask where Mastodon refuses
  them. Accepted, 2026-11-16.

- An `Add` or `Remove` of a `Hashtag` aimed at the actor's `featuredTags` collection features or unfeatures it, as
  one aimed at its `featured` collection does. Mastodon 4.7.5 reads a hashtag only from one aimed at the `featured`
  collection (`activity/add.rb:8`, `:18`; `activity/remove.rb` the same) and looks any other target up among the
  actor's stored collections, so it ignores this one. Both targets name the actor's own featured hashtags. Accepted,
  2026-11-18.

- A remote account keeps at most 20 pins and 10 featured hashtags: an `Add` past either is ignored, with or without
  an `id`. Mastodon 4.7.5 limits only a local account's (`status_pin_validator.rb:10`, `featured_tag.rb:77`) and
  stores every pin and featured hashtag a remote account's `Add` brings. Accepted, 2026-11-18.

Followers synchronisation (Mastodon's `Collection-Synchronization` header and
`/users/:username/followers_synchronization`):

- Kopje neither sends nor reads the header and serves no partial followers collection. A follow one side lost is not
  repaired by a later delivery; each server keeps delivering and distributing by its own follow records. Mastodon 4.7.5
  does not send it from 25,000 followers (`app/workers/activitypub/distribution_worker.rb:7,39`, `mastodon#37302`).
  Accepted, 2026-11-15.

Replies collections (the context's refresh, `GET /api/v1_alpha/async_refreshes/:id` and the replies a created status
lists; Mastodon's `ContextsController#show`, `FetchAllRepliesWorker`, `AsyncRefresh` and `Create#fetch_replies`; RES-6
in [threat-model.md](threat-model.md)):

- A signed-in reader's context read of a remote public or unlisted status starts a refresh of its replies, as Mastodon
  4.7.5's does, from 5 minutes after the status was published and at most every 15 minutes, and answers
  `Mastodon-Async-Refresh` while it runs. Kopje also starts none while 16 run, where Mastodon has no such cap, nor while
  the instance does not accept writes (the env's `MAINTENANCE=readonly`, the Store's readonly maintenance, an
  unpublished import), a state Mastodon does not have; a read then answers as one not due. Kopje starts none for a
  boost, whose URI names its Announce activity, not a status; Mastodon starts one for a remote boost as for an original
  (`should_fetch_replies?` does not exclude it), its job fetching the boost's URI, and answers `Mastodon-Async-Refresh`
  while it runs. Accepted, 2026-11-16.
- A refresh records at most 200 statuses, the root included, and reads at most 100 collection documents, each fetched
  at most twice (Mastodon's `FetchAllRepliesWorker`: 1,000 statuses and 500 pages). It reads each collection until it
  ends or those caps are spent, where Mastodon takes the first 5 items of a reply's collection: the caps bound the
  work, and the 5-item stop loses replies Mastodon itself means to fetch. Accepted, 2026-11-16.
- A refresh, or a created status's walk below, stores only the replies its stored rows link to the status, each under a
  reply it stored or found stored; a status listed whose parent is not such a reply by the walk's end is not stored, and
  a stored one is judged by its stored parent. Mastodon stores every status a collection lists. A refresh takes items
  from any server, as Mastodon's, and a created status's walk only from the listing status's own server; both read
  collections only from the replying status's own server, as Mastodon's (but by origin, below). Accepted, 2026-11-16.
- Only the refreshed status is paced: the replies a refresh reaches record nothing, so opening one of them later may
  refresh it at once, where Mastodon skips each fetched status for 15 minutes. A reply a refresh stores verifies its
  quote one hop short of a delivered status's, so its quoted status is stored with no quote work of its own.
  Accepted, 2026-11-16.
- A refresh's id belongs to the status, as Mastodon's: a refresh started again while its record is kept (until an hour
  after it finished, or a day after a start it never finished) keeps the id, running again with `result_count` 0. Once
  the record is gone, the next refresh has a new id, where Mastodon's repeats; in between, the id answers 404 in both.
  `result_count` counts the statuses the latest refresh created, whoever may see them, as Mastodon's. Accepted,
  2026-11-16.
- A status Kopje creates from a delivery or a user's request (an inbound `Create` or `Update`, a boost's original, an
  `Add`'s status, a `QuoteRequest`'s quoting status, a search or `/authorize_interaction`) has the first 5 replies on
  its own server that its replies collection's first page lists fetched, as Mastodon's `Create` does, and so does each
  of those replies, up to 20 statuses and 10 collection documents a thread (Mastodon: up to 1,000 statuses a request).
  A status Kopje stores otherwise (a reply a walk stores, a quoted status a verification stores, a pinned status a
  profile's sync stores) has none fetched, where Mastodon fetches them for every status it creates: so no chain of
  replies, quotes and pins starts walks without end. A walk not ended a day after its status arrived is dropped at its
  next claim, which newer walks may delay. Accepted, 2026-11-16.
- A created status's walk starts only for a public or unlisted status, where Mastodon's `Create#fetch_replies` checks no
  visibility: the replies of a private, direct or limited status Kopje creates are not fetched. A created status's walk
  takes an item only on the origin (scheme, host and port) of the status that lists it, and both walks read a collection
  document only on the origin of the status whose replies it holds, where Mastodon compares hosts only
  (`non_matching_uri_hosts?`): an item or document on the same host under another scheme or port is passed over.
  Accepted, 2026-11-16.
- Once a node's replies collection has been read, a refresh also fetches the node's stored public replies of remote
  authors the collection did not list, after its listed ones, as Mastodon's (`fetch_all_replies_service.rb:33-49`), each
  skipped as Mastodon skips a listed one (published within 5 minutes, or refreshed within 15). Mastodon fetches only
  those whose author has no local follower or a local follow newer than the reply's last update (`unsubscribed`,
  `fetch_replies_concern.rb:27-33`); Kopje fetches them whoever follows their authors, since it keeps neither a follow's
  acceptance time nor a status's update time. Kopje examines at most 200 of a node's stored public replies a refresh, in
  id order from where the node's last examination ended, whichever refresh it was, so a node with more is covered over
  several refreshes; Mastodon examines all of them each time. A refresh holds 200 statuses where Mastodon's takes up to
  1,000: what a refresh had no room for (a stored reply it could not admit, the rest of a collection it could not read)
  is done first at the thread's next refreshes, oldest first, a collection continuing where it stopped, so a reply may
  wait a few refreshes where Mastodon fetches it at once, and a thread wider than a refresh is covered over several.
  Depth is a limit: a post's refreshes fetch replies at most 199 links below it, since a refresh holds 200 posts and
  stores a reply only with its whole chain to the post; Mastodon's takes up to 1,000
  (`fetch_all_replies_worker.rb:15-17,33-44`), so a chain of 201 replies below a post gets its last two from that post's
  refreshes in Mastodon and not in Kopje, where only the refreshes of a reply within 199 links of them (its context
  read) fetch them. Private stored replies are not fetched (they answer the refresh's signer 404 and change nothing in
  Mastodon). Accepted, 2026-11-16.

Annual reports (`/api/v1/annual_reports`, `wrapstodon` of `/api/v2/instance`; MD-9):

- Kopje makes the report within the `generate` request and answers 200 `{}`; Mastodon answers 202 with
  `Mastodon-Async-Refresh` and makes it in a job. `state` never answers `generating`. Accepted, 2026-11-15.
- An account whose year holds more than 200,000 statuses (`REPORT_YEAR_STATUSES`, boosts and withdrawn ones included),
  whose statuses of the year hold more than 200,000 hashtag uses (`REPORT_HASHTAG_USES`) or more than 8 MiB of hashtag
  names (`REPORT_HASHTAG_BYTES`), or that has more than 200,000 followers (`REPORT_FOLLOWERS`) gets no report: `state`
  answers `ineligible`, `generate` makes none, and Kopje logs `kopje.annual_reports.capped`
  ([observability.md](observability.md)). Mastodon reads any number. Reports past the caps are tracked by #1601.
- The year is the UTC year exactly; Mastodon's bounds fall at random within its first and last second. Accepted,
  2026-11-15.
- The top status is chosen among public or unlisted originals with a reply, boost or favourite, ties to the oldest;
  Mastodon chooses among those with a stats row, which stays when the counts fall back to 0, and leaves ties
  unordered. The top hashtag is counted by its normalized name, ties by name; a name the hashtag bound leaves out (only
  an imported one can be) is passed over among the 32 most used, and none is shown when all 32 are left out. Accepted,
  2026-11-15.
- A follow counts in the year its request was made; Mastodon counts the year it was accepted. Accepted, 2026-11-15.
- `index` lists at most 40 pending reports, newest year first, and the top statuses within the answer budget; Mastodon
  lists every pending report, unordered. Accepted, 2026-11-15.
- The campaign runs from December 10 to 31 (UTC) by the Store's clock, and is switched off with
  `kopje-admin instance wrapstodon=false` (Mastodon's admin setting, on by default). A Mastodon admin can also generate
  a report by hand from a console, which its owner then reads; Kopje has no such path. Accepted, 2026-11-15.

Collections (`/api/v1/collections`, `/api/v1/accounts/:id/collections` and `/in_collections`, also under
`/api/v1_alpha`; R45 in [visibility.md](visibility.md)):

- A collection whose owner is suspended, hidden or otherwise unavailable is not found, and an unavailable member is
  left out of `items` and `accounts`, where Mastodon shows both: Kopje hides an unavailable account everywhere (R1).
  Accepted, 2026-11-16.
- The `Link` headers of `GET /api/v1/accounts/:id/collections` continue while a page is full, step by the page's
  limit and never carry a negative offset, where Mastodon's `next` stops after the first page (`offset * limit`), its
  links step by at most 80, and its `prev` can be negative. Accepted, 2026-11-16.
- `GET /api/v1/accounts/:id/in_collections` lists memberships newest first (Mastodon: no order) and pages by a bounded
  window of candidates: a page may be short or empty while later memberships exist, and its `Link` headers carry
  `max_id`/`min_id`, not `offset`; an `offset` is honoured up to 400 and answers an empty page past it. Accepted,
  2026-11-16.
- Creating a collection with more than 25 distinct `account_ids[]` answers the too-many error without looking the
  accounts up, where Mastodon first answers 404 or 403 for an unknown or refused one. Accepted, 2026-11-16.
- Creating an 11th collection answers Mastodon's 422 with the message "Collections are too many, no more than 10 are
  allowed", where Mastodon's message is a missing-translation text (it has no English text for that error). Accepted,
  2026-11-16.
- An `Accept` of a feature request changes only a pending membership; a late one after a removal, rejection or
  revocation is ignored, where Mastodon marks the item accepted whatever its state. A member's `Delete` of its
  authorization that arrives before the `Accept` naming it is kept for 30 days, as every retraction, and that `Accept`
  or a check of that authorization then ends the membership as revoked, where Mastodon ignores the `Delete` and accepts;
  an `Accept` that follows a deletion of another authorization waits for a check of its own against the member's server
  before the membership is shown. Kopje's `FeatureRequest` names the owner as its `actor`, where Mastodon's carries
  none, and the removal of a remote member still pending sends no `Remove`, where Mastodon sends one that no server
  holds an item for. Accepted, 2026-11-18.
- A post tags only collections Kopje stores: a link to a remote collection Kopje has not stored, and a remote post's
  tag naming one, are neither resolved nor fetched, where Mastodon fetches them, and a remote post's tag never stores
  the collection it embeds, the author's own included; such a post shows the tag only after its author edits it once
  Kopje stores the collection, and so does a post whose remote collection was deleted and stored again: an unchanged
  refetch of the post leaves its tags as they are (a refetch of a newer version applies them, as an edit does). A
  remote collection's tags go when Kopje deletes it, a complete read of its owner no longer listing it among them,
  where Mastodon keeps the collection until a `Remove`. A link to a remote collection's web page tags it only when the
  link, normalized, is the `url` Kopje stored, as the remote server spelled it, the collection's id and its owner are
  on the link's origin, and no other stored collection of that origin gives the same `url`: where Mastodon fetches the
  page, a collection whose server spells its `url` or id otherwise (capitals in the host, an explicit default port, as
  its operator wrote `WEB_DOMAIN`) is not tagged by a link to it, whatever the spelling of the link itself. A link to a
  local collection tags it by its ActivityPub id as Kopje gives it, under its owner's actor id, or by its web page or
  its route on the instance's domain, the route under its owner's username as the route serves it, where Mastodon's
  route lookup takes the collection's id alone. At most 4 collections are tagged per post, a collection already tagged
  by 100 posts keeping its slot among the 4 untagged, and only the first 100 posts to tag a collection keep the tag
  (Mastodon has no number), and a collection whose owner is unavailable takes none of them. `tagged_collections` leaves
  out a collection the viewer may not see (its owner blocks the viewer or is unavailable), where Mastodon shows it.
  Kopje's Notes name a tagged collection by its id alone, where Mastodon's embed it whole; Mastodon reads only the id.
  Accepted, 2026-11-19.
- An account's `feature_approval.current_user` is `denied` when either account blocks the other or the account is
  unavailable, where Mastodon may answer `automatic` (or `manual`) and then refuse the add; every other answer is
  Mastodon's. The instance's contact account answers `denied` (no viewer), where Mastodon's cached instance answer
  carries whichever viewer's answer filled the cache. Accepted, 2026-11-16.
- An `added_to_collection` notification is deleted with its membership (removal, eviction or a block), and a
  `collection_update` with its collection, where Mastodon keeps an `added_to_collection` whose item is gone, presented
  without a collection. Accepted, 2026-11-16.
- A collection update the rule does not notify to a member (the member has muted the owner's notifications since) leaves
  the member's earlier `collection_update` as it was, as an edit's `update` is kept, where Mastodon's
  `LocalNotificationWorker` deletes the earlier one before `NotifyService` judges the new one: after an unmute the
  earlier one shows again. Accepted, 2026-11-16.
- A collection's ActivityPub documents (its `FeaturedCollection`, as served, on the pages of the owner's
  `featured_collections` and in its `Add` and `Update`) leave out a member that is suspended or otherwise unavailable,
  and that member's `FeaturedItem` answers 404, where Mastodon lists every accepted item; a suspension sends no
  `Update`. Accepted, 2026-11-16.
- `featured_collections` reads `page` as Mastodon does but where Mastodon fails: a number whose offset passes
  PostgreSQL's bigint (from 1844674407370955163) is the empty page past the last, a `page[]` or `page[key]` is no page
  (the root), and a value that is not UTF-8 is read with each bad sequence replaced, where Mastodon answers 500, 500
  and 400. Accepted, 2026-11-16.
- A collection's ActivityPub path reads its format as Rails does for Mastodon's `CollectionsController` at
  `/ap/users/:account_id/collections/:id(.:format)`: the extension, else the query's `format`, else `Accept`,
  `X-Requested-With` and, for an XHR without an `Accept`, `Content-Type`; and it answers 400 to a query Rack or Rails
  refuses and 406 to any `Content-Type` Rails cannot read, in Mastodon's order. Where Mastodon serves the page's HTML at
  that path, a request whose first type Rails reads is neither HTML nor JSON (as `*/*` alone) while it takes HTML before
  JSON, Kopje moves it to the page, as it does a request Rails reads as HTML; and a `q` Ruby reads as infinite sorts
  first, where Mastodon answers 500. Accepted, 2026-11-16. A query past one of Rack's limits (nested 32 deep, more than
  4,096 fields, more than 4 MiB) is 400, where Mastodon answers 500; a `format` in a GET's form or JSON body, which
  Rails also reads, is not read; and the path with a trailing or doubled `/`, which Rails also routes, or with an
  extension Rails routes nowhere (a bare `.`, or a second `.`), where Mastodon answers 400 to a query Rack refuses and
  406 to an `Accept` or `Content-Type` Rails cannot read, is 404. Accepted, 2026-11-17.
- A deleted collection's `Remove` reaches its members as well as the owner's followers, where Mastodon's per-member
  delivery does not reach them. Kopje's collection `Add` and `Remove` carry an `id` and `to`. A member's revocation of
  its item in a local collection, by its route or by blocking the owner, is sent as the owner's `Remove` of the item,
  where Mastodon sends the member's `Delete` of its `FeatureAuthorization`. Accepted, 2026-11-16.
- A collection's page (`/collections/:id`) is served for a local collection only (a remote collection's `url` is its
  own server's), and the profile pages do not list an account's collections, where Mastodon's web client does.
  Accepted, 2026-11-16.
- A remote account's collections are read from at most 2 pages of at most 512 KiB each, 10 collections of 25 members
  each (Mastodon: 10 pages, 50 collections, 150 members); a page past that size, or served through a redirect, ends
  the list; a collection or member given only as a URI, not embedded, is skipped (Mastodon fetches it); one no longer
  listed by a complete read is deleted (Mastodon keeps it until a `Remove`), unless a local account is a member of it,
  which keeps it whole, so Kopje may hold up to 50 collections of an account: those a read lists or a feature request
  names; a feature request naming a new collection past those 50 is refused; a member Kopje does not know is not
  fetched and stays unshown until Kopje learns of the account; a member that is a local account is shown as described
  below. Accepted, 2026-11-18.
- A remote collection whose `totalItems` is not a whole number from 0 to 2^31 − 1 (a negative or fractional number,
  or a string) is not stored; Mastodon 4.7.5 refuses only one that is not a number, and stores the others (a fraction
  cut to its whole part, a numeric string read as its number). Its language, the first key of its `summaryMap`, is
  stored only when it is a language code Kopje stores (the ISO 639-1 codes of `collections.language`), and otherwise
  as none; Mastodon stores any key. A member's `created_at` is its item's `published` when that is a time no later
  than its arrival with a year from 0 to 9999, and otherwise the time Kopje received the item; Mastodon stores any
  time it can read. Accepted, 2026-11-17.
- A member's authorization is checked once for each value the owner gives it, in background rounds, four a round, at
  most five attempts, and at most 250 checks begun in a UTC day for one owner's collections (the rest wait for the next
  day); Mastodon verifies it again on every processing of the collection. An authorization larger than 64 KiB or served
  through a redirect is not accepted; a member whose check failed this way, did not match, or gave up after five
  attempts stays unshown until the owner changes or re-adds it. An authorization answered 501 is retried as any 5xx,
  where Mastodon takes it as final and rejects the member (as both do for any other 4xx than 401, 408 and 429). Kopje
  learns that a member withdrew only from the owner's `Remove` or the member's own `Delete`: while the owner keeps
  listing a member that withdrew and Kopje receives neither, Kopje keeps showing the member. Accepted, 2026-11-17.
- A member's `Delete` of its feature authorization revokes its membership of a remote collection too, when it names
  the membership's current authorization (verified, or the one the owner lists while unchecked), including the copy
  the collection's owner relays with the member's signature; Mastodon applies it to local collections only. It is kept
  for 30 days, so the check of a membership the owner lists with that authorization later (for the first time, or
  again after changing it) ends it as revoked, though the member's server may still serve the authorization from its
  cache. Accepted, 2026-11-17.
- A local member's revocation in a remote collection is sent to the collection's owner and the member's followers, where
  Mastodon sends it to the owner and the collection's reach. A revocation by a block, and the `Delete` answering an
  owner's listing (below), are sent to the owner's personal inbox alone without an LD signature: Mastodon applies such a
  `Delete` from its HTTP signer (`delete.rb:6`, `:68-81`), and LD-signs it only in `RevokeCollectionItemService`. A
  `FeatureRequest` that names no actor (as Mastodon sends it) is taken as its signer's only when the signature's key id,
  without its fragment, is the signer's actor id. A feature request for a member already in the collection is answered,
  naming that request: while the membership stands, an `Accept` with its authorization, whatever the member's policy is
  then; for a revoked membership, a `Reject`. Mastodon answers nothing while an item exists, unless its policy refuses:
  it re-checks its policy at every copy of a request (`feature_request.rb:14-18`). A request when local members already
  fill 25 places is refused. Accepted, 2026-11-18.
- A local account's membership of a remote collection is shown to the member at once, and to others once the owner
  lists it: by its `Add`, or in a read of its collections. An owner's `Remove` of the member's item, or a read that no
  longer lists it, hides the membership instead of ending it, and its authorization is still served until the member
  revokes it or blocks the owner, or the collection or either account is removed. Mastodon shows the membership to
  everyone at once, and deletes it on the `Remove` or when a listing drops it. What others see follows the owner's
  activities and Kopje's reads of the owner's collections, with no time bound:
  - a member the owner lists may stay hidden until a read covers it, when the owner's `Add` never reached Kopje, or
    named an item URI the owner had removed before, or when a retried copy of an earlier request of the owner's is
    answered after the current one;
  - a member the owner removed may stay shown until a read covers it, when the `Remove` never reached Kopje, or when a
    delayed `Add`, or a delayed collection `Add` or `Update`, names it again;
  - past the first 10 collections a read applies, what others see stays as last observed; in a collection listing
    more than 25 members, a read shows the members its first 25 entries name and hides no one.

  An owner's `Add`, or a listing, that names a local member's authorization Kopje no longer serves is answered with
  the member's `Delete` of it, where Mastodon sends nothing. Once the row of that authorization is gone (the 24-hour
  cleanup, or the oldest retired row removed at the 50-row bound), that answer is an ordinary delivery: refused at a
  full backlog, it leaves the owner showing the member until a later `Add`, or a read that covers the item, once the
  backlog has room. When no such `Delete` reaches the owner and the item lies past what a read covers, the owner keeps
  showing the member until it removes or re-adds it. Accepted, 2026-11-18.

Hosts (Mastodon's `config.hosts`, `config/initializers/1_hosts.rb`; threat model WEB-6):

- Mastodon allows `LOCAL_DOMAIN`, `WEB_DOMAIN` and `ALTERNATE_DOMAINS` as hosts and exempts exactly `/health`; on any
  other host Rails' `HostAuthorization` (Rails 8.0.4.1) answers 403, with an empty body in production. It judges the
  `Host` header and the last `X-Forwarded-Host`, case-insensitively and with any port. A CORS preflight is answered
  by `Rack::Cors` before it, and the streaming server is not covered. Kopje judges the request URL's host, which is
  the domain only (no alternate domains), from setup on: a GET or HEAD on another host moves to the same path and
  query on the domain (301), any other method answers 421 Misdirected Request, and a port other than 443 is another
  host. Besides `/health`, it answers the admin API, media URLs and `/` on any host, and streaming is covered.

API answer headers (the security headers, `Deprecation`, `Cache-Control` and `Vary` of the Mastodon API; threat model
WEB-5, WEB-7):

- No `X-RateLimit-Limit`, `-Remaining` or `-Reset`: Kopje limits no API requests per token, user or address (Mastodon:
  300 every 5 minutes per token and per address, 1,500 per user, and per-action limits on posting (boosts and edits
  included), following and reporting), so it has none to report; its 429s (app registration, `/login`) carry none
  either. Accepted, 2026-11-16.
- No `X-XSS-Protection`, `Server`, `X-Request-Id` or `X-Runtime`. Accepted, 2026-11-16.
- No `Strict-Transport-Security` from the Worker. Mastodon's `force_ssl` adds `max-age=63072000; includeSubDomains` to
  every HTTPS answer; Kopje leaves HSTS to the operator's Cloudflare zone setting, which also covers the zone's other
  subdomains, so a deployment sends it only when the operator turns it on. Accepted, 2026-11-16.
- OAuth's token endpoints, WebFinger, NodeInfo and ActivityPub documents carry `nosniff` and their own caching, not
  Mastodon's `X-Frame-Options` and `Referrer-Policy`, which Rails adds to every answer. Accepted, 2026-11-16.
- A path under `/api/` that names no route is answered 404 with the API's policy (`default-src 'none'`); Mastodon routes
  it to `ApplicationController#raise_not_found` (`config/routes.rb`, `*unmatched_route`), whose answer carries its
  app-wide policy (`config/initializers/content_security_policy.rb`), which allows its own scripts, styles and media.
  Accepted, 2026-11-16.
- `Vary` names what the route declares. Mastodon's also names `Origin` on every answer (rack-cors) and `Accept` where
  its controller declares an empty `vary_by` (Rails adds it to a rendered answer). Kopje's CORS answer is `*` for every
  origin, and an API answer is JSON whatever `Accept` says. Accepted, 2026-11-16.
- No `ETag` and no 304: every request gets the full answer. Mastodon (Rack's `ETag` and `ConditionalGet`) tags every
  200 or 201 with a body with a weak ETag and answers an exact `If-None-Match` on a GET or HEAD with 304; a client's
  cache revalidates the public answers below after their 15 seconds or 5 minutes, and the OAuth answers Rack marks
  `max-age=0, private, must-revalidate` (revocation, introspection, token info, server metadata) on each use, and gets
  200 from Kopje each time. A full 200 is always a correct answer to a conditional request, and matching would hash
  every answer body for a saving only on repeated identical reads. Accepted, 2026-11-16.
- An error answer is never public; Mastodon's terms of service answer their 404 publicly for 5 minutes (the caching
  runs in a `before_action`). Accepted, 2026-11-16.
- Of the instance reads Mastodon lets caches keep for everyone, the nine that read the token (custom emoji,
  languages, privacy policy, terms of service and their dated form, translation languages, activity, domain blocks,
  peer search) answer an anonymous request public for 5 minutes with `Vary: Authorization` and a request with
  `Authorization` `private, no-store`. Mastodon answers both public for 5 minutes and leaves `Authorization` out of
  `Vary`, so a cache may serve an anonymous answer to a suspended owner's token, whose answer is 403 (custom emoji
  where the instance answers unauthenticated API requests), and, where the instance shows domain blocks to everyone
  and their comments to users only, a user's domain-block list, comments included, to anyone. Accepted, 2026-11-16.
- OAuth endpoints keep Doorkeeper's `no-store` on tokens, token info and introspection, and add `Pragma: no-cache` to
  errors too; a revocation's `{}` and the authorization server metadata carry none, where Mastodon's Rack adds
  `max-age=0, private, must-revalidate` and an ETag, and `no-cache` to a revocation's error. Accepted, 2026-11-16.

Public pages ([web-pages.md](web-pages.md)):

- A profile (with its tabs), the Featured tab and a post's page send no `robots` meta on their first page, as
  Mastodon's own pages for an account that does not ask for `noindex` (none does, see Accounts); their pages with a
  cursor, which Mastodon does not serve, send `noindex, follow`. The handoff pages, which Mastodon does not serve,
  send `noindex`. Every other page, 404 and 410 sends what Mastodon's answer at the same URL sends
  ([web-pages.md](web-pages.md), "Robots"). Accepted, 2026-11-16.

Instance and apps (`/api/v1/apps`, `/api/v{1,2}/instance`, `/api/v1/peers/search`, `/api/v1/preferences`):

- An application's `id` is its `client_id`, Kopje's only stable key of an application; the `client_id` is a public
  identifier (RFC 6749 §2.2).
- A registration's `scopes` that is empty once trimmed (a space) takes the default, `read`; Mastodon takes the default
  for an absent one only (`Api::V1::AppsController#app_scopes_or_default`). Accepted, 2026-11-18.
- `usage.users.active_month` counts the available local accounts with an authenticated API or web request on one of the
  last 29 UTC days, today included. Each account's day is recorded at most once a day, after the response, and a
  request made while a dump holds the Store may go unrecorded. Mastodon 4.7.5 counts logins over the same days,
  suspended users included.
- `stats.domain_count` of `/api/v1/instance` is the count of distinct remote account domains the 5-minute cron last
  kept (Mastodon keeps it in a cache as well: `Rails.cache.fetch('distinct_domain_count')`), at most 10 minutes old;
  past that, counted on request. A request counts it itself, and keeps nothing, whenever no kept count is that fresh:
  before the cron's first run on a new or upgraded Store, after an import begins or a reset ends (both clear it, and
  it is never dumped), and while the cron's refresh is skipped (a dump in progress, the env's `MAINTENANCE`).
  `/api/v2/instance` presents no domain count and reads none. `user_count` and `status_count` are counted per request.
- `GET /api/v1/instance/activity` counts from the upgrade that added it (migration `0072_activity_tracking`): earlier
  weeks read 0, and an import, a restore or a cutover conversion counts nothing (a restore keeps the counts it
  carries). A login is a UTC day with a successful authenticated API request or a signed-in `GET /settings` of the
  account, recorded after the response, and the setup's first login; Mastodon records one at most every rolling 24
  hours of a signed-in user's requests, at each sign-in and at the new user's preparation.
- The activity answer is kept for the UTC day it was made (or until `activity_api_enabled` changes, or an import is
  verified or published); Mastodon keeps its answer 24 hours from the first request.
- The activity's weeks are Mastodon 4.7.5's, 7 UTC days each. Its logins are exact distinct accounts (Mastodon's are
  a HyperLogLog estimate), counted among a week's first 700 login rows by day and account, so a week with more than
  700 login days (one per account and day) may count fewer accounts than logged in. A day's statuses and registrations
  stop at 10^12 each. Week 0 holds today only and never reads a later day, which an import may hold; Mastodon names the
  six days after today too, where it has no key. Mastodon's sum also reads the legacy `cweek` keys, which Kopje never
  had.
- `thumbnail` is always Kopje's default image, with its fixed description on `/api/v2/instance`; there is no upload.
- `icon` lists Kopje's icon at 48, 192 and 512 px; Mastodon lists nine sizes (36 to 512).
- `languages` is `["en"]`, the web UI's language.
- The reading preferences, `reading:autoplay:gifs` included, are Mastodon's defaults; no setting stores them.
- `contact_username` and `contact_email` can each be removed alone (Mastodon's admin form requires both).
- The operator's documents (the privacy policy, the terms of service, the extended description) are HTML, sanitized by
  `sanitizeDocumentHtml` (`src/security/html.ts`) in `/api/v1/instance/*` and on their pages alike. Their headings are
  kept only as h2 to h4, without attributes (h1 becomes h2, h5 and h6 become h4), and a link that is not an absolute
  http(s) URL loses its href and stays as text (HTML-3; [setup.md](setup.md), Instance details). Mastodon 4.7.5
  renders each from Markdown with Redcarpet (`REST::PrivacyPolicySerializer`, `REST::TermsOfServiceSerializer`,
  `REST::ExtendedDescriptionSerializer`, without `safe_links_only`), keeping h1 to h6 and relative links as written.
  `test/instance-reads.test.ts` ("keeps a document’s headings in the API, as the pages show them"), `test/html.test.ts`
  ("keeps headings as h2 to h4, without attributes, under the page’s own h1"). Accepted, 2026-10-28.
- `GET /api/v1/peers/search` answers `[]` for a `q` that IDNA cannot encode as a host, such as U+FEFF (not blank to
  Rails). Mastodon 4.7.5 answers 500 to it: `TagManager#normalize_domain` raises `IDN::Idna::IdnaError`, and the
  controller rescues only `Addressable::URI::InvalidURIError`. Such a `q` names no peer, so Kopje answers it as it
  answers a host Addressable refuses. `test/param-blank.test.ts` ("answers the peer search null for a blank q only").
  Accepted, 2026-11-18.

OAuth (`/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/token/info`, `/oauth/introspect`):

- A scalar parameter of `/oauth/token` or `/oauth/revoke` sent more than once, in the query, in the body or in both
  (`code=a&code=b`), answers 400 `invalid_request` (RFC 6749 §3.2; AUTH-3 in [threat-model.md](threat-model.md)), and
  so does one sent more than once in the body of `/oauth/introspect`; Mastodon's Doorkeeper reads one of them (the
  last of a source, the query's over the body's) and goes on with it. Introspection reads no query (below), so a query
  value beside a body one (`?token=a` with `token=b`) is no repeat there and the body's is read, where Mastodon reads
  the query's. Accepted, 2026-11-18.
- A scope string (a registration's `scopes`, an authorization's or a token request's `scope`) is split at
  JavaScript's white space and at a literal `+` (`%2B`), and a registration's `redirect_uris` at JavaScript's white
  space, so U+00A0, U+3000 or U+FEFF between two values separates them; Doorkeeper splits each at ASCII white space
  only (Ruby's `String#split`: `OAuth::Scopes.from_string`, its redirect URI validator), where such a string names an
  unknown scope or an invalid URI. Accepted, 2026-11-18.
- `response_mode` `query`, `fragment` and `form_post` are accepted and every answer goes in the query, as Mastodon's
  rendered consent form answers them: the form carries no mode. A decision posted directly with `fragment` or
  `form_post` is also answered in the query, where Doorkeeper would honour the mode, as Mastodon does when it skips the
  consent page (Kopje never skips it). A blank mode (Rails' `blank?`) reads as `query`; any other value answers
  `unsupported_response_mode`. The metadata's `response_modes_supported` lists `query` only; Mastodon's lists `query`,
  `fragment` and `form_post` (`app/presenters/oauth_metadata_presenter.rb`, the modes Doorkeeper 5.8.2 registers in
  `lib/doorkeeper/grant_flow.rb`).
- `lang` has no effect: the consent page is English only.
- Tokens are read from the `Authorization` header only, never from the `access_token` or `bearer_token` parameters.
  Introspection reads its parameters from the body only: a `token`, `client_id` or `client_secret` in the query is
  absent (a query Rack refuses still answers 400).
- `token/info` `resource_owner_id` is the account id, a string (Mastodon: the integer user id).
- A suspended account's token is invalid at `token/info` and inactive at introspection; Mastodon shows it.
- Introspection ignores `token_type_hint`: Kopje has no refresh tokens, and every token is looked up as an access
  token. Doorkeeper with `token_type_hint=refresh_token` looks up refresh tokens and answers an access token inactive.
- Introspection with a bearer token: a revoked target of the same client answers 401 `invalid_token`, because Kopje
  deletes revoked tokens (Mastodon: `active: false`). A suspended or stale-epoch caller is refused with
  `invalid_token`, and an authorization code presented as the caller is `invalid_token` where Doorkeeper finds no
  caller (400). `invalid_client` carries Kopje's Basic challenge and text, as at `/oauth/token`.

Expired and revoked tokens on routes that need none (`GET /api/v1/donation_campaigns`,
`POST /api/v1/accounts/:account_id/email_subscriptions`; MD-3; AUTH-1 and AUTH-2 in [threat-model.md](threat-model.md)):

- A token past its expiry, revoked or of an earlier credential epoch is answered as no token while its owner is
  available: donation campaigns answers 422 and e-mail subscriptions its 404. Mastodon reads these two routes' token
  only through `Api::BaseController#current_user`, which takes the owner of the token row Doorkeeper finds by its
  value, expired or revoked, since neither controller checks the token (`doorkeeper_authorize!`). There, such a token
  of an available owner gets donation campaigns' 204. In Kopje such a token is no credential on any route: the Store
  refuses an expired one inside the operation and deletes a revoked one. The visible difference is only the status
  code of a feature-off answer. Accepted, 2026-11-15.
- A suspended owner's token answers 403 `Your login is currently disabled` while the Store holds its row, expired or of
  an earlier epoch alike, as Mastodon's `require_not_suspended!` answers before Doorkeeper's checks, on every API route
  but `GET /api/v1/instance`, `/api/v2/instance`, `/api/v1/instance/rules`, `/api/v1/instance/peers` and
  `/api/v1/instance/extended_description`, which read no token, as Mastodon's controllers there read a user only in
  limited federation mode, which Kopje does not have (AUTH-2). A row the Store no longer holds is no credential: it
  reads as no token where a route needs none, and as an invalid token (401) where one is needed. A revoked token is
  deleted at once, an expired one by the cron's sweep, and a suspension's tokens job deletes the account's tokens
  shortly after the suspension, so the 403 lasts until then and the tokens stay no credential after an unsuspension.
  Mastodon revokes nothing on a suspension and finds revoked and expired rows until its daily
  `Vacuum::AccessTokensVacuum`, so it answers 403 for the whole suspension. Accepted, 2026-11-15.
- `POST /api/v1/apps` with a suspended owner's token, expired or not, answers 403 where the registration limiter would
  answer 429: Kopje judges the token's owner on every answer of an anonymous route (AUTH-2), the limiter's included,
  while Mastodon 4.7.5's Rack::Attack throttles before the controller's `require_not_suspended!`. A request there with
  any other Bearer token, an unknown one included, costs one Store call (`checkNotSuspended`) even when the limiter
  refuses it. Accepted, 2026-11-15.

Remote interaction (`/authorize_interaction`, the subscribe template and the FEP-3b86 `Object` intent of WebFinger):

- Mastodon signs a signed-out browser in on the GET, then resolves `uri` on the GET and redirects to its web client's
  page for the account or status. Kopje's GET fetches nothing: it shows a form prefilled with `uri` (or `acct`), and
  the look-up is a POST, which sends a signed-out browser to sign in and back to the form. What it finds is shown on
  the page with a Follow button (for a status, its author's), and replies, favourites and boosts stay in clients.
- A status is shown only when an anonymous viewer may see it; Mastodon shows one the signed-in user may see.
- A URL whose fetch resolves nothing shows the stored account it names after a server error or no answer, and never a
  stored post, as Mastodon's `ResolveURLService` without a viewer (`authorize_interactions_controller.rb:33`).
- `uri` is used only when it is an http(s) URL or an address of at most 2,048 UTF-8 bytes; anything else leaves the
  form empty.
- Following or opening a post from the viewer's own server (a profile's Follow, a status's "Open on your server"):
  Mastodon's web client asks the named server, from the browser, for its WebFinger answer (by handle, by URL, or
  `https://<server>` for a server name) and opens the FEP-3b86 intent of the action (`Follow`, `Announce`, `Like`;
  `Object` for a reply or a vote), else `Object`, else the subscribe template, else `/authorize_interaction?uri={uri}`
  (Mastodon 4.7.5). Kopje's pages work without script and fetch nothing: the dialog's form names the server to a
  handoff page here, which links to `https://<server>/authorize_interaction?uri=<uri>` and shows the handle or URL to
  paste into that server's search, for a server whose template is another path. The server is accepted only as a bounded
  DNS name.
- The status page's embed code is offered in a dialog with a copy button (Mastodon's web client: the post's menu,
  "Embed"); the code is the oEmbed `html`, the same as Mastodon's.

WebFinger (`/.well-known/webfinger`; Mastodon's `WebfingerResource` and `WebfingerSerializer`):

- The instance actor answers for its URI (`/actor`) and for its handle, `acct:<domain>@<domain>`, whose username must
  be the domain exactly, as Mastodon's `account_from_acct` matches its own instance actor. Its `preferredUsername` is
  the domain, where Mastodon's is `mastodon.internal`, so its subject is `acct:<domain>@<domain>`. Account lookup,
  search, mentions and the public pages never find it. Mastodon asks for the instance actor before any local account;
  Kopje asks after, so a local account whose username is the domain (which conversion, import and configuration now
  refuse, threat model ID-5) keeps that handle, and the instance actor of such an instance has no handle answer.
- Every answer, a local account's and the instance actor's, has the `self` link, a `profile-page` link without a media
  type (the instance actor's to `/about`, where Mastodon links `/about/more?instance_actor=true`, which redirects
  there) and the subscribe template and FEP-3b86's `Object` intent, both to `/authorize_interaction`. There is no
  `Create` intent (Mastodon's `/share?text={content}`): Kopje has no web compose page, and posting happens in clients.
  The links come in Fedify's order, `self`, `profile-page`, the avatar, the subscribe template, `Object`; Mastodon's is
  `profile-page`, `self`, subscribe, `Create`, `Object`, the avatar. RFC 7033 makes order a preference only among
  links of one `rel`, and each answer has one link of each. Asked for a handle, its aliases are the actor id alone
  (Mastodon adds a local account's profile URL); asked for a URI, its subject is that URI, where Mastodon's is always
  the handle. It has no `Cache-Control` (Mastodon: public for 3 days, 3 minutes for a 400, 404 or 410).
- A resource that is the domain itself (`https://<domain>`, with or without a trailing `/`, `http://` or no scheme) has
  no answer (404, or 400 without a scheme); Mastodon answers its instance actor, and its web client, given only a
  server name, asks for `https://<domain>` and on a 404 opens `https://<domain>/authorize_interaction?uri={uri}`, which
  is Kopje's page.

Search (`/api/v2/search`, `/api/v1/accounts/search`):

- With `resolve=true`, an `acct:user@domain` query is resolved as `user@domain` is; Mastodon's `MENTION_RE` gate
  (`account_search_service.rb`, `username_complete?`) does not take the `acct:` form.
- `resolve=true` is ignored while the instance does not accept writes (the env's `MAINTENANCE=readonly`, the Store's
  readonly maintenance, an unpublished import): nothing is fetched, and the search answers from local data as without
  it. Mastodon has no such state and resolves whenever it is asked; Kopje could not store what it fetched then, and a
  remote server would see a fetch for nothing.
- With `resolve=true`, a URL lookup whose answer is empty whatever it finds (a `type` with an `offset` past 0, or a
  `type` other than `accounts`, `statuses` and `collections`, `hashtags` included) fetches nothing; Mastodon 4.7.5
  fetches and stores the resource first (`search_service.rb:19-20`). A remote server would see a fetch whose result no
  answer shows. Accepted, 2026-11-16.
- A `limit` or `offset` given as an array or a nested parameter (`limit[]=1`, `offset[a]=-1`) is not read: the search
  answers as without it, or 400 when the other one is negative. Mastodon 4.7.5 answers 500 to both, as its pagination
  check calls `to_i` on the array or hash. Accepted, 2026-11-17.
- An account search finds the accounts whose display name and address hold each word of the query as a substring: the
  query is normalized as stored names are (NFKC, lowercase, no variation selectors) and split at white space other than
  U+0085 (`queryTerms` in `src/domain/search-text.ts`). Mastodon 4.7.5's PostgreSQL search (`Account::Search`,
  `to_tsquery('simple')`) also splits at U+0085 and at the characters of emoji, and matches each word as the start of
  a word, so a query that wraps a username in them (`alice😀`) finds that account there, and in Kopje finds only an
  account whose display name holds the whole text. Splitting as Mastodon does inside Kopje's substring search would
  change which accounts existing queries find and in what order, and so the pages of their results. Accepted,
  2026-11-18.
- `/api/v2/search` finds no hashtag for a `q` that a hashtag's name normalizes to nothing (U+FEFF, an emoji). Mastodon
  4.7.5 without Elasticsearch finds every listable hashtag, up to `limit`: `Tag.matches_name` searches the names that
  start with the normalized term, and an empty term starts every name. A query of characters no hashtag can hold names
  no hashtag. `test/param-blank.test.ts` ("finds no hashtag for a q a hashtag's name normalizes to nothing").
  Accepted, 2026-11-18.
- `/api/v2/search` refuses an absent or blank `q` with 400 `Missing parameter q`; Mastodon's `params.require(:q)`
  answers `param is missing or the value is empty or invalid: q`. Accepted, 2026-11-18.
- A `q` sent as an array or a nested parameter (`q[]=a`, `q[a]=b`) answers 400 `Missing parameter q` on both searches,
  where an absent one finds no account at `/api/v1/accounts/search`, as in Mastodon. Mastodon 4.7.5 answers 500 to
  it, as its search services strip it (`AccountSearchService#call`, `SearchService#call`), but for an empty array at
  `/api/v2/search`, which `params.require(:q)` refuses with 400. `test/param-blank.test.ts` ("answers the account
  search nothing for a q absent or blank once stripped, without searching"). Accepted, 2026-11-18.
- `/api/v2/search` reads `account_id=` (empty) as absent. Mastodon with Elasticsearch looks the empty id up
  (`StatusesSearchService#convert_deprecated_options!`, `Account.find`) and answers 404; without it, it searches no
  statuses. Accepted, 2026-11-18.
- A URL that answers with an HTML page or another type is followed to the ActivityPub document its `Link` header or
  `<link rel="alternate">` names, as Mastodon 4.7.5's `FetchResourceService` follows it, with these differences
  (`src/federation/resolve.ts`):
  - Several `Link` header fields reach Kopje joined into one value, so an alternate in a later field can be taken
    where Mastodon reads the first field only; a value past 8,192 characters or 64 links is not read (the page's
    alternate is then tried).
  - No page alternate is taken at or after a `<noscript>`, `<select>`, `<template>`, `<table>`, `<svg>` or `<math>`
    start tag or a `<link>` whose `rel` is past 2,048 characters decoded or 8,192 as written, nor on a page holding
    `<frameset>` bytes or one the scanner fails on: there workerd's HTMLRewriter cannot place a `<link>` as Mastodon's
    Nokogiri HTML5 tree does (in presence or in order), so Kopje resolves nothing where Mastodon may resolve, never
    another document. An href past 2,048 characters decoded or 8,192 as written resolves nothing too, however short its
    character references decode (Mastodon decodes any length).
  - The page and both alternates are charged to the request's 8 fetches and 2 MiB of fetched bytes, as are the
    actor's fetch and the WebFinger answers that confirm its handle after them, so a page alternate after a large
    header alternate, or a confirmation after them, can be refused for that budget, and a new actor whose
    confirmation is refused so is not stored; Mastodon has no request-wide budget.
  - A failure Kopje adds to Mastodon's on a header alternate (the domain policy, which Mastodon applies only after
    fetching, or a document past the JSON bounds) ends the resolution with nothing instead of trying the page.
  - The first request keeps the document fetch's redirect rule (same origin, at most 5), where Mastodon follows 3 hops
    to any origin; the alternates follow none, as Mastodon's.
- With `resolve=true`, a URL whose fetches resolve nothing is answered from stored data as Mastodon 4.7.5's
  `ResolveURLService#process_url_from_db` answers it: the stored account whose uri it is after a 500, 502, 503, 504 or
  no answer to the last of them; the stored post whose uri it is, or, for an address `/@user/id`, whose uri is
  `/users/user/statuses/id` on the same host and whose url it is, after a 401, 403 or 404; nothing otherwise, and
  nothing stored is removed. A fetch Kopje refuses before it is sent (the domain policy, the request's fetches or
  deadline, a redirect to another origin or past 5) counts as no answer and keeps the earlier answer, as Mastodon
  counts a connection error; an answer whose body the request's bytes cut counts as its status, as Mastodon records
  the status before it reads the body within its limit. A boost is never answered, here or for a status page URL of
  this instance (Mastodon's lookup by uri may find one by its `Announce` id, and its status page route by its id).
- With `resolve=true`, a URL of this instance is read on Kopje's routes as Mastodon 4.7.5's router reads its own, with
  three differences. `/@user@<this domain>` finds the local account, as Kopje's profile page serves that spelling,
  where Mastodon routes it to its web app and finds no account (`Account.find_remote` with its own domain,
  `resolve_url_service.rb:116`). A status id in the URL is matched as written (an API id or a legacy id), where
  Mastodon casts it as Rails casts an integer, so `0123` or `123-x` finds status 123. A URL that RFC 3986 does not
  admit (a space, `|`, `\`, a character outside ASCII, a `%` without two hex digits) finds nothing, where Mastodon's
  search answers 404: its router cannot parse the URL and raises `ActionController::RoutingError`.

Polls (`GET /api/v1/polls/:id`):

- A signed-in read of a remote poll refreshes it from its post's document, applied as its author's `Update`, when
  Mastodon 4.7.5's `Poll#possibly_stale?` holds (no `Update` applied since its end, and the last one applied more than
  a minute ago). An attempt is reserved before its fetch, so a poll is fetched at most once a minute however many users
  read it, and after an attempt of any outcome the next waits more than a minute too; Mastodon tries again at every
  read until one applies. A refresh whose poll was written after its attempt began (a vote, another `Update`) applies
  nothing.
- A refresh that fails answers the poll as stored, where Mastodon answers 503 after a connection error or timeout.
- A public or unlisted post's document is fetched as the instance actor, another's as the reader, where Mastodon signs
  every refresh as the reader: the refresh of a poll anyone may see then tells its server nothing about who read it,
  as search's fetches do, while a private, direct or limited post is reached only with the reader's access, which its
  server already knows. When the fetch is refused (by the remote server, or by Kopje's domain policy), nothing is
  refreshed, the poll is answered as stored, and the next refresh waits a minute; the other signer is not tried.
- Nothing is fetched while the instance does not accept writes.

Hashtags (the `Tag` entity):

- A hashtag's name is Mastodon's `HashtagNormalizer#normalize` applied twice (`normalizeTag`), so that normalizing a
  name gives it back. One pass (`normalizeOnce`) is NFKC; each code point lowercased on its own (Ruby's
  `String#downcase`, with no final-sigma rule); each letter in Mastodon's `ASCIIFolding` table replaced by its ASCII
  letter (a fixed table, not every diacritic: Japanese dakuten stay); and every character
  `Tag::HASHTAG_INVALID_CHARS_RE` matches dropped, keeping only Alphabetic characters, decimal digits, Thai U+0E47 to
  U+0E4E and the separators `_`, U+00B7, U+30FB and U+200C, so `#` and its fullwidth and small forms go. A name with
  nothing left is no hashtag. The single pass is not a fixed point where a character it drops, or marks it reorders,
  leave two characters that compose: U+1100 U+0301 U+1161 gives U+1100 U+1161, a tag apart from U+AC00 in Mastodon, and
  Kopje names both U+AC00. Every spelling of a tag, the single pass's included, reaches that one name in a status, a
  follow, a featured hashtag, a timeline, a page and a search, and a received post is filed under it whatever its
  `Hashtag`'s `href` names. Migration 0087 renamed and merged the names stored before it without sending an activity, so
  a Mastodon follower of an account whose two featured hashtags it merged may keep both.
- A post's hashtags are found as Mastodon 4.7.5's `Tag::HASHTAG_RE` finds them, over the whole text: `#` or `＃` at
  the text's start or after whitespace (`src/domain/status-text.ts`). Mastodon then drops an `http` or `https` ending
  from a hashtag followed by `://` (`Extractor#extract_hashtags_with_indices`), which Kopje keeps:
  `#taghttps://example.com` is the hashtag `taghttps`, where Mastodon's is `tag`.
- `history` is counted again on every read from the stored statuses: public originals, by the UTC day of their
  publication (Mastodon counts a status on the day it receives it), with `accounts` exact (Mastodon's is a HyperLogLog
  estimate). A deleted status and the statuses of an unavailable author leave the counts (Mastodon never decrements
  them, and leaves out silenced accounts; Kopje has no silencing); an edit counts under its current hashtags (Mastodon
  counts a status at posting only); there is no `usable` flag, so every hashtag is counted. The counts are the same
  for every viewer, whatever they block or mute.
- `GET /api/v1/tags/:id` and the writes on one hashtag count every public status of the 7 days. The lists count at
  most the hashtag's newest public entries of the 7 days, taken before the rule above: 20 in v2 search hashtags,
  `followed_tags` and `featured_tags/suggestions`, 200 in the trends lists (MD-5). Newer public boosts and statuses of
  unavailable authors take those places, so a list can count fewer than the single hashtag does.
- `featured_tags/suggestions` reads the newest 1,000 of the account's statuses of the last year, as Mastodon 4.7.5
  does, but a deleted status whose removal is still pending keeps its place among them and counts no hashtag, so it
  can read fewer than the newest 1,000 statuses Mastodon reads, which leave deleted ones out. The year starts at the
  request's millisecond; Mastodon's at a random millisecond of that second.
- A hashtag name, normalized, is at most 256 code points and 1,024 UTF-8 bytes to be followed or featured (and a
  featured hashtag's spelling too), the bound a status's hashtags are read by; past it the write answers 422 `Name is
  too long (maximum is 256 characters)`, even for a name the account already holds (an import's), and a remote
  account's featured hashtag past it is not learned. Mastodon validates only the name's format (`Tag`'s
  `HASHTAG_NAME_RE`). Every hashtag list (followed, suggestions, featured, the actor's `featuredTags`, trends) leaves
  out a stored name past the bound, with a NUL, or whose bytes are not well-formed UTF-8; a page of followed hashtags
  still pages by the follows it read. v2 search leaves out only names past the bound, before its page, and shows a
  malformed name decoded (U+FFFD for a stray byte), identified by its stored bytes, so it pages by offset with no
  repeat or gap.
- `/tags/:name` (Mastodon's `TagsController#show`) is an HTML page of the hashtag's local public statuses, newest first,
  whatever the request's `Accept`: Mastodon also serves an ActivityPub collection and an RSS feed of them there, and its
  HTML is the web app. Any spelling of a name serves the page of its normalized name, which the page names as canonical,
  without a redirect. A hashtag with no statuses Kopje shows is an empty page, since Kopje keeps no table of hashtags
  (Mastodon answers 404 for a hashtag it has no usable record of); a name past the bound above answers 404.
- `/@user/:id` shows the status with its ancestors an anonymous visitor may see (of the 40 nearest, as the API's
  anonymous context reads them) and its direct replies, oldest first, 20 a page, paged by status id ("Earlier
  replies" by `max_id`, "Later replies" by `min_id`); a reply's own replies are on its page. Mastodon's web app shows
  the whole context at once, its descendants as a tree.
- `/@user/:id/reblogs`, `/favourites` and `/quotes` (routes of Mastodon's single-page app) are HTML pages of the
  status: who boosted it, who favourited it and its quotes, as `GET /api/v1/statuses/:id/reblogged_by`,
  `/favourited_by` and `/quotes` list them to an anonymous client, newest first, paged both ways by those endpoints'
  cursors (40 accounts or 20 quotes a page). Mastodon's quotes endpoint asks for a token, but an app token without a
  user reads the same anonymous scope, which the page shows without one.
- `/@user/featured` (the Featured tab of Mastodon's web app, which serves its single-page app there) is an HTML page of
  a local account's featured hashtags and the accounts it endorses, as `GET /api/v1/accounts/:id/featured_tags` and
  `/endorsements` list them to an anonymous client, the endorsements paged by account id. A featured hashtag links to
  the instance's hashtag page (`/tags/:name`), not to the account's posts with it (`/@user/tagged/:tag`), and shows at
  most ten hashtags, the first by id, though an import may hold more.

Admin account actions (`POST /api/v1/admin/accounts/:account_id/action`):

- No email is sent: Kopje has no mailer. `send_email_notification` decides only whether a local target is warned (a
  `moderation_warning` notification), read as Rails casts it: absent is true; empty, JSON `null` and `0`, `f`, `F`,
  `false`, `FALSE`, `off`, `OFF` are false; anything else (`False` and `Off` included) is true.
- `text` is at most 10,000 UTF-8 bytes with no NUL (422 `Validation failed: Text must be at most 10,000 UTF-8 bytes
  with no NUL`, before any write); Mastodon has no bound, and a NUL is its 500.
- Kopje has no warning presets, so any non-blank `warning_preset_id` answers 404 `Record not found` with no effect, as
  an unknown one does in Mastodon.
- Whether the target is notified is judged in the action's own transaction; Mastodon judges it when its
  `LocalNotificationWorker` runs. A target suspended between the action and that worker gets no notification in
  Mastodon, while Kopje's is hidden only while the suspension lasts; a target suspended at the action and unsuspended
  before that worker runs is notified in Mastodon, never in Kopje.
- A warning's `appeal` is always `null`: there are no disputes, through which Mastodon files appeals.
- A warning's `status_ids` is `null` when the named report's stored `status_ids` are not a list of at most 100 18-digit
  ids (only a restored report can hold that); the action still succeeds.
- Mastodon keeps a strike for `suspend`, for a remote target and with the notification off; Kopje keeps none of them.
  Mastodon's API never shows the last two, and a suspension's only when the target is unsuspended before
  `LocalNotificationWorker` runs.

Remote suspension and instance domain blocks (`POST /api/v1/admin/accounts/:account_id/action` and `/unsuspend` for a
remote account, `/api/v1/admin/domain_blocks`; R38 in [visibility.md](visibility.md)):

- A `suspend` block deletes no content of the accounts it covers: they are unavailable while it lasts, and their
  statuses and profiles show again once it is lifted. Mastodon's `BlockDomainService#suspend_accounts!` runs
  `DeleteAccountService`, which keeps only the statuses its unresolved reports name, discarded in Mastodon 4.7.5
  (`deleted_at` set, for its moderators alone).
- A child `noop` block exempts the accounts of its subdomains from a parent's `suspend`; Mastodon suspends
  `Account.by_domain_and_subdomains` of the suspending block.
- Severing writes no `severed_relationships` notification (Mastodon's `block_domain_service.rb` writes them).
- Severity `silence` is refused with 422 on create and update.
- A host is ruled and claimed without every trailing dot: the block of `blocked.example` covers an actor, an inbox or a
  fetch on `blocked.example..`, and an actor whose id is there claims `<username>@blocked.example`, stored once
  WebFinger confirms it (`hostDomain` in `src/platform/domain-name.ts`, `uriHostSql` in `src/domain/audience.ts`; R38 in
  [visibility.md](visibility.md), "Instance domain blocks"). The id, its inboxes and every other stored URL keep their
  dots. Mastodon 4.7.5 reads such a host through Addressable 2.9.2's `normalized_host` (`tag_manager.rb:17-23`,
  `process_account_service.rb:143`), which drops a single trailing dot and keeps two or more, so there an actor on
  `blocked.example..` claims a handle on that domain of its own; its block of `blocked.example` still covers it, as
  `DomainBlock.rule_for` matches the host's `domain_variants`, whose `split('.')` drops every trailing empty label
  (`domain_block.rb:68-75`, `domain_normalizable.rb:21-24`). Kopje keeps one key for every check, in the Worker and in
  SQL, and the handle on the domain without its dots. Accepted, 2026-11-17.
- A suspended actor's `Update` is not applied, as no profile of an unavailable account is refreshed; Mastodon's
  `process_collection_service.rb` applies it.
- Unsuspension does not fetch the account again; Mastodon's `unsuspend_account_service.rb` refetches it.
- Nothing but retractions is sent to an unavailable account (VIS-30's send-time check); a `Follow` of a local
  account's, a local account's `Accept` of the account's follow, or a local account's `Reject` of the account's
  request, that the check drops is held and sent once the account is available again (visibility.md, "Held
  handshakes"). Mastodon's `ActivityPub::DeliveryWorker` has no such check and sends them during the suspension
  (`RejectFollowService` queues its `Reject` through `DeliveryWorker`, `reject_follow_service.rb:15-17`, which checks
  only the inbox's availability, `delivery_worker.rb:25-36`).
- A local account holds at most 100 refused `Reject`s of requests (`HELD_REJECTS_PER_ACCOUNT`); past it, a further
  `Reject` of a new pair to an unavailable requester is dropped, the owner's own included while the account is
  saturated. Mastodon sends each one. The cap is set by storage and recheck load.
- Unsuspending an individually suspended account that a `suspend` block covers converts its suspension to a domain
  mark and keeps it unavailable, and an account held by a domain mark alone answers 403. Mastodon's admin unsuspend
  clears the suspension directly, and `UnblockDomainService` lifts only suspensions whose timestamp equals the block's
  `created_at`, so there an individual suspension with any other timestamp survives the unblock, as Kopje's
  individual suspension does (`account` wins), and one with that timestamp does not.

Notification fallbacks (`supported_types`, Mastodon 4.7.5's `NotificationFallbackConcern`):

- The summary of an `admin.report`, a `moderation_warning` and a collection notification is `You're on an app that does
  not support the most recent version of Mastodon. Visit <domain>.`, the link to the instance's front page. Mastodon's
  link reads `Sign in to the Mastodon web app` (with `for full functionality` after it in the generic summary), and a
  `moderation_warning`'s goes to the strike's dispute page; Kopje has neither a web app nor disputes. Accepted,
  2026-11-15.
- Only `admin.report`, `moderation_warning`, `added_to_collection` and `collection_update` carry one: Kopje writes no
  other type outside Mastodon's baseline, and a restored row of another such type has none.
- A `collection_update`'s title names the collection's owner by its mention link, as an `added_to_collection`'s does,
  where Mastodon interpolates the account object (its default text). A Web Push of either collection type is titled
  with its fallback sentence and the owner's display name, where Mastodon's title is a missing-translation text.
  Accepted, 2026-11-16.
- A title names an account within the presented bounds (RES-2): its username as `usernameSql` reads it, within 255
  bytes, a remote reporter's domain within 253, and a remote account's link only when its stored url parses as http(s)
  within `PROFILE_URL_LIMIT` once serialized, else `href=""`; Mastodon writes the stored values whole.

Web Push (`/api/v1/push/subscription` and the pushes sent; PUSH-1 and PUSH-2 in [threat-model.md](threat-model.md)):

- A push's title is Mastodon's English subject for its type (`TITLES` in `src/domain/push.ts`), but a
  `moderation_warning`'s and a `quoted_update`'s is the account's name alone; Mastodon's are `You have received a
  moderation warning` and `<name> edited a post you have quoted` (`notification_mailer` in `config/locales/en.yml`).
- A subscription whose `endpoint`, `keys[p256dh]` or `keys[auth]` is absent or empty answers 400 `param is missing or
  the value is empty or invalid: subscription`. Mastodon answers that only to a `subscription` absent or holding none
  of its fields; it answers 500 to one without `keys` (an `endpoint` alone: `subscriptions_controller.rb:54` reads
  `auth` of the missing `keys`), and 422 `… can't be blank` to one with `keys` that lacks a value, as Kopje does for a
  value blank to Rails (U+0085). Kopje answers the first failing check, in Mastodon's order (the endpoint's presence
  and URL, each key's presence, the keys), where Mastodon lists every error; a blank endpoint fails both of its own
  and answers both, `Endpoint can't be blank, Endpoint is invalid`, as Mastodon does beside valid keys. Keys that do
  not decode answer `Key p256dh is invalid` or `Key auth is invalid`, where Mastodon's error is `is not a valid Ed25519
  or Curve25519 key`, and an endpoint that is not a public https URL (PUSH-2) answers `Endpoint is invalid`, where
  Mastodon's URL validator takes any http(s) URL with a host. `test/param-blank.test.ts` ("refuses an endpoint or key
  blank to Rails as blank, before the keys are read"). Accepted, 2026-11-18.
- An empty `data[policy]` is `all`, and a policy other than `all`, `followed`, `follower` and `none` answers 422
  `Validation failed: Policy is not included in the list`, on an update before the subscription is looked up, so also
  for a token with none. Mastodon validates no policy: it stores the value as sent, shows it, and lets no push through
  for an empty or unknown one (`Web::PushSubscription#policy_allows_notification?`), and answers an update with no
  subscription 404 `Not Found` whatever its data. Accepted, 2026-11-18.

Request parameters:

- The query and a urlencoded or multipart body are each read as Rack and Rails nest them, in the order sent (a POST body
  without a media type as a urlencoded one, as Rack reads it; a `Content-Type` header sent empty is read the same way,
  where Mastodon answers 406): a name nested as two kinds (`limit=1&limit[]=2`) answers 400, as Mastodon's does, and a
  later plain name replaces what an earlier one built under it (`limit[]=2&limit=1` reads `limit` as 1). Kopje answers
  that 400 on the routes that read their parameters, after the token where the route checks one; Mastodon answers it on
  every route, before the token, as Rack::Attack reads every request's parameters in a middleware. The routes that read
  their query on their own do not refuse it: the account lookup, oEmbed and the peer search, and Kopje's own pages,
  which read the first of a repeated name (the public pages' `max_id`, `min_id` and `server`, `/login`,
  `/auth/callback`, `/settings` and the admin pages); nor do the routes that read no parameter. A query or a urlencoded
  body past one of Rack's limits (more than 4,096 fields, more than 4 MiB), and a multipart body of 4,096 parts or 128
  file parts, are 400, where Mastodon answers 500; a part with an empty filename, which Rack counts as a file part,
  counts as a text part. A multipart text part that is not UTF-8 is read with each bad sequence replaced, where Rails
  answers 400, as Kopje does for the query and a urlencoded body; a multipart part with an empty name answers 400, where
  Rack reads it under its filename or its content type and `[]` (`text/plain[]`).
- An array parameter's objects (`media_attributes`, `keywords_attributes`, `fields_attributes`) are read as Rails'
  strong parameters permit them, but for two kinds: a Hash with no index holding an object
  (`keywords_attributes[id]=1&keywords_attributes[keyword]=a`, or its JSON) is read as no object, where Rails permits it
  as one, whose values Mastodon then reads as the objects (answering 500 for a value that is not one) or, for
  `keywords_attributes` holding an `id`, as the keyword to update; and a JSON body's objects under indexes
  (`{"fields_attributes":{"1":{…},"0":{…}}}`) are read in index order, where Mastodon reads them in the order sent, as
  Kopje does a form's.
- Of repeated parts of a declared file parameter (`avatar`, `header`, `file`, `thumbnail`), text or file, the last is
  the one read, as Rails assigns them; on `/api/v{1,2}/media` a file followed by a string answers 422
  `File can't be blank`, where Mastodon answers 400. While video and audio uploads are active
  ([media-processor.md](media-processor.md)), a request whose first `file` part is video or audio answers 422
  `Validation failed: File was sent more than once` to any later `file` part, file or text, where Mastodon takes the
  last.
- A query value of a declared file parameter is read only when the body has none (Rails lets the query win).
- An integer parameter (`limit`, `offset`, a mute's `duration`, a filter's `expires_in`, `poll[expires_in]`, oEmbed's
  `maxwidth` and `maxheight`) whose `to_i` is past 9,007,199,254,740,991 (2^53 − 1) is read as that, where Ruby reads
  any length: oEmbed's `width` and `height` show 9,007,199,254,740,991 for a larger `maxwidth` or `maxheight`, where
  Mastodon shows the number sent. A JSON number past a Float's range (`1e400`) is read as that too, where Mastodon
  answers 500.
- A vote choice Ruby's `Integer()` cannot read (`08`, `1.5`, `1e0`, text after the number) answers 422 `Validation
  failed: The chosen vote option does not exist`, and an empty one is dropped (with none left, the choices are missing:
  400), where Mastodon answers 500 for either. A choice holding a NUL character is refused too, where Ruby reads some
  (`"0b1_0\u0000junk"` is 2). Accepted, 2026-11-17.
- A `limit` whose `to_i` is 0 (`0`, `-0`, `abc`) answers `[]` without a `Link` on the timelines and the notifications
  (v1 and v2), as Mastodon's do, and reads as 1 on the other lists paged by `max_id`, `since_id` and `min_id`: an
  account's statuses, followers, following and endorsements, bookmarks, favourites, conversations, blocks, mutes, domain
  blocks, follow requests, endorsements and a list's members (but `limit=0`, which answers every item, as Mastodon's
  do), a status's favourites, boosts and quotes, scheduled statuses, followed hashtags, notification requests, a
  notification group's accounts, and the admin reports, accounts and domain blocks. Mastodon 4.7.5 answers 500 on those,
  as `records_continue?` holds for the empty page and its cursor is read (`Api::Pagination#pagination_max_id`).
- A cursor (`max_id`, `since_id`, `min_id`, each the last value sent) is read only as 1 to 19 decimal digits (`CURSOR`
  in `src/mastodon/pagination.ts`); any other value is ignored, as if absent, and a 19-digit value past a signed 64-bit
  integer is a cursor like any other, with no range refusal of its own. Mastodon casts it on each path: a list it reads
  from its database by ActiveModel's integer type (`Paginable`, so `5abc` reads as 5), the home and list timelines by
  `String#to_i` (`Feed#get`, so `max_id=abc` reads as 0, an empty page, and any length is read whole).
  `test/pagination-params.test.ts` ("cursors"). Accepted, 2026-11-18.
- The body of a `GET` (or `HEAD`) request is not read; Mastodon reads a `GET`'s JSON body as its parameters too, so
  `{"limit":1}` sent with a `GET` of a list limits its page there. Accepted, 2026-11-18.
- An array parameter of a filter sent as one value without `[]` (`context=public` on `POST /api/v1/filters` or
  `/api/v2/filters`) is read as a list holding it. Mastodon's strong parameters permit `context` only as an array
  (`context: []`) and drop a single value, so the filter has no context and answers 422. Accepted, 2026-11-18.
- A JSON body holding an unpaired surrogate escape (`"\ud800"`) is read with that code unit, which the Store keeps as
  U+FFFD. Mastodon refuses it as Rails reads it: 400 for one in a value (its parser, json 2.21.2, refuses a high
  surrogate no low one follows, and Rails a lone low one's invalid UTF-8) and 500 for a lone low surrogate only in a
  key, as for an inbox body ("Reading inbound activities", below). Accepted, 2026-11-18.
- Text holding a NUL is stored as sent: a list's title, a filter's title, a keyword, a v1 filter's phrase, a report's
  comment and an account note. An account note that starts with a NUL (`{"comment":"\u0000"}`), which the Store's
  length check reads as empty (SQLite's `length()` stops at the first NUL), answers 422 `Validation failed: Comment
  can't start with a NUL character`. A collection's name, whose NULs are dropped before its presence is judged, of
  NULs alone answers 422 `Validation failed: Name can't be blank`. Mastodon answers 500 to each, as PostgreSQL refuses
  a string with a null byte. Accepted, 2026-11-18.
- A marker's `last_read_id` (`POST /api/v1/markers`) is kept as sent, up to `MAX_LAST_READ_ID` characters
  (`src/domain/markers.ts`); one that starts with a NUL, which the Store's length check reads as empty, answers 422
  `Validation failed: Last read can't start with a NUL character`. Mastodon reads it as a bigint (Ruby's `to_i`, so
  `abc` and a value that starts with a NUL as 0) and answers 200. Accepted, 2026-11-18.
- A report's `category` that is not blank and names no category (U+FEFF, an emoji, a NUL) answers 422 `Validation
  failed: Category is not included in the list`; Mastodon answers 500, as assigning a value its `category` enum does
  not hold raises `ArgumentError`. Accepted, 2026-11-18.
- A domain sent to a domain block (`/api/v1/domain_blocks` and its preview, `/api/v1/admin/domain_blocks`) is
  trimmed of JavaScript's white space before it is normalized; Mastodon's `TagManager#normalize_domain` (through
  `DomainNormalizable`) strips it as Ruby strips (NUL and ASCII white space only), so other white space around it
  (U+00A0, U+3000, U+FEFF) reaches its host encoding and domain validator. Accepted, 2026-11-18.
- `GET /api/v1/domain_blocks/preview` answers 400 to an absent `domain` or one empty once trimmed (JavaScript's white
  space, U+FEFF included). Mastodon's preview requires none and counts the accounts whose domain is the one it
  normalizes, `nil` for an absent one, so it counts the local accounts followed and following. Accepted, 2026-11-18.
- `thumbnail` on an image (`/api/v{1,2}/media`, `/api/v1/media/:id`) and `media_attributes[][thumbnail]` on a status
  edit, for any attachment, answer 422 `Validation failed: Thumbnail must be blank`; Mastodon accepts the edit's for a
  video or audio attachment, which Kopje refuses for every input, a multipart file or a data URI, as an attached
  upload's thumbnail would need an edit-time Images run and an `Update`. A video's or audio file's thumbnail on upload
  and on `/api/v1/media/:id` is the "Media" section's. Any file part or non-empty text is a thumbnail; empty text or
  JSON `null` is none on an image. Text that is not a data URI answers 422, where Mastodon answers 500. The check runs
  before the file is processed on an upload, after the media is found on `/api/v1/media/:id` (as Mastodon: media that
  is not the caller's unattached media answers 404 first), and on an edit after the status is found and before
  `media_ids` are looked up, for any entry with an `id` (Mastodon reads only entries for the post's media).
  Mastodon may report other validation errors first or alongside it. On `/api/v1/media/:id`, a multipart body holding
  more than 1 MiB plus 16 KiB besides a `thumbnail` file of up to 16 MB answers 413, and so does a malformed one
  larger than that.
- `PUT /api/v1/media/:id` judges its form (the description's length, then a thumbnail against the media's type, once
  the media is found) before the upload's processing state, so a form it refuses answers that 422 for a failed video
  or audio upload too, where Mastodon's `check_processing` answers 422 `Error processing thumbnail for uploaded media`
  first. Either way nothing is written or charged.
- An upload (`/api/v{1,2}/media`, `/api/v1/media/:id`) with more than 16 text pairs as sent (the query's
  included), or with a text value other than `description` and `thumbnail` longer than 20,000 UTF-16 code units, answers
  422 `Validation failed: A form field is too long`, so a small image cannot carry megabytes of text (RES-1); Mastodon
  has no such bound.
- A request whose parameters Kopje refuses as Rack does (a conflicting shape, past a Rack limit) answers 400 with a
  JSON `error` (`Malformed request body`), where Mastodon answers an empty HTML page.
- A multipart part with an empty filename is read as a text value, as workerd's parser reads it (Rack drops it as an
  empty file field): empty, it reads as absent; with bytes, a profile image answers 400.
- A JSON body exceeding 10,000 generated parameter paths (object members, array objects and empty arrays; scalar
  array items do not count), or the 2,097,152 UTF-16 code-unit flattening budget, answers 413, as does a query or a
  form body whose nesting passes the same paths (each name built or assigned, a replacing one included) or code units;
  Mastodon reads any number. Nesting beyond 32 levels answers 400 (Rack's `param_depth_limit`).
- An empty JSON object counts as sent: `{"fields_attributes":{}}` clears the fields and `{"home":{}}` saves the home
  marker, as in Mastodon; `{"poll":{}}` is still no poll.

Paged status lists with request conditions:

- `GET /api/v1/accounts/:id/statuses` with `only_media`, `tagged`, `exclude_replies`, or `exclude_direct` with
  `exclude_reblogs`, `GET /api/v1/timelines/tag/:hashtag` with `local`, `remote`, `only_media`, `all` or `none`, the
  profile's Posts, Media and tagged tabs and `/tags/:name` read at most 2,000 index entries within the audience a page
  before applying the conditions ([visibility.md](visibility.md), "Read bounds"). A page whose budget runs out first
  holds what it found, possibly nothing, and its `Link` continues from the last entry read: `next` by `max_id` (`prev`
  by `min_id` for a `min_id` request). Mastodon applies the conditions in SQL and answers a full page, sending `next`
  only when the page is full (`AccountStatusesFilter#results`, `TagFeed#get`, `records_continue?`). Clients that page by
  `Link` reach every status; one that stops at a short or empty page stops early. Accepted, 2026-11-11.
- The `Link` of `GET /api/v1/accounts/:id/statuses` keeps `exclude_direct`, as it keeps every other parameter, so the
  next page leaves direct posts out too. Mastodon's drops it (`AccountStatusesFilter::KEYS` lacks it), so its next page
  lists them.

Notification policy (`PATCH`/`PUT /api/v1/notifications/policy` and `/api/v2/notifications/policy`; the policy's
conditions themselves follow 4.7.5):

- The v1 booleans (`filter_not_following`, `filter_not_followers`, `filter_new_accounts`, `filter_private_mentions`,
  `filter_bots`) are read as Rails casts booleans: `0`, `f`, `F`, `false`, `FALSE`, `off`, `OFF` and a blank value
  accept. Mastodon's setters take any value Ruby holds true (`notification_policy.rb`), so a form's `false`, `0` or
  `off` filters there and only JSON `false` or `null` accepts; clients mean these values as booleans. Accepted,
  2026-11-15.
- A v2 value (`for_not_following`, `for_not_followers`, `for_new_accounts`, `for_private_mentions`,
  `for_limited_accounts`, `for_bots`) other than `accept`, `filter`, `drop` or 0 to 2 answers 422
  `'<value>' is not a valid <field>` and changes nothing. Mastodon's enum raises an error no handler rescues, so it
  answers 500. Accepted, 2026-11-15.

Notifications and timelines (`GET /api/v1/notifications`, `/api/v1/timelines/home`, `/list/:id`, `/public` and
`/tag/:hashtag`):

- A page links `next` when it is full or was cut (`Page.cut`: its read stopped at its byte or candidate bound, so a
  page short of its `limit`, even an empty one, continues from where the read stopped), and `prev` whenever it has an
  item. An uncut page short of its `limit` has no `next` and is the end. Every Kopje list paged by `max_id` shares
  this rule (`linkHeader` and `pageResponse` in `src/mastodon/pagination.ts`), which is Mastodon's on its other lists
  (`next_path` with `records_continue?`). On these five Mastodon 4.7.5 links `next` whenever the page is not empty:
  `Api::V1::NotificationsController#next_path` (`notifications_controller.rb:75-76`) and the timelines'
  `next_path`, which has no condition, behind `Api::V1::Timelines::BaseController`, which skips the `Link` of an empty
  page alone. A client that follows `next` past an uncut short page there reads an empty page, where Kopje's has no
  `next` to follow. The link timeline builds its own `Link` with Mastodon's rule. Accepted, 2026-11-18.

Grouped notifications (`GET /api/v2/notifications`; the bounds and what enforces them are RES-7 in
[threat-model.md](threat-model.md)):

- A page's walk reads at most 2,000 notifications (`GROUP_WALK`), shown or hidden; a page whose walk meets more of the
  groups it has found (in practice a status favourited by thousands within a few hours) holds the groups found and its
  `Link` continues from the last notification read. A group's count, samples and newest are of the shown among its
  newest 400 notifications up to the page's upper end, shown or hidden (`GROUP_COUNT`), with the notification the page's
  walk found it by when those leave it out, so a larger group counts at most 400; its oldest is the first shown among
  its 400 oldest from the page's lower end up, or the notification the walk found it by when none is. Mastodon reads
  every notification of the group in the page's range (`NotificationGroup.load_groups_data`).
- A page's group reads share one work budget across the passes that admit it again after a byte cut. A page whose
  reads would pass it is shorter: it holds the groups its last pass admitted, from the first, as far as the reads it
  made hold for a page that ends there (its statuses matched against keyword filters within the text allowance of the
  requested page, not of a page asked for with that many groups), or else its first group alone (with the groups
  before it that show nothing), and its `Link` continues from its last group's discovery position, so the next page
  finds the rest. This shortens a page whose groups hold more than about 6,000 / `limit` notifications each (fewer
  when the rule hides some of their oldest), or one cut by bytes after more than 40 groups. Mastodon has no such
  bound. Accepted, 2026-11-14.

Home and lists (`/api/v1/timelines/home`, `/api/v1/timelines/list/:id` and their streams; Mastodon's
`FeedManager#add_to_feed`):

- Every boost by a followed account that passes the follow's options is shown and streamed, also when the original or
  another boost of it is among the newer entries. Mastodon leaves such a boost out, unstreamed, when the original or a
  boost of it is among the 80 newest entries of the feed as the boost arrives (`REBLOG_FALLOFF`; 40 before 4.7), unless
  the user turned off its web preference `aggregate_reblogs` (on by default). Kopje reads home and lists from stored
  statuses on each request and keeps no record of a feed's order at the time a boost arrived. Accepted, 2026-11-15.
- Once a remote account's `Undo` of its `Accept` turns a local account's follow of it back into a request, home no
  longer shows the statuses the follow brought there, those received before included, as home reads them from accepted
  follows on each request; one that reaches home otherwise stays (a public status under a hashtag the local account
  follows). Mastodon's `revoke_request!` ends the follow without unmerging the home feed (`follow.rb`), so the statuses
  merged before stay in home until they fall off. Accepted, 2026-11-18.
- The same `Undo` takes the account out of the local account's lists, and a list then shows none of its statuses,
  those received before included, as a list is read on each request from its members the local account follows
  (accepted). Mastodon's list membership goes by its foreign key's cascade, which unmerges nothing, and its list
  endpoint reads the list's feed as it was merged (`Api::V1::Timelines::ListController`, `ListFeed`), so those statuses
  stay in the list until they fall off. Accepted, 2026-11-18.

Feed streams (the `public*` and `hashtag*` streams of `/api/v1/streaming`; Mastodon's `FanOutOnWriteService` and its
streaming server's per-connection filter; R33 in [visibility.md](visibility.md)):

- A status on `public*` and `hashtag*` is presented as REST presents it to the subscriber: its `favourited`,
  `reblogged`, `muted`, `bookmarked`, `pinned`, poll `voted` and `own_votes`, quote approval, quote state, card
  `missing_attribution` and the accounts' `feature_approval.current_user` are the subscriber's, and `filtered` follows
  REST's filters (keyword and status filters, every match). Mastodon renders these streams once with no viewer (the
  flags and votes absent, quote approval and feature approval `denied`, quotes judged for a signed-out reader) and adds
  `filtered` from keyword filters alone; Mastodon's web client, which replaces the status on `status.update`, then shows
  the subscriber's favourite and bookmark as unset (Elk replaces the text and keeps its marks).
  Kopje's payload is what the subscriber's next read shows (`test/streaming/public.test.ts`). Accepted, 2026-11-16.

Admin measures and retention (`POST /api/v1/admin/measures` and `/retention`; the keys not served are MD-2):

- `instance_media_attachments` is always 0 bytes (`human_value` `0 Bytes`): Kopje does not count its cache of remote
  attachments' files, which `kopje.remote_media.usage` reports for the whole cache.
- An absent, null or empty `domain` counts 0. Mastodon's totals (`Account.where(domain: params[:domain])`) count the
  local accounts, and their follows, statuses, reports and media, for an absent or null one, and nothing for an empty
  one (`domain = ''`). A `domain` is trimmed of JavaScript's white space and normalized as a domain block's (lowercase,
  punycode); Mastodon reads it as sent (`Account.where(domain: params[:domain])`), so a domain written in capitals or in
  Unicode counts no account there.
- `include_subdomains` is read as Rails casts a boolean: empty, `0`, `f`, `F`, `false`, `FALSE`, `off` and `OFF` are
  false; Mastodon takes any value sent as true, `"false"` included. The series counts the domain itself only, as
  Mastodon 4.7.5 does.
- `new_users`, `opened_reports` and `resolved_reports` without both dates answer 422; Mastodon answers 500.
- `start_at` and `end_at` (of measures and of retention) are read as ISO 8601 only, and only when both the date
  written and the UTC instant lie from 1583-01-01 to 9998-12-31; any other value answers 422 `Invalid date
  supplied` to the OAuth admin, as an unreadable date does. The bound keeps every date of the answer in
  four-digit years. Mastodon's measures read any date `DateTime.parse` reads, and Mastodon 4.7.5's retention any
  date `Date.parse` reads, such as `October 1, 2026`, or `2026-10-01T25:00:00Z` read as its date.
- A measure's `start_at` or `end_at` of JavaScript's white space alone (U+FEFF included) is absent, and one of U+0085
  alone is a date that does not parse (422). Mastodon's `String#to_datetime` reads a value blank to Rails (U+0085
  included) as absent and parses any other, so U+FEFF fails there (422). Retention requires both dates as Rails'
  `params.require` does (blank to Rails is missing). Accepted, 2026-11-18.
- The previous window (`previous_total`) can still reach before the Gregorian reform. Kopje counts it in the proleptic
  Gregorian calendar, while Ruby's `Date` is Julian before 1582-10-15, so `previous_total` can differ there: for the
  period 1583-01-01 to 1584-01-01, Kopje's previous window starts on 1581-12-31 and Mastodon 4.7.5's on
  1581-12-21. The axis, `total` and the series are not affected.
- A measure past the bounds of its walk or its request ([docs/visibility.md](visibility.md), the admin measures)
  answers 422 and no count, never an undercount; pending requests and accounts being deleted count toward the walk's.
  So does a stored time that is not the ISO form Kopje writes (an import's). Mastodon sets no bound on the walk. Of
  the range, Mastodon 4.7.5 clamps a `start_at` more than two years before `end_at` to two years before it and
  answers for those two years; Kopje refuses a range past 366 days, so it answers no range the clamp would move.
- `instance_follows` and `instance_followers` date an accepted request by the request; Mastodon by its acceptance.
- Each request reads the Store; Mastodon caches each measure for 5 minutes.

Custom emoji (the `CustomEmoji` entities of a status, its poll and an account, and `GET /api/v1/custom_emojis`):

- A local emoji's category is a name with no featured emoji, so the listing shows `featured: false` beside each
  `category`.
- A remote emoji's `url` is Kopje's cached copy on the instance's own origin (`/media/r/…`) once the cron has fetched
  it, kept per (domain, url), the domain being the account's whose object named it; `static_url` is a still remuxed
  from it, or the cached file itself when it is still or no still fits 256 KiB. Mastodon serves its own copy and a
  static PNG it generates. Only PNG, GIF and WebP below 256 KiB from https URLs are cached; anything else, an emoji not
  fetched yet and one whose fetch failed keep the remote URL, where Mastodon does not save an emoji whose image fails.
  While a domain block with `reject_media` rules the account's stored domain, none is listed, as Mastodon's.
- Only the first 16 entries of a status's, an account's or a moved-to account's snapshot show their cached copy; the
  others keep their remote URLs. Reading more with each row would pass the Store's memory bound for a page.
- An entry's JSON is measured with the URLs it shows, so a snapshot near its byte bound may drop its last entries once
  its emoji are cached.
- Edit history (`StatusEdit`) keeps each version's remote URLs, and lists none under a block with `reject_media`.
- A cached emoji is deleted 90 days after the last snapshot that names it was stored, and once a domain block covers
  its domain or rejects its media, each when the cron's validity walk reaches it (500 slots a round); Mastodon keeps an
  emoji until its domain is purged.

Media (the `MediaAttachment` entity):

- A local upload is an image, or, while the media processor accepts uploads ([media-processor.md](media-processor.md)),
  a video or audio file, which is always re-encoded (Mastodon passes an H.264 and AAC MP4 through): video to an H.264
  and AAC MP4 of at most 1080p at 60 fps, 720p at 30 fps past 120 s and 480p at 30 fps past 300 s, audio to MP3; a
  video past the processing envelope its endpoint publishes at its duration's rendition is encoded at a lower one. The
  file is at most 90 MiB (`video_size_limit` 94,371,840; Mastodon takes 99 MiB) and refused past it with 422 `Validation
  failed: File file size must be less than 90 MB`; video over 600 s, audio over 20 minutes and a file past the
  envelope at every rendition from its duration's down are refused with 422 `Validation failed: File is too long or too
  large to process` (v1 at once, v2 on the GET that finds it failed). v1 waits for the result up to `V1_TIME_MS` from
  the request's arrival (a constant of the release, 8 minutes, [media-processor.md](media-processor.md)) and then
  answers 503 `Media processing took too long. Try a shorter file.`, the upload cancelled unless it finished first or
  the cancellation was not received (the give-up, or S10's reply lost or failed): a completion after the 503 stays
  unattached and the sweep removes it after its grace; Mastodon's v1 waits as long as the processing takes. When the
  slot's request finds the processor inactive (its probe failed after the reservation), a v1 request goes on as an
  image, with the image path's waits: after the 503 it may still deduct three units from the month's Images allowances,
  whether or not the file is an image, and an image completing then is unattached and swept the same way. v2 answers 202
  with the masked entity (`url` and `meta` null), as Mastodon does for a video; when the route's own repeat of its queue
  call (after a reply lost in the RPC) finds the upload already queued, it answers 202 with what the owner's GET shows
  then, and the masked entity when that read fails or takes longer than 30 s (`STORE_CALL_MS`), the owner's next GET
  showing the result; a new POST is a new upload, charged on its own. Both answer 503 `Media processing is busy. Try
  again in a moment.` while two video or audio uploads are already processing, and a failed processing is not tried
  again by the server (Mastodon retries the job). An audio file has no artwork (`preview_url` null) unless it has a
  thumbnail, where Mastodon extracts the cover. While the processor is not accepting uploads, video and audio are
  refused (422 `Validation failed: File content type is invalid`). So are they under a `Content-Type` outside the plain
  form every common client sends (`multipart/form-data`, then `;`-separated `name=token` or `name="quoted"` parameters
  with no backslash, and exactly one `boundary` of RFC 2046's characters): the request is read whole, as an image's,
  with the image path's limits and errors (a file over 16 MB is refused for its size before its type).
- A video or audio upload whose form has several errors may report another of them than Mastodon: a `thumbnail` sent
  before the `file` part is judged once the file is known to be video or audio, before any part after the file is read,
  so a description too long after the file is not the error reported, where Mastodon reports the description first. A
  `thumbnail` file after the file past 16 MB answers 422 `Validation failed: Thumbnail file size must be less than 16
  MB` before the description is judged. A `thumbnail` after the file within its size, a malformed query and the other
  orders answer as for an image. A video or audio upload takes one `thumbnail` part that is sent (a file, or text that
  is not empty): a second answers 422 `Validation failed: Thumbnail was sent more than once`, after the file a file part
  at its head and a text part once its first byte is read, where Rails reads the last. An empty text `thumbnail` is
  absent and is not counted, so the part sent beside it is the thumbnail even when the empty text comes last (a file is
  taken; text answers `Thumbnail content type is invalid`), where Rails reads that last part as none. Before an image
  `file`, the image path's answers hold: the last `thumbnail` counts, and one sent is `Thumbnail must be blank`. Parts
  before the `file` part are read up to 16 MB plus 64 KiB, or 17,956,864 bytes once a `thumbnail` file is among them,
  and past it answer 422 `Validation failed: File file size must be less than 16 MB`.
- A video's or audio file's custom `thumbnail` (on upload and on `PUT`/`PATCH /api/v1/media/:id`, as Mastodon takes it)
  is made by Images as an image upload is: JPEG, PNG, GIF, WebP or AVIF by its signature, served as PNG for a PNG and
  WebP for the rest, its preview at most 640 pixels an edge (Mastodon's is 230,400 pixels), at most 33,177,600 pixels,
  and 16,777,216 bytes accepted (Mastodon refuses that size, its limit being `less_than` 16 MB) with one byte more
  refused. It has no `meta.colors`, as no Kopje media has; Mastodon's web audio player then uses its default colours.
  A text `thumbnail` that is not empty (a data URI, which Mastodon accepts, or anything else) answers 422 `Validation
  failed: Thumbnail content type is invalid`. `PUT /api/v1/media/:id` with a thumbnail counts one attempt toward the 30
  uploads per 30 minutes, as an avatar or header does, where Mastodon throttles `POST` only; a `POST` with one counts
  one, as without. While the upload processes, its owner sees the thumbnail's `preview_url`, `meta.small` and
  `blurhash` (on v2's 202 and the GET's 206), where Mastodon masks only `url`; without a thumbnail the mask is the
  section above's. JSON `null`, or a `thumbnail` key sent without a value in the query or a form body, removes the
  thumbnail, as Mastodon clears it; then `meta.small` and `blurhash` are the upload's own (its still's, or absent and
  null for audio and a video without one), where Mastodon keeps the removed thumbnail's. A v2 audio upload with
  embedded cover art keeps its custom thumbnail once processed, where Mastodon's worker replaces it with the cover. On
  Cloudflare Free and Pro, a `POST` whose body passes the zone's request limit (100 MiB, 104,857,600 bytes) is refused
  by Cloudflare (413, not a Mastodon JSON body) before Kopje reads it, so a file near the 90 MiB limit leaves about
  10 MiB for its thumbnail and the form; a larger thumbnail goes by `PUT`.
- A local video's or audio file's `Document` in its Note writes `duration` to the millisecond (`PT29.964S`), where
  Mastodon writes its stored seconds as ffprobe gives them (to the microsecond); the API's `meta` keeps the stored
  value.
- A local upload's `blurhash` (avatars and headers included; 4 × 4 components, alpha dropped) is computed, as
  Mastodon's BlurhashTranscoder computes one from the `small` style, from Images' raw RGBA output of Kopje's preview (at
  most 640 pixels an edge, where Mastodon's small style is 230,400 pixels), fitted within 100 pixels by area averaging
  where vips resamples, so it may differ from Mastodon's. When that RGBA output fails, is given up before the upload's
  deadline or is not of the preview's size, the upload is kept with `blurhash` null, where Mastodon fails the upload.
  An upload stored by an earlier release keeps null; the media rebuild computes one for each row it makes again, and
  keeps the stored one when the RGBA output fails. A Note's `Document` carries `blurhash` only when the attachment has
  one, where Mastodon writes null.
- A remote attachment's `blurhash` is the value it was sent with when it is base83 with at most 5 by 5 components and
  the length they give, as Mastodon's `supported_blurhash?`; Kopje checks the whole string, where Mastodon's character
  check is line-anchored and keeps a valid first line followed by anything. Mastodon reassigns it, none included, on
  each accepted explicit `Update` (an Update whose version is missing or not newer may refresh only a poll, which
  leaves it as it was); an attachment stored by an earlier release shows null until its next accepted explicit
  `Update`.
- A remote attachment's description is read as Mastodon 4.7 reads it (its `summary`, else its `name`, each a string,
  an array's first element or a language-tagged value, then a language map), except that one Mastodon cannot read (a
  numeric `@value` or language-map value) is none, where Mastodon fails the activity.
- A remote attachment's `url` is Kopje's cached copy of its file on the instance's own origin (`/media/r/…`) once the
  cron has fetched it, and its remote URL until then or when no copy can be made; `preview_url` is the cached copy of
  its icon, else for an image the still of its cached file (the file itself when it is still), else its remote icon,
  else `url` for an image or an unknown file, except for an attachment withheld by a domain block with `reject_media`
  (below). Mastodon shows its own copy and the `small` style it makes from every image, video and gifv; Kopje makes no
  `small` style. Where the operator turns remote stills on, a video or gifv cached after that, with no icon of its own
  (one that is not the file itself), shows a still frame Kopje made from its cached file, at most 640 pixels on its long
  edge, and, when the attachment has no blurhash, the still's; otherwise, and while its still is not made yet or cannot
  be made, it shows `/assets/video-poster.png`, a plain dark image. Mastodon makes a frame from every video and gifv it
  stores. An audio file without an icon shows `null`, as Mastodon's. An icon that is the file itself (its fragment
  aside) counts as none. A video's preview is never the video file, which a client would fetch whole as an image, and in
  a status or its history never `null`, which Mastodon for Android takes as an invalid attachment and drops; edit
  history applies the same to versions recorded before, and the public pages show such a video without a poster.
  `remote_url` and `preview_remote_url` stay the remote URLs, as in Mastodon. An attachment is cached only when it
  arrived within `MEDIA_CACHE_RETENTION_DAYS` (default 14; 0 keeps every one), and its copy is deleted once stored
  longer, as Mastodon's media cache retention deletes its copies. Images (JPEG, PNG, GIF, WebP and AVIF) below 16 MiB,
  at most 16,777,216 pixels, are cached with their metadata stripped, an animated one with a still below 2 MiB; video
  and audio (MP4, M4A, WebM, MP3, FLAC and WAV) below 40 MiB with a declared length are cached as served; icons below 2
  MiB. Ogg, HEIC and HEIF, QuickTime and anything past a cap keep the remote URL (Mastodon takes 16 MB images and 99 MB
  video). The cache's bytes are capped by `REMOTE_MEDIA_CACHE_BYTES` with the other remote media.
- A domain block with `reject_media` caches nothing of the accounts it rules (their profile images and attachments)
  or of the emoji named for its domains. Its rule is the longest matching block, so a nearer block without
  `reject_media` keeps its subdomains cached and shown, also when the parent gains the flag after it; Mastodon's
  `ClearDomainMediaService` deletes the copies of every subdomain once, and the nearest rule decides only the later
  downloads. The copies already cached are deleted when the cron's validity walk reaches them (500 slots a round).
  As Mastodon presents media it never downloaded, each attachment of an account the rule names is `unknown`, with
  `url` and `preview_url` on the instance's `/media_proxy/<id>/original` and `/small`, which answer 404 and fetch
  nothing, and `remote_url` and `preview_remote_url` kept; Mastodon gives every such attachment `unknown` only when it
  was received under the rule. The rule is read live with each answer, so it holds from the block's commit, cached
  copies included, and ends when the flag is turned off or the block deleted, except for answers already cached:
  15 s, served stale 30 s more and up to 86,400 s on an error, for the anonymous API; 300 s for the instance API;
  60 s for the public pages; 180 s for the embed.
- Edit history shows each version's attachments as recorded then, its URLs and `blurhash` included, never a cached copy,
  and withheld as above under a block with `reject_media`; Mastodon shows the current attachment's for every version. A
  version recorded by an earlier release, or converted from an earlier installation, shows `remote_url`,
  `preview_remote_url` and `blurhash` null, except that a withheld converted entry names its stored file as its
  `remote_url` unless that file is on the instance (`snapshotMedia` in `src/domain/statuses.ts`); the current
  attachments of a converted remote status derive their remote URLs.
- A `focus` that is not blank is read as two numbers, each by JavaScript's `parseFloat` and clamped to −1 to 1, one
  missing or unreadable as 0 (`parseFocus` in `src/domain/media-focus.ts`), so a value that is no number (U+FEFF, an
  emoji) is `{x: 0, y: 0}`. Mastodon reads each by Ruby's `to_f`, unclamped, and a missing second as nil
  (`MediaAttachment#focus=`), so its `y` is then `null`. Accepted, 2026-11-18.
- A remote attachment's `focalPoint` that is a string is read as an upload's `focus`; one that is a list that is not
  empty, by its first two entries, a number as given, `null` as 0 and a string by `parseFloat`, a missing second as 0,
  each clamped to −1 to 1 (`focusOf` in `src/federation/remote-status.ts`). A coordinate past the double range (`1e400`,
  a number or a string) is 0, where Mastodon stores `null`, and `parseFloat` stops where Ruby's `to_f` reads on
  (`"0.1_5"` is 0.1, 0.15 on Mastodon). Mastodon casts every entry by Ruby's `to_f`, unclamped, and fails the whole
  activity on one it cannot cast (a boolean, an object or a list, in any position) and on a `focalPoint` that is neither
  blank, a list nor a string in an activity that is not LD-signed (`true`, a number, an object with members). Kopje
  reads no entry past the second, and reads such a `focalPoint` as none, so the post arrives without a focus and an
  `Update` keeps the one shown. An LD-signed activity's `focalPoint`, where its contexts define the term (otherwise
  neither reads it; "Inbound HTTP signatures" below), is read in the shape it was sent, where Mastodon compacts it under
  its `@list` term, which makes a string or a number a list of one (`"0.5,-0.25"` and `0.5` are then
  `{x: 0.5, y: null}`, none on Kopje for `0.5`) and drops a list's nulls (`[null, 0.5]` is then `{x: 0.5, y: null}`).
  Accepted, 2026-11-18.

Filters (a status's `filtered`, Mastodon's `CustomFilter#to_regex` over `Status#searchable_text`):

- Keywords are matched on at most 10,000 UTF-16 code units of each status's searchable text, and the statuses of one
  answer, its quoted statuses included, share 400,000: short texts are matched whole and long ones up to one level, so
  a keyword deep in a long status of a very large answer may be missed where Mastodon matches it. Filter statuses
  always match.
- The level is computed from the length Kopje stores when it writes a status. A status stored before that measure
  (an upgrade, a cutover, an import) or whose text an import holds as another type counts at an upper bound of its
  text (its bytes, markup and entities included, or 10,000), so an answer of such statuses may be cut, and a keyword
  missed, though its text would fit.
- A remote status's lines end at every `<br>` element of its sanitized HTML, whatever its spelling or attributes
  (`<br/>`, `<br class="x">`, `<br lang="en">`), where Mastodon's `PlainTextFormatter` breaks only at `<br>`, `<br />`
  and `</p>` as the raw HTML writes them (any case) and matches a keyword across the others.
- A keyword's `whole_word` sent as an empty string or as JSON null is read as not sent, so a new keyword whole-word and
  an existing one as stored, by `POST /api/v1/filters`, `PUT /api/v1/filters/:id`, `POST /api/v2/filters` and
  `PUT /api/v2/filters/:id` (`keywords_attributes`), `POST /api/v2/filters/:filter_id/keywords` and
  `PUT /api/v2/filters/keywords/:id`. Mastodon casts it to nil, which its `NOT NULL` column refuses, and answers 500
  (`ActiveRecord::NotNullViolation`). Whitespace alone is true in both, as the cast reads it. Accepted, 2026-11-17.

Posting (`POST` and `PUT /api/v1/statuses`):

- A form's empty `media_ids[]=` reads as no media, the same as JSON `[]` (which removes an edit's media); Mastodon
  answers 422 `Media 0 not found or already attached to another post` for the form's.
- Media a scheduled status holds cannot be attached by another post (422, not found); Mastodon attaches it, and the
  scheduled post is then lost when it is published.
- `GET /api/v1/scheduled_statuses` answers within 8 MiB: a page cut there holds fewer scheduled statuses and its
  `Link` continues after the last one shown. A page that leaves out scheduled statuses whose parameters cannot be read
  (below) holds fewer, or none, and its `Link` is that of the scheduled statuses it read, those included: `next` from
  the oldest whenever it read its `limit`, so a walk reaches every other one. A scheduled status shows at most 4 of the
  media it holds (Mastodon holds no more).
- An imported scheduled status whose `scheduled_at` is not a time shows `scheduled_at: null`. One whose parameters
  JSON cannot read (a NUL in them, or bytes stored as a BLOB), which only a restore made before imports refused them
  holds, is left out of the list, not found when shown or updated, deleted as any other, and dropped when due with no
  failure recorded. Mastodon cannot store such rows.
- A post, an edit or a scheduled post whose media are a new set answers Mastodon's `not_ready` for a video or audio
  upload still processing or failed, and refuses a video or audio file beside other media, as Mastodon does. An edit
  that keeps the set its status shows (in any order), and the publication of a scheduled status already held, keep the
  outcome they had before these rules: a status the cutover converted with a video among images is edited and published
  as before, where Mastodon refuses the edit. A redraft of such a status (a new post naming the media its deletion
  detached) is a new set and is refused as Mastodon refuses it; for 24 hours after the deletion (the grace period of
  detached media) the owner can still post the video alone and the images together. An image reservation that never
  completed, and a video or audio upload whose request is still sending it, are not found (Mastodon's processing has no
  such state).
- A `scheduled_at` of white space alone (a space, U+0085, U+FEFF) answers 422 `Record invalid`, an empty one reads
  as absent. Mastodon's `String#to_datetime` (`PostStatusService`) reads a value blank to Rails (a space, U+0085) as
  absent, so the status is posted at once, and refuses U+FEFF. Accepted, 2026-11-18.
- Text length (a blank text's length after its warning becomes the text, in the Store; on an edit after the media ids,
  as Mastodon), the poll, `scheduled_at` and the visibility are checked before the media ids and `allowed_mentions`;
  Mastodon checks the media first.
- A scheduled post whose text is blank and whose content warning is not, and which quotes nothing, is scheduled with the
  warning as its text, no warning and `sensitive` true, as an immediate post is written, and is published so. Mastodon
  keeps the blank text and drops the warning from the stored parameters (`PostStatusService#scheduled_options`), so its
  publication fails without media and posts the blank text without the warning with media.
- `allowed_mentions[]` is compared with the mentions Kopje writes, after unknown addresses are resolved (below):
  accounts not blocked by the author and not suspended. `unexpected_accounts` lists the accounts that fit the 8 MiB
  answer, in mention order. A scheduled post's parameters, the list included, must fit 128 KiB of JSON (`Record
  invalid`); the list is checked when the post is published, and a post it refuses is dropped, as in Mastodon. Numbers
  sent in a JSON list are kept as strings in `params.allowed_mentions` (Mastodon keeps the JSON types).
- A post, a scheduled post or an edit resolves the unknown `@user@host` addresses of its text before it is written
  (`src/domain/mention-addresses.ts`), as `ProcessMentionsService` resolves them, with these differences:
  - At most `MENTION_ADDRESSES_PER_POST` unknown addresses a request are resolved, the first in text order; the
    others stay text. Mastodon has no cap. Accepted, 2026-11-27.
  - Only an address's own account is mentioned: one whose address WebFinger confirms is the address typed. An alias, a
    split-domain account's server host (`user@web.example` for an account whose address is `user@example`) or an old
    domain stays text, though the requests are made; typing the account's address mentions it. Mastodon follows the
    WebFinger subject and mentions that account, and search with `resolve=true` answers it in both. A client that
    lists the searched account in `allowed_mentions` gets the alias as text. Accepted, 2026-11-27.
  - An address on a domain the author blocks is not fetched and takes none of those places; Mastodon fetches it and
    then drops the mention. The text is the same.
  - A scheduled post's addresses are resolved when it is scheduled, and its publication finds the accounts stored then,
    fetching nothing; Mastodon resolves at publication. So publication mentions whatever usable account holds an address
    then (one stored meanwhile included, and not one deleted, suspended or blocked since), and an address no account
    holds then stays text, also one that did not resolve when the post was scheduled (its server down, the account made
    later, a domain blocked then); the remote server sees the requests when the post is scheduled, also for a post
    later deleted; and a post scheduled before this release publishes with the accounts already stored. Accepted,
    2026-11-27.
  - An actor that answers 410 during this resolution leaves its address as text and deletes nothing; Mastodon queues
    the deletion of a stored actor that answers 410. Such an actor stays until its own paths remove it (an inbox
    `Delete`, a refresh, a delivery's 410). Accepted, 2026-11-27.
  - An edit that changes nothing, a post a concurrent request made a key repeat, and a post or an edit then refused may
    have made the requests and store no account (an edit is judged unchanged where it is written). A post refused after
    resolution (unexpected mentions, the direct quote check, a refused schedule) keeps the accounts it stored, as
    Mastodon keeps them.
- An `Idempotency-Key` lasts one hour after the status or scheduled status it made; a scheduled post published within
  that hour keeps it until one hour after its publication. A repeated key answers the scheduled status it made
  (Mastodon answers 404 for an immediate repeat), and a key whose status was deleted posts anew (Mastodon answers 404
  within the hour), as does one whose scheduled status's parameters cannot be read (above), which gives the key up to
  the new post.
- Every local status shows the app it was posted through, as Mastodon does at its default `show_application`; Kopje
  has no such setting. The app is shown within Kopje's presentation bounds (threat-model.md RES-3, the presented
  status), judged on the stored value as decoded: a name past them shows `application: null`, and a website past
  them or not an http(s) URL with a host shows `website: null`. These can hide a value registration accepted (a
  website of 2,000 characters that are not ASCII, say).
- An app website holding any of C0 controls (U+0000–U+001F), the space, DEL (U+007F), C1 controls (U+0080–U+009F), the
  other whitespace JavaScript's `\s` matches (Unicode spaces, line terminators, U+FEFF), and `"` `'` `<` `>` `\` `^`
  `` ` `` `{` `|` `}` is refused at registration (`Website is invalid`) and not shown on a status (`website: null`):
  these are the characters that end or split an HTML attribute or a URL in common parsers. Registration trims
  surrounding whitespace before it validates, so only inner whitespace is refused there. Mastodon's UrlValidator
  (`Addressable::URI.parse`, an http(s) scheme and a host) may accept some of them.
- Kopje removes an app no user has authorized (unused after a day, or one a registration evicts: threat-model.md
  RES-6); Mastodon removes an app only when its owner deletes it. An app a user authorized is never removed, so the
  statuses posted through it keep showing it. A status or scheduled status whose app is gone all the same (one a dump
  or a legacy import names) shows `application: null`, and such a scheduled status is published; Mastodon drops it.
- An edit whose only change is `quote_approval_policy` stores the policy, sends an `Update`, notifies as an edit does
  and sends `status.update`, but records no history entry and leaves `edited_at` as it was: the policy is not part of a
  status's versions, as with `PUT /api/v1/statuses/:id/interaction_policy`. Mastodon counts such a change as an edit
  (`app/services/update_status_service.rb:121`, `:124`, `:174-176` in v4.7.5), so it snapshots a version (`:31`,
  `:170-172`) and sets `edited_at` (`:126`). Accepted, 2026-11-15.

Streaming (`status.update` and `delete`; Mastodon's `FanOutOnWriteService`, `RemoveStatusService` and
`BatchedRemoveStatusService`; VIS-26 in [threat-model.md](threat-model.md)):

- A quote's state change sends `status.update` for the quoting status whatever made it. Kopje verifies a received quote
  after storing the status, so its decision streams the state a Mastodon client got in the status's first event:
  Mastodon decides inline before its own fan-out (`app/lib/activitypub/activity/create.rb:81-93` in v4.7.5) and sends
  no event for it. A rejection of a local account's quote request (`activity/reject.rb:37`, "TODO: broadcast an
  update?") and a revocation's rejection of the other quotes naming the revoked stamp stream too, where Mastodon sends
  nothing; a reset of an accepted quote by an `Update` and the round's decision are two events where Mastodon sends
  one. A repeated `QuoteRequest` of a quote already accepted sends none, where Mastodon broadcasts again
  (`activity/quote_request.rb:41`). Each event reaches only the listeners REST would show the status to (R33).
  Accepted, 2026-11-16.
- A status deletion streams `delete` for at most 40 boosts of that status per listening viewer on `user` and list
  streams (those by the viewer and the accounts it follows; `CAPTURE_LIMITS.boosts`, R32 in
  [visibility.md](visibility.md)). Mastodon v4.7.5 processes eligible reblogs of a deleted status without a cap
  (`app/services/remove_status_service.rb:109-117`, excluding reblogs discarded separately), and for each reblog
  publishes a `delete` event to a home or list stream only when `remove_from_feed` removes it from that feed (which
  returns false when an aggregated reblog is not in the feed; `app/lib/feed_manager.rb:85-95,112-122,585-592`).
  Accepted, 2026-10-16.
- Purging a deleted account sends no streaming `delete` event (R32 in [visibility.md](visibility.md)). Mastodon v4.7.5's
  `DeleteAccountService#purge_statuses!` (`app/services/delete_account_service.rb:165-171`) keeps statuses referenced by
  unresolved reports out of the batch (marking them `deleted_at` instead) and passes the rest to
  `BatchedRemoveStatusService` (`app/services/batched_remove_status_service.rb:35-102`), which removes those statuses
  and their reblogs and, unless `skip_side_effects` is set, publishes `delete` events on home and list streams when
  `remove_from_feed` removes each from that feed, and on public and hashtag streams for public statuses passed to the
  batch from the last two weeks. Accepted, 2026-10-16.

Pinned statuses (`StatusPin`, the actor's `featured` collection):

- Migration `0089_pin_cap` deleted each account's pins past its limit (5 for a local account, 20 for a remote one; a
  converted or restored Store could hold more), keeping the newest in pin order, and sent no `Remove`. A remote server
  that cached a deleted pin of a local account keeps it in that account's featured statuses until it reads the
  `featured` collection again; Mastodon's `FetchFeaturedCollectionService` then removes the pins the collection no
  longer lists, at a time Kopje does not choose. Mastodon itself never holds more than `StatusPinValidator::PIN_LIMIT`
  pins of a local account. Accepted, 2026-11-11.

Removing a favourite or bookmark (`POST /api/v1/statuses/:id/unfavourite` and `/unbookmark`):

- The viewer's favourite or bookmark is removed (a favourite with its `Undo(Like)` and notification) even when they can
  no longer see the status, and the answer is then 404, as for any status hidden from them (VIS-1 in
  `docs/threat-model.md`). Mastodon takes an existing favourite or bookmark without its `show?` check and answers 200
  with the status while it is kept: after its author blocked the viewer, after a private status's follower access was
  lost, and while its author is suspended, being purged or covered by a suspending domain block. Kopje keeps the 404 so
  that a block, a lost follow or a removal shows the viewer nothing they could no longer read. A deleted status answers
  404 in both. Without a favourite or bookmark the answer follows VIS-1: an author who blocks the viewer hides every
  visibility, where Mastodon's `show?` still shows a private, direct or limited status to a mentioned viewer. Accepted,
  2026-10-27.

Inbound HTTP signatures (Mastodon's `SignedRequest`, `app/lib/signed_request.rb`; ID-1 in `docs/threat-model.md`):

- A request whose `Signature-Input` names several signatures is judged by the first of them, of at most three, that
  verifies; Mastodon refuses a request whose `Signature-Input` names more than one signature, before verifying any
  (`signed_request.rb:150-153`). The signature Kopje selects meets Mastodon's required parameters and covered
  components: a `created` parameter, and `@method`, `@target-uri` and, for a POST, `content-digest` among its
  components, each without parameters (`signed_request.rb:182-184`). Accepted, 2026-11-15.
- A `Multikey` an actor lists by reference in `assertionMethod` is not fetched, so a signature by it does not verify;
  Mastodon 4.7 fetches it (`process_account_service.rb:434-444`). No sender in the sources lists one so, and fetching
  it would cost a fetch per key (RES-6). Accepted, 2026-11-15.
- An ML-DSA-44 key is not read, where Mastodon 4.7 stores one for proofs (`multibase.rb:62-66`): Fedify 2.4.5 cannot
  import it. The actor stays usable (ID-1). Accepted, 2026-11-15.
- An Ed25519 key in a legacy `publicKey`, or in a key document of its own its actor lists, verifies an RFC 9421
  signature, where Mastodon reads every legacy key as RSA (`process_account_service.rb:396`, `:414`). Its owner is
  judged by the rule of every key, so no actor gains anything over its own keys. Accepted, 2026-11-15.
- An unreadable key in a document whose context Kopje does not recognize as giving `publicKey` or `assertionMethod`
  their key meaning (a context its instance serves, as Pleroma's `litepub-0.1.jsonld`, or one that redefines either
  term), or spelled otherwise than Mastodon and Fedify write it (either property or its key material under a compact
  or absolute IRI, an entry with its own `@context` or a `@nest`), still makes that actor unusable, where Mastodon
  skips the key (`process_account_service.rb:448-452`) or reads only the plain spelling: recognizing more contexts and
  spellings would mean fetching or expanding them, and no sender in the sources writes an unreadable key under any
  context or such a spelling. Accepted, 2026-11-15.
- A key whose `publicKeyPem` or `publicKeyMultibase` is a one-element array of a string, or a value object holding
  one (`{"@value": …}`), is read, as Fedify 2.4.5 reads it; Mastodon 4.7 takes the member as given
  (`process_account_service.rb:392`, `:425`), so only a string is a key it uses. Accepted, 2026-11-15.
- An entry of `publicKey` or `assertionMethod` that is itself an array is skipped and the actor stays usable, where
  Mastodon 4.7 takes it for a key id and fails to process the document (`json_ld_helper.rb:96` raises on an array).
  Neither reads a key from it. Accepted, 2026-11-15.

Reading inbound activities (Mastodon's `ActivityPub::ProcessActivityService#call`, `process_activity_service.rb:20-38`
and `:66-72`; ID-1, VIS-1 and RES-2 in [threat-model.md](threat-model.md)):

- An activity that carries a Linked Data signature (a `signature` object) is read as received, as every other activity
  is. Mastodon reads it as its compaction under `full_context` (`JsonLdHelper#compact`), unless its JSON-LD limits
  (1,000 values; no `@graph`, `@included` or `@reverse`) or the compaction refuse it, patched toward the body as
  received (`JsonLdHelper#patch_for_forwarding!`): under each key the two share, a one-element array the compaction made
  a single value is an array again, and `as:Public` is the public collection's IRI again. Checked against Mastodon
  4.7.5's own pipeline and readers: what Mastodon 4.6.11 and 4.7.5 LD-sign (Create and Update of a Note and a Question,
  Delete of a Note, Announce and its Undo, `Update(Person)`, Delete of an account, Add and Remove of a featured hashtag,
  Move, QuoteRequest, FeatureRequest, and the Delete of a quote's and of a collection item's stamp) and Fedify 2.4.5's
  Create of a Note and of a Question, `Update(Person)`, Follow, Like, Announce, Undo, Delete, Accept, Block and
  EmojiReact, with and without an FEP-8b32 proof, Kopje reads as Mastodon reads them. Mastodon's reading of each is the
  body as received but for Fedify's `votersCount` and `EmojiReact` without a proof, names Fedify's context defines
  otherwise than `full_context`, which neither reads (below); a Fedify activity with a proof Mastodon reads as received,
  and so does Kopje, which reads an `EmojiReact` as a favourite, as it does unsigned, where Mastodon has no reader for
  one. The fixtures and their capture scripts are in `test/fixtures/ld-signed/` (`test/inbox-signed-forms.test.ts`). The
  activity's `type` and its embedded object's (an `Undo`'s, a `Reject`'s or an `Accept`'s) given as an absolute IRI
  (a compact one such as `as:Follow` is ignored, below) are read as the name the compaction gives them, as Mastodon
  reads them, only in a body of a closed shape whose compaction Kopje can show succeeds: under the ActivityStreams
  context, alone or with security/v1's,
  and without a proof; at most 1,000 values as received, and at most 1,000 once compacted, counting `full_context` for
  its context, its signature once as received, and three for each other value; every `id`, and every value of an
  IRI-typed property but a null or an object, an http(s) IRI as written or over a prefix of the body's context; every
  type such an IRI or a name other than `id` and `type` (which expand to keywords); every value of a language map
  property itself a map of language tags to strings or nulls; and no array directly in another. Every other body's types
  are read as given. Where Mastodon's limits or its JSON-LD processing refuse the body, it reads the body as received
  too (each refusal is captured: too many values as received or once compacted, a `@graph` key, a data-integrity proof
  that keeps something once JSON-LD expands it, an `id` or a type that is null or not a string, a type or an IRI over a
  prefix only `full_context` defines, a proof's member JSON-LD refuses, a language map member that is not a string, an
  object with a null `id` or type in an array given to a language map property, which JSON-LD reads as a node). Where
  Mastodon compacts it all the same (an inline context, an array in an array, a proof, a blank node, a relative or
  non-http(s) IRI (one whose http(s) scheme is upper-case or not followed by `//` included), a number or a boolean where
  an IRI is expected (`cc: true`), a type naming `id` or `type`, a language map given as an array or of another shape, a
  body whose compaction stays within the limit where the count of three per value passes it), such an activity applies
  less than Mastodon's: a retraction so typed is missed (an `Undo` of a block leaves the block). A
  retraction, a `Reject`, `Undo`, `Block` or `Delete` by the name its type is read as, is read as the compaction names
  it in some of these too, each where Mastodon's library compacts it (`test/fixtures/ld-signed/forms.json`) and
  jsonld.js compacts it alike: under an inline context of definitions Mastodon or Fedify write (below), each value of a
  name it types `@id` held to the rule for an IRI-typed property's (one over a prefix only `full_context` defines makes
  Mastodon's library raise; a datatype given as a compact IRI, `xsd:boolean`, it refuses and jsonld.js takes); with an
  array directly in another, which JSON-LD flattens (an `actor` so given is read as its one element, as the compaction
  writes it), but under a name with a `@list` container (a list of lists); with a proof whose keys are plain names,
  which the ActivityStreams and security contexts leave undefined (its nodes held to the rules above, not a
  data-integrity proof's `@graph`); with a number or a boolean where an IRI is expected (`cc: true`), which the
  compaction writes under the property's IRI, but as its `object` or `actor` (an `actor: 5` Mastodon applies for the
  request's signer, and Kopje refuses); with an `id`, or a value where an IRI is expected, that is a blank node, a
  relative reference or an IRI of another scheme (`urn:…`, `HTTPS://…`), which the compaction, having no base, writes as
  given, but one shaped like a keyword (`@foo`, dropped), a blank node with no label or one holding `_:` (labelled
  anew), one over a prefix only `full_context` defines (`as://…`, which raises), and one jsonld.js writes otherwise
  (empty, holding whitespace, or with a `.` or `..` segment before its first `?` or `#`, one either ends too, where a
  query or a fragment is kept as given), or with `//` other than right after a scheme that is no name of `full_context`
  (`//…`, `a//b`, `tag://…`); an activity's or its undone object's `id`
  that is not on its actor's origin is then refused all the same (ID-6), where Mastodon's `Undo` of a block reads
  neither; with a type naming `id` or `type`, which JSON-LD expands to the keyword and the compaction
  writes as that alias again; with a string or an array of strings under a language map property, which JSON-LD reads
  as values of the property (`content` for `contentMap`), or a map whose lower-case tag holds an array of strings, but
  a number or a node there, an array in such an array (which jsonld.js refuses), or an upper-case tag holding one
  (which jsonld.js lower-cases); and with more values than three for each allows, where its compaction stays within
  1,000 as counted by what it writes under each name (a value under a name that means the same on both sides, with no
  container, its own count; any other three), at most the values Mastodon's library and jsonld.js write. Kopje reads a
  name, as a member or as a type, only where the compaction writes it so, as Mastodon's readers read it, whatever the
  body's shape: a member's name where it means in the body's contexts what it means in `full_context`, or
  neither defines it (in a typed node, as the type's own context makes it mean on each side: the data-integrity
  contexts' `DataIntegrityProof`, the Multikey and CID contexts' `Multikey`); a type's where the IRI the body's contexts
  give it is the one `full_context` names so. A name `full_context` defines that the body's contexts leave undefined
  (under the ActivityStreams and security contexts alone: `QuoteRequest`, `Hashtag`, `Emoji`, `PropertyValue`,
  `sensitive`, `quote`, `atomUri`, `conversation`, `votersCount`, `focalPoint`, `blurhash`, an interaction policy,
  `manuallyApprovesFollowers`, `discoverable`, `featured`, …) the compaction writes as a blank node's name
  (`_:QuoteRequest`), and a member's name they define otherwise (a `quote` not typed `@id`, Misskey's `quoteUrl` as
  `as:quoteUrl`, which `full_context` leaves undefined) as its IRI. So neither applies such a `QuoteRequest`, a `Delete`
  naming its status by such an `atomUri`, or an `Add` of such a `Hashtag`, nor reads such a status's sensitivity,
  hashtags, emojis, quote, conversation, poll voters or media focus and blurhash, or such an actor's fields, emojis or
  settings, and a `QuoteRequest` cannot approve a quote neither reads; each is captured beside the same body with the
  name defined, which both apply. Of a name read so, the compaction writes under it only the values its type takes, and
  any other under its IRI, which neither reads: a boolean or a number where the name is typed `@id` (a `quote` given as
  `true` leaves the Note's other quote a legacy one, an `automaticApproval` of `true` states no policy), an object where
  it is typed with a datatype (a poll's `closed` given as an object leaves it open), a language map but a map that holds
  a text (written under `content` for `contentMap`), a list holding any such value, and `expiration` whatever its value
  (written `expires`). An `Accept` of our quote request is matched by its id whatever its type, as in Mastodon. Kopje
  reads less than Mastodon where a name its context defines otherwise is given a value the compaction still writes under
  the name (an object with an `id`, or an IRI where the context types the name `@id` and `full_context` does not), but
  for `sensitive`: where the context defines it otherwise, Kopje reads it as true wherever Mastodon may mark the status
  (an IRI or a value of a datatype, which the compaction writes as an object, a list, written as a `@list` object, an
  array, an empty one too, and a float `0` (`0.0`), each of which Mastodon takes as true; not a lone `false` where it is
  typed `@id`), and it marks the status where Mastodon does not in three cases: where the context types it `@id` and
  gives it an integer `0`, which Kopje's JSON does not tell from a float one; where Mastodon's JSON-LD library refuses
  that definition (a datatype given as a compact IRI over a prefix of the ActivityStreams context, `xsd:boolean`) and
  Mastodon reads as received a value its sensitive column takes as false (`false`, `0`, `"false"`, `"0"`), and where the
  context types it `@id` and gives it two equal values (`[false, false]`), which Mastodon's compaction makes one, so
  that its patch stops and leaves `false`. It reads less too where Mastodon gives up the compaction of a body Kopje
  cannot show it gives up: it reads as received a body Mastodon's JSON-LD limits refuse as received, and one whose
  top-level proof, a `@graph` in the data-integrity contexts, keeps something once expanded, as jsonld.js expands it
  with the preloaded contexts (a proof of a null value, of `@language` alone or beside members that expand to nothing,
  or of an empty `@set` keeps nothing, and Mastodon reads the compaction; jsonld.js leaves an empty node of a `@set` of
  nothing, which Kopje reads as Mastodon's library does, as nothing). It reads as named one whose expansion raises (a
  keyword in a proof given a value of the wrong shape, a datatype given as such a compact IRI), one whose proof holds a
  key that starts with `@` but those a node holds (a keyword of contexts or frames such as `@version`, `@vocab` or
  `@none`, which Mastodon's library drops and jsonld.js keeps, or a string shaped like one), or a key a line of which
  is shaped like one (`"x\n@abc"` defined in the body's context, which Mastodon's library drops, as it tests each line),
  one whose proof Mastodon's
  library keeps where jsonld.js drops it (an empty type list, a `@set` under `@nest`, a language map holding an array in
  an array), one whose proof names a context a body may not, or an inline one the rules refuse (a keyword alias), one
  whose body and proof give more than 32 contexts, types and values under keys whose definition carries a context (each
  node of a language map's array counted), and one with a proof elsewhere than at the top. Otherwise
  the readings differ only for forms none of these writes, and Kopje reads each as written: a status's or a mention's
  `type` given as
  an IRI is read as given, so such a status is refused and such a mention read as absent, where Mastodon reads the type
  the compaction gives it. A one-element array both read as received, and each reader then reads it as it reads the same
  body unsigned, but in a retraction (below): an `actor` given so is refused, where Mastodon applies the activity for
  the request's signer; a text given so is read as empty, where Mastodon
  stores the array's JSON; an `inReplyTo` given so is read as absent, where Mastodon's job raises and stores nothing; an
  `object`, `target` or `instrument` given so is refused, and an `Undo`'s or a `Reject`'s read as absent, where
  Mastodon's job raises too; a single poll option is a poll in both. The patch cannot put back an array the compaction
  shortened (a `null` it left out): an embedded actor's `inbox: [null]` is read, where Mastodon's `[]` drops the update.
  And it stops there, so the members after it in the same object keep the compaction's single values: an `object` given
  as a one-element array after `to: [null]` is refused, where Mastodon applies the activity, but in a retraction. A
  retraction, a `Reject`, `Undo`, `Block` or `Delete` by the name its type is read as, is read in these forms as the
  compaction writes them, where Kopje shows the compaction succeeds (the closed shape above;
  `test/fixtures/ld-signed/retractions.json` holds what Mastodon's own service hands its handler from each), each value
  only where Kopje shows the compaction writes it as given, an http(s) IRI under no namespace of `full_context`'s
  prefixes: its `actor` given as a one-element array of such an IRI or of a node whose `id` is one is read as that
  element, as Mastodon tells a relay by it and applies the activity for its signer; and the member the patch stops at,
  and, in each object the patch stops in, each member after it (its `object`, an embedded activity's `actor` or
  `object`), given as an array under a name typed `@id` with no container whose values, the arrays in it flattened and
  its `null`s dropped, are such IRIs or nodes whose `id`, if they have one, is one, is read as the compaction writes it,
  those values, one as itself (`object: [null, a]` or `[[], a]` as `a`, `to: [null]` as `[]`), and so through the
  objects in it; a `type` given there as an array of one is read as that type, as the compaction writes the name of its
  IRI. Kopje tells where the patch stops only at an array under a name typed `@id` with no container whose values, the
  arrays in it flattened, are `null`s and http(s) IRIs: it stops where they are fewer or more than its elements, as
  JSON-LD's expansion flattens an array in another and drops a `null` (`to: [null]`, `cc: [a, a, null]`,
  `object: [[a], []]`, `to: [[a, b]]`, `to: [[]]`; an array of equal values is not shortened and stops neither), and not
  where they are as many, nor at an array of such IRIs and nodes. A member Kopje's readers read (the `id`, `type`,
  `actor` or `object` of the activity, and so of each node it gives as one of them) that Kopje does not read as Mastodon
  does makes the activity refused, where Kopje, reading it as received, would end what an `Undo` names by its id: after
  the stop, one the compaction writes otherwise than as given (an IRI under such a namespace, which it writes as a
  compact IRI, `as:Public`; one of another scheme, `tag:`; a node so identified); and after any other array, whose stop
  Kopje does not tell (one holding a value the name does not take, `to: [5, a]`, or an IRI of another scheme beside a
  `null`), or in an object holding a key shaped like an array index, whose order JavaScript does not keep, one the
  patch would put back otherwise than the compaction writes it (an array, the public collection). Where Mastodon applies
  such an `Undo` or a `Reject`, Kopje reads less. Any other member there, which no reader reads, is read as
  received. A `Delete` typed by its plain name whose `object` is an array is read as received, and its array refused,
  as Mastodon applies nothing: its inbox reads the `object` of a `Delete` or an `Update` so typed whose actor is present
  before anything else (`inboxes_controller.rb` `unknown_affected_account?`, `value_or_id`), which raises on an array,
  and answers 500 each time it is sent again; one typed as an IRI, which that check passes, and an `Undo` or a `Reject`
  given so are applied by both. Such an `actor` of two values is refused, as Mastodon's job raises; one of a `null`
  beside the signer is read as the signer's, as the patch stops at it; and one of `null` alone, which Mastodon's
  compaction writes as `[]` and so applies for the signer, is refused too (Kopje reads less), as is one of an IRI Kopje
  does not show the compaction writes as given (in a scheme of mixed case, or a namespace's own IRI), which Mastodon
  reads as another actor than the signer. An `Undo` of a `Follow`, a `Block` or a `Like` whose undone activity's
  `object` the patch gives back as an array (given as one, or as an array in another, which the compaction flattens) is
  refused, as Mastodon's handler raises on it (`undo.rb` `target_uri`); where the patch stops at it or before it,
  Mastodon reads the compaction's single value and applies it where it names an account, as Kopje does where it reads
  the stop and that value as given. An `Undo` whose undone activity's type is an array of types is refused too, as
  `undo.rb` takes no array as a type; an empty one both read as none in the compaction. An `Undo` Kopje does apply,
  read so or as received (Mastodon's own fallback included), ends what an unsigned one does.
  Each ends what its signer did or holds, or lifts its own block, so reading it so grants nothing its signer could not
  send directly; every other type keeps the reading as received.
  Compacting would add JSON-LD processing to every signed activity before its HTTP signature is verified, and its
  readers would read a form other than the one the author proof verifies. This is weighed again when a sender is seen
  writing one of these forms, or when the fixtures re-captured at a new reference release no longer read the same.
  Accepted, 2026-11-16.
- An activity that carries a Linked Data signature is read only where nothing Kopje reads from it has another meaning in
  Mastodon's reading, and is otherwise ignored (answered 202): its contexts must give each ActivityStreams term and each
  property Mastodon's `full_context` defines that context's meaning, give no other property one of those meanings or a
  keyword's, and set no keyword (`@base`, `@vocab`, `@language`, …); its context URLs must be ones Kopje preloads and
  that keep those meanings (not `http://schema.org/`, nor `https://w3id.org/identity/v1` after the ActivityStreams
  context); and its properties must be plain names (no `@id`, `@type`, `@value` or nested `@context`, no compact or
  absolute IRI as a key), but in a retraction (below). Mastodon reads such an activity by its JSON-LD meaning, which the
  patch does not undo and which can address it to others than its literal `to`, `cc` and mentions, or give its type or
  object a second value so that Mastodon applies nothing; reading it as written could show it to viewers Mastodon would
  not, or apply what Mastodon would not. In a retraction (above), a node reference given as `{"@id": …}` alone, under a
  name both contexts type `@id` with no container (its `object`, `actor`, `target`, `to`, …), is read as its IRI where
  Kopje shows the compaction succeeds with it so and writes it so (an http(s) IRI under no namespace of a prefix of
  `full_context`), as Mastodon's compaction writes it and its handler reads it. Elsewhere such a retraction is ignored
  and leaves in place the follow, the block or the status Mastodon's ends: the reference beside another key
  (its `type`: a `Delete`'s status stays; an `Undo` of a `Follow`, a `Block` or a `Like` so given ends nothing in
  Mastodon either, as its handler seeks what to end by the undone activity's own `object`, which such a reference
  lacks), under a name not typed `@id` (`content`), of an IRI the compaction writes as a compact IRI (`as:Public`), or
  in a body Kopje does not show Mastodon compacts (the closed shape above, its values counted as received); where
  Mastodon gives the compaction up, it reads such a reference as no IRI and applies nothing either.
  This keeps the meaning of what Kopje reads; it does not make the two readings equal, and the shapes and values above
  still differ. It is ignored too where a node's `type` and `@type` together give two types or more one of which is not
  a string or is shaped like a keyword on any line (`[null, "Tombstone"]`, `["Tombstone", "@foo"]`, `"x\n@abc"`), or a
  type beside `@set`: Mastodon's JSON-LD library sorts such types and raises, or keeps such a node and raises, so that
  its job applies nothing. Kopje ignores as well an array of such values alone (`[null, null]`), or one under `@nest`,
  a language map or a `@value`, and a `@set` with a value, which Mastodon's library refuses, and one in a body past
  Mastodon's JSON-LD limits, each of which Mastodon reads as received, and so reads less there. Accepted, 2026-11-16.
- An LD-signed activity is ignored as well (answered 202) where it holds anything Mastodon (3.5 to 4.7.5) and Fedify
  2.4.5 do not write (Kopje's own LD-signed deletions are Fedify's): a key with a control character or a line break; a
  key that starts with `@` but is no JSON-LD 1.1 keyword; a context URL named twice in one `@context`; an inline
  definition in its `@context` other than one Mastodon (4.4 to 4.7.5: `full_context` and its serializers' contexts;
  3.5.0 to 4.2.29 also the olm extension every actor's context carries) or Fedify 2.4.5 (`@fedify/vocab`) writes for
  that name, compared exactly; a type other than a plain term (ASCII letters, digits, `_` and `-`, not starting with a
  digit or `-`) or an absolute IRI with no space or control character; or a proof other than an object, or an array of
  at most four, of a `@context` that names ActivityStreams and of names given strings (FEP-8b32 as Fedify writes it, one
  proof for each key it signs with). Each form where Ruby's json-ld and jsonld.js part lies outside what those senders
  write, so none is read. Where Mastodon applies something of such an activity, Kopje applies nothing: one typed, or
  with its object typed, as a compact IRI (`as:Like`, `as:Undo`, `as:Block`, `as:Reject`, `as:Follow`, `as:Delete`,
  `as:Accept`, `as:Note`, `as:Mention`), so such a retraction leaves the follow, the block or the status Mastodon's
  ends; one whose context holds a definition another sender writes (Misskey's, whose `featured` is untyped and which
  defines `Key`, `freeText`, `vcard` and its own `_misskey_*` names, so that Misskey's LD-signed relay deliveries are
  ignored; an inline name of the sender's own given a key; a prefix named `https`); a status whose context defines
  `sensitive` otherwise (typed `@id` or as a boolean), which is not stored; one whose data-integrity proof names a
  context without ActivityStreams; and one naming a context URL twice or carrying more than four proofs. Every body
  Mastodon 4.6.11 and 4.7.5 and Fedify 2.4.5 send in the captures passes, and so does each release's actor context from
  3.5.0 to 4.3.23 (`test/fixtures/ld-signed/context-maps.json`). Accepted, 2026-11-17.
- A remote status's `url` is the first `Link` of its `url` whose `mediaType` is `text/html`, else its first value (a
  string, or a Link's `href`; `urlOf` in `src/federation/remote-status.ts`). Mastodon's `url_to_href`
  (`json_ld_helper.rb:46-61`) takes the first value of a list that begins with a string, and otherwise the first Link
  whose `mimeType` (not `mediaType`) is absent or `text/html`, or none, so it may take another Link, or none, where
  Kopje takes the first. A remote account's profile URL follows Mastodon's rule (above). Accepted, 2026-11-18.
- A remote status's `sensitive` is read as Mastodon assigns `@status_parser.sensitive || false` to its boolean column
  (`create.rb:115`, `process_status_update_service.rb:184`; ActiveModel's `Boolean` cast): absent, null, `false`, `0`
  and the strings `"0"`, `"f"`, `"F"`, `"false"`, `"FALSE"`, `"off"` and `"OFF"` leave it unmarked, and any other value
  marks it (`"False"`, `[]`, `[false]`, an object). `""` casts to nil, which the column's `NOT NULL` refuses where
  Mastodon assigns it, and Kopje refuses the same: a `Create` of a status not yet stored, or an `Update` that creates
  one, stores nothing (`Status.create!` raises), and an `Update` with a newer `updated` (Mastodon's explicit update)
  changes nothing of the status (its transaction rolls back). An `Update` that names no newer version (the implicit
  update, which assigns no `sensitive`) still applies what Kopje's implicit update applies, its poll's counts, voters
  and end, its quote, its quote policy and its untrusted counts, and a `Create` of a status already stored, or of a
  vote, assigns none and is applied as without it. Which `Update` is newer differs at one boundary, where Mastodon
  refuses an `Update` with `""` that Kopje applies as implicit (both "Retractions and edits of remote statuses", below).
  In a body read as received, a JSON number with a fraction or an exponent that equals zero (`0.0`, `0e0`) is read as
  not sensitive, where Mastodon's Float marks the status: `JSON.parse` does not tell it from `0` (an LD-signed body
  whose context types `sensitive` `@id` marks any number instead, above). Accepted, 2026-11-17.
- A JSON text from a remote server whose string token, a key or a value, holds an unpaired surrogate escape is refused
  as JSON that does not parse, wherever the token sits, a member a later duplicate key replaces included
  (`jsonTextMalformed` in `src/platform/json-bounds.ts`): an inbound activity (nothing is applied, on spool replay and
  in the cutover rollback's drain too), a fetched document, WebFinger answer or JSON-LD context (a body that is not
  JSON, before its key entries are read), an oEmbed document (the card falls back to the page's OpenGraph) and a page's
  JSON-LD script (skipped, the next one read). Mastodon 4.7.5's parser (json 2.21.2) raises on a high surrogate escape
  no low one follows, so every path refuses that alike; it keeps a lone low surrogate escape (`\udc00`) as invalid
  UTF-8, and what follows depends on the path (`test/fixtures/json-surrogates/` holds the parser's verdicts):
  - An inbox body: Rails reads an ActivityStreams body as request parameters before the action runs, and answers 400 to
    one holding a lone low surrogate in a value and 500 to one holding it only in a key (the next entry), so it applies
    nothing either. Only a lone low surrogate in a member a later duplicate key replaces passes (its parameters and
    `ProcessActivityService`, `process_activity_service.rb:9`, both keep the later value), and Mastodon applies that
    activity where Kopje applies nothing.
  - A fetched document (`body_to_json`, `json_ld_helper.rb:366-374`): Mastodon reads it and fails where it stores the
    value, as PostgreSQL refuses invalid UTF-8 (an actor's name or summary, a key's PEM at
    `process_account_service.rb:265`, a status's content: no account or status is stored); an actor or a status holding
    one only in a member Mastodon does not store is stored, where Kopje refuses the document.
  - A JSON-LD context: Mastodon's JSON-LD library (json-ld 3.3.2) fails on one in a term definition (`context.rb:666`),
    as Kopje does, and reads one outside `@context`, which Kopje refuses.
  - A WebFinger answer (`webfinger.rb:15`): Mastodon resolves an address whose answer holds one in a member it does not
    read (`aliases`), which Kopje does not resolve.
  - An oEmbed document (`fetch_oembed_service.rb:96`): Mastodon makes its card from one holding it in a member it does
    not store, and makes no card from one holding it in a member it stores (the card's save fails in PostgreSQL, which
    `fetch_link_card_service.rb:32` does not rescue); Kopje makes the card from the page's OpenGraph in both.
  - A page's JSON-LD script (`link_details_extractor.rb:108`): Mastodon takes its title from one holding it in a member
    it does not read, and makes no card from one holding it in the headline (`link_details_extractor.rb:164` raises);
    Kopje reads the next script or the page's other data in both.

  Neither fetches a remote NodeInfo document. Accepted, 2026-11-17.

- An inbox body that does not parse as JSON (`JSON.parse` refuses it, or a string token holds an unpaired surrogate) is
  answered 202 once its signature is checked (401 without a valid one), and nothing is applied (`parseActivity`,
  `invalid-json`). Mastodon reads an ActivityStreams body as request parameters before the action runs
  (`config/initializers/mime_types.rb:3` makes `application/activity+json` and `application/ld+json` JSON; actionpack
  8.1.3.1 reads them in `ParamsWrapper#_wrapper_enabled?`, `params_wrapper.rb:294`, then in `verify_authenticity_token`)
  and answers such a body before any signature is checked: 400 (`ActionDispatch::Http::Parameters::ParseError`,
  `parameters.rb:98`, or, for invalid UTF-8 in a value, `ActionController::BadRequest`, `request/utils.rb:41` and
  `request.rb:438`), or 500 when the invalid UTF-8 sits only in a key (the parameter filter raises on it,
  `parameter_filter.rb:140`, from `params_wrapper.rb:302`). A Mastodon sender drops a delivery answered 400 as one
  answered 202 (`json_ld_helper.rb:380-382`, unsalvageable) and retries one answered 500. Accepted, 2026-11-17.
- Bytes that are not UTF-8 in a JSON text from a remote server (a surrogate's bytes, an overlong form, a lone
  continuation byte, a truncated sequence) make an inbound activity and a JSON-LD context JSON that does not parse,
  decoded strictly (on spool replay and in the cutover rollback's drain too; the signature is verified over the bytes as
  received), where Mastodon refuses them; elsewhere Kopje decodes as Mastodon reads them or as before:
  - An inbox body: Mastodon answers 400 to one holding them in a value and 500 to one holding them only in a key, as
    for a lone low surrogate escape (the previous entry); Kopje answers 202 and applies nothing. One whose invalid
    bytes sit only in a member a later duplicate key replaces passes Mastodon's parsing (an unsigned one reaches its
    401, as the control does; whether it applies a signed one is not verified), where Kopje refuses it.
  - A JSON-LD context: Mastodon's loader refuses one served without a charset wherever they sit (`truncated_body`,
    `request.rb:270-291`, keeps such a body binary, and MultiJson's `json_gem` adapter, `json_gem.rb:42-45`, refuses
    binary input that is not UTF-8) and one served as UTF-8 holding them in a term definition (json-ld 3.3.2,
    `context.rb:666`), but reads one served as UTF-8 holding them outside `@context`, which Kopje refuses.
  - A fetched document or WebFinger answer: Kopje reads each such sequence as U+FFFD. Mastodon keeps the bytes
    (`body_to_json` and `webfinger.rb:15` parse them as they are), so it stores an actor or a status holding them only
    in a member it does not store and nothing where PostgreSQL would store them (a name, a summary, a status's content),
    which Kopje stores with U+FFFD, and both resolve an address whose answer holds them in `aliases`.
  - An oEmbed document: Kopje refuses it (the card falls back to the page's OpenGraph), where Mastodon reads it
    (`fetch_oembed_service.rb:96`) and makes its card unless a member it stores holds them.
  - A page's JSON-LD script: both read each such sequence as U+FFFD, one for each maximal sequence (WHATWG decoding:
    Mastodon's HTML5 parser, `link_details_extractor.rb:300`; Kopje's HTML rewriter).

  Accepted, 2026-11-17.

Delivery recipients (a local account's followers and poll voters, and the audience a staged `Update` or `Remove`
reaches; Mastodon's `Account.inboxes`, `app/models/account.rb:490-493`; NET-2 and RES-2 in `docs/threat-model.md`):

- A follower or voter is reached at its shared inbox, else its personal inbox, only when that one value is text of 1
  to 4,096 UTF-8 bytes without NUL (`reachInboxSql` in `src/domain/audience.ts`, the rule a block's collection
  `Remove`s stage followers by); a shared inbox outside it is not replaced by the personal inbox. Kopje stores an
  inbox of at most 2,048 bytes from an actor document, so only an import or a restored dump holds one outside the
  rule, and such a follower or voter gets no new activity Kopje sends to followers or voters at once
  (`recipientsFor`), in a staged retraction, through a collection's reach or through a moderation reach (below); an
  addressed account still reads the inbox whole. A retraction staged in steps (a local status's `Delete`, a job's
  `Undo` of a boost, a forward) reads followers and voters by the same rule, so its targets are the ones the same
  retraction read at once would have; an inbox that received what it withdraws is still reached through its receipt.
  Mastodon delivers to `preferred_inbox_url` whatever its length (PostgreSQL holds no NUL). Delivery targets recorded
  and a retraction's targets staged before the upgrade keep their inboxes; a moderation job's staged rows do not
  (below). Accepted, 2026-11-17.
- A local account's suspension and unsuspension `Update` (Mastodon's `AccountReachFinder`,
  `app/lib/account_reach_finder.rb`: its followers, reporters and recently mentioned, followed and requested accounts)
  reads each account's inbox by the same rule as its audience is staged, and the job's staged rows by it too, so rows an
  import or an earlier release staged outside it are dropped unsent. An account whose inbox is outside the rule, which
  only an import or a restored dump holds, is sent neither that `Update` nor a block's collection `Remove`, where
  Mastodon's reach finder and `Account.inboxes` take its inbox whatever its length. Such an inbox takes no place in a
  capped source (the recently mentioned, followed and requested accounts, 2,000 inboxes each): the next account's inbox
  is reached instead, so the source still reaches as many inboxes as Mastodon's, which refuses none. Accepted,
  2026-11-17.

Outbound HTTP signatures (Mastodon's `Request#perform`, `app/lib/request.rb`; NET-1 in `docs/threat-model.md`):

- A signed fetch answered 400 or 401 is sent once more with an RFC 9421 signature hop by hop: the redirect hop so
  answered is sent again, and the next hop starts with draft-cavage. Mastodon 4.7 sends the whole request with
  draft-cavage, its client following redirects, and on a final 400 or 401 sends it again from the first URL with
  RFC 9421 (`request.rb:132-146`, `:189`, `:207`). So a redirect chain whose two hops both need RFC 9421 takes four
  requests where Mastodon takes three. Kopje follows redirects in its own loader, which checks each hop (origin, host,
  domain policy, fetch budget) before requesting it; retrying the hop that answered keeps every request one that loop
  has checked. Deliveries follow no redirect, so they retry as Mastodon does. Accepted, 2026-11-15.

Unavailable delivery hosts (Mastodon's `DeliveryFailureTracker` and `UnavailableDomain`; RES-5 in
`docs/threat-model.md`):

- A host is marked unavailable on the 7th distinct UTC day its deliveries failed since its last success, as Mastodon's
  tracker marks it, but only a failure the host caused counts: an answer that the name has no IP address (an empty
  answer or one of non-IP rows, `ENOTFOUND`, `ENODATA`) or only non-public ones, a POST's answer neither 2xx nor
  permanent, a fetch's network error, or a timeout that ran the POST's whole time. Mastodon counts every failure of
  its job, its own resolver's (`Resolv` reads NXDOMAIN, SERVFAIL and a timeout alike as no address) and signer's
  included; Kopje counts no other lookup failure, no signing-key or signature failure, no timeout the lease's deadline
  cut and no exhausted budget. A permanent answer (4xx but 401, 408 and 429, and 501) neither counts nor clears, as in
  Mastodon. A host is the inbox's host in lowercase punycode without its trailing dots.
- A delivery that succeeds, an activity the Store receives from an actor whose stored inbox is on the host, and the
  operator's restart clear it, an operator's stop included. Mastodon 4.7.5 resets the host of the verified signer's
  inbox for every POST to its inbox, an activity it then ignores included (`inboxes_controller.rb:77`,
  `delivery_failure_tracker.rb:21-24` and `:48`, destroying the domain's `UnavailableDomain`), and stores an actor's
  inbox on any host (`process_account_service.rb:235-245`). Kopje keeps both, so in either an actor whose document
  names an inbox on a host it does not control clears that host, a stop included, with any activity it sends; the
  host is then tried again (RES-5's accepted gap). Accepted, 2026-11-17.
- While a host is unavailable, its deliveries but `Follow`s (Mastodon's `bypass_availability`) are written and kept
  given up `host unavailable`, where Mastodon skips the work and writes nothing: a new target is written given up and
  not counted toward the backlog, a due row is given up at its claim, a failed attempt is given up instead of retried
  (its shared-inbox fallback not tried), and the host's queued and pending rows are given up 100 a step, each delivery
  round. The operator may retry them (`kopje-admin deliveries retry`), and they are sent once the host is available.
  A lease taken before the mark is sent once, as Mastodon's started job, and its failure given up. The drain covers
  the lanes Kopje writes (an https origin of at most 268 bytes); a row on another lane is given up when its claim
  comes.
- A failing host that is not unavailable is forgotten 30 days after its last counted day. At most 10,000 hosts are
  kept: past it a new host's failures are not counted, and a stop of a new host takes the place of the available host
  of the oldest counted day, or is refused when every kept host is unavailable. Mastodon keeps any number.
- The operator lists, stops and restarts hosts with `kopje-admin hosts` (`/admin/hosts`), as Mastodon's admin "stop
  delivery" and "restart delivery" of an instance. Kopje has no bulk import, so Mastodon's skip of unavailable domains
  when an import resolves accounts has no counterpart.

Retractions and edits of remote statuses (Mastodon's `ActivityPub::Activity::Delete`, `Create`, `Update` and `Undo`;
ID-7 in `docs/threat-model.md`):

- A retraction lasts 30 days, so a `Create` replayed after that is accepted again. Mastodon's `Tombstone` has no expiry
  (`delete.rb`, `create.rb`, `update.rb`) and is cleared when the account's key changes (`process_account_service.rb`).
  Permanent tombstones, the wildcard ones included, would grow without bound.
- A `Delete` of an object Kopje does not hold is recorded for its sender only. In Mastodon, which checks only that the
  object's host is the sender's (`delete.rb`), another actor's `Delete` leaves a `Tombstone` that also blocks the
  author's later `Create`.
- An `Update` replaces the content only when its `updated` is newer than the stored version (the last accepted
  `updated`, else `edited_at`, else `published`); one whose version is equal, or missing for a status never edited,
  still refreshes the poll and the quote policy, records a changed stamp of the same quote, and verifies the same quote
  again, as Mastodon's `handle_implicit_update!` does; one missing for an edited status changes nothing, as in
  Mastodon (`process_status_update_service.rb:32-34`). Mastodon takes any `Update` naming an `updated` as an explicit
  edit of a status it holds without `edited_at` (`:30`; a `Create` stores none when `updated` is missing or equals
  `published`, `create.rb:112`), where Kopje takes one equal to the stored version (that `published`) as the implicit
  update and changes nothing for an earlier one. So such an equal `Update` with `sensitive: ""` refreshes the poll, the
  quote, the quote policy and the untrusted counts here, where Mastodon's `NOT NULL` refuses the whole `Update`; with
  any other `sensitive` Mastodon applies its content, which Kopje leaves. Mastodon moves `edited_at` only on a
  significant edit (`process_status_update_service.rb`), so after a newer metadata-only `Update` it applies an older
  content `Update`: an author editing A, then B, then A again, whose final A arrives before B, ends at B there.
  Mastodon's behaviour is an ordering bug. A tag-only `Update` is such a metadata-only one: it replaces the post's
  collection tags and moves the stored version, so a replayed `Update` of that version naming other collections, or
  an older one arriving after it, changes no tag, where Mastodon, whose `edited_at` the tag-only `Update` did not move,
  replaces them again.
- A remote status's `favourites_count` and `reblogs_count` are, as in Mastodon, the untrusted counts its server gives
  as `likes.totalItems` and `shares.totalItems`, read as Mastodon stores them (an object's `totalItems`, cast and
  clamped to 0 to 100,000,000, on a `Create` and on every `Update`, a refetch and a poll's refresh included; `""`
  clears one, and a missing or null one keeps it), and moved with each favourite and boost Kopje stores of the status
  (`status.rb:324-341`); without one, the favourites and boosts Kopje stores of it. Kopje moves an untrusted count by
  how far the status's own count moves when it is counted again, where Mastodon adds or takes one for each favourite
  or boost; the two differ only where the own count was stale, which Kopje corrects at that count. An own count an
  import stored as text moves it by nothing. A status stored before migration `0114_untrusted_counts`, or carried over
  by the cutover, has none until its server's next `Update` of it or a refetch. A `totalItems` written as a JSON
  integer too large for a double (past about 1.8e308) is read as no count, clearing a stored one, where Mastodon reads
  the exact integer and clamps it to 100,000,000, or 0 when negative: `JSON.parse` gives an infinity, which Kopje reads
  as it reads a number with an exponent past that range (`1e400`), no count in both. Accepted, 2026-11-17.
- The answer to `POST /api/v1/statuses/:id/unfavourite` and `/unreblog` of a remote status with an untrusted count
  shows its `favourites_count` and `reblogs_count` after the change, as a read afterwards does. Mastodon's answer shows
  the untrusted count before it: its serializer prefers that count over the one the controller hands it
  (`status_serializer.rb:95-101`), and the count moves only in the later `UnfavouriteWorker` or `RemovalWorker`.
  Accepted, 2026-11-18.
- A status Kopje fetches again that it stores (search, `/authorize_interaction`, a pin sync, a replies walk, its root
  included) is applied as its author's `Update`, as `FetchRemoteStatusService` turns a stored status's `Create` into an
  `Update` (`fetch_remote_status_service.rb:48`). A pin sync fetches every status its account lists on its origin and
  applies only the account's own, as Mastodon's `expected_actor_uri`. A status fetched because it was not stored (a
  boost's original, a quoted status, an `Add`, a quote request's instrument) that a delivery stored before the fetch
  completed keeps the stored version; Mastodon applies the fetched one.
- A public or unlisted status stored under the URI a pin sync or a replies walk (not its root, whose body Mastodon hands
  to `FetchReplyWorker`) fetches is removed when that URI answers 404 without a redirect, as Mastodon's `fetch_status`
  (`fetch_remote_status_service.rb:86-98`); no retraction is recorded, as Mastodon keeps no tombstone, so a later
  `Create` of it is stored again. A 410, a redirected 404 and a private status's 404 remove nothing; search removes
  nothing (`resolve_url_service.rb:38-61`). Kopje's removal runs in its job's batches after the status is hidden, where
  Mastodon's `RemoveStatusService` deletes the row at once: an `Update` that arrives in between applies to the hidden
  row and goes with it, where Mastodon's would create the status again if it is recent.
- An `Update` whose `updated` is more than five minutes ahead of the clock is ignored (`src/domain/remote-statuses.ts`);
  Mastodon has no such check. The edit is lost until another delivery or a later edit: the sender does not send it
  again when the receiver's clock catches up.
- Kopje reads `atomUri` only as an http(s) URI. An OStatus-era `tag:` identity, which Mastodon gave statuses before
  ActivityPub (`OStatus::TagManager`, `app/lib/ostatus/tag_manager.rb:22`) and which a cutover may keep as a stored
  status's uri, is ignored, so an activity naming such a status only by it matches nothing; no Mastodon writes a new
  one. A quote naming a status Kopje knows only under a differing `atomUri` is not linked to it: the quote is linked by
  the URI it names (VIS-28), as Mastodon names any quoted status by its URI.
- An `Undo` (Mastodon's `ActivityPub::Activity::Undo`) differs from Mastodon's where it ends what the sender holds: one
  given without a type that names a favourite's tracked `Like` by its id ends it, as a typed one does, where Mastodon's
  reference (`handle_reference`) seeks no favourite (`try_undo_like`), so the unfavourites and unreactions Akkoma sends
  so end nothing there; a typed `Undo` of a `Like` under an id the favourite does not track keeps it while another
  tracked id is outstanding (each reaction is counted), where Mastodon ends the sender's favourite of the status
  whatever the id; and a typed `Undo` of a `Like` naming a remote status ends the sender's favourite of it that the
  cutover carried over, where Mastodon seeks only a local account's status, as it is the sender's own favourite and the
  sender asked to end it. Kopje also requires what Mastodon's typed `Undo` does not read: the undone activity's id, as
  a string on the sender's origin (each sender checked, Mastodon, Misskey, GoToSocial and Akkoma, embeds one), and,
  where it names an actor, the sender. A reference given as a string is read as one whatever it holds, where Mastodon
  reads its type with Ruby's `String#[]`, so that one whose IRI contains `type` ends nothing there. Accepted,
  2026-11-18.
- An `Undo` of an `Accept` turns a local account's follow back into a request also when the account follows as many
  accounts as its follow limit allows. Mastodon's `revoke_request!` creates the request before it destroys the follow
  (`follow.rb`), so there its follow limit (`FollowLimitValidator`, which `FollowRequest` applies on create) refuses the
  request, the `Undo` fails, and the follow stays accepted; Kopje changes the existing follow, to which no limit
  applies. Accepted, 2026-11-18.

Quote approvals (a local account's quote of a remote status; Mastodon's `ActivityPub::Activity::Accept`; VIS-28 in
`docs/threat-model.md`):

- A Mastodon author may revoke a local account's quote while it is still pending there, which sends the stamp's
  `Delete` (`revoke_quote_service.rb:42` in v4.7.5), and their server then accepts the quote's first `QuoteRequest`
  under that same stamp (`quote_request.rb:31-32` accepts a quote in any state). When the `Delete` reaches Kopje first,
  Kopje records the stamp as retracted and refuses an `Accept` naming it while the retraction lasts (30 days, ID-7), so
  it keeps the quote pending while the quoted server holds it accepted and serves its stamp; a Mastodon quoter applies
  that `Accept` (`accept.rb:49` checks no retraction). No quote held the stamp, so nothing records it as revoked for
  good: an `Accept` that arrives after the retraction expires applies, as in Mastodon. The refusal keeps a forged or
  replayed `Accept` naming a retracted stamp from taking effect while the retraction lasts. Accepted, 2026-11-11.

Quote verification (a received quote and its stamp; Mastodon's `ActivityPub::VerifyQuoteService` and
`ProcessStatusUpdateService`; VIS-28 in [threat-model.md](threat-model.md)):

- Kopje verifies a quote in job rounds after the status or its `Update` is stored, not inline, so the notifications of
  a verification Mastodon would broadcast (a same-version `Update`'s, a retried one's) come at the round's decision,
  within minutes of the activity. Accepted, 2026-11-16.
- An `Update` naming the same stamp does not verify a rejected or revoked quote again; Mastodon fetches the stamp, which
  a Mastodon server answers 404 once it has rejected or revoked the quote (`quote_authorizations_controller.rb:23-28`),
  and a revoked stamp never accepts a quote in Kopje (VIS-28). Accepted, 2026-11-16.
- An accepted quote whose stamp, fetched again, no longer names it is revoked; Mastodon keeps it accepted
  (`verify_quote_service.rb:23-24`, `:32`). A stamp that no longer proves the approval does not keep it. Accepted,
  2026-11-16.
- A rejected or revoked quote that an `Update` gives another stamp is pending until its round decides; Mastodon keeps
  it rejected or revoked meanwhile, and broadcasts only if the stamp accepts it, where Kopje's round also notifies when
  it rejects the quote again. Accepted, 2026-11-16.
- An accepted self-quote (the quoting status's author is the quoted one) keeps its state whatever stamp an `Update`
  names, and Kopje never fetches its stamp. Mastodon 4.7.5 fetches it (`fast_track_approval!` answers false after
  accepting, `verify_quote_service.rb:40-51`), revokes the quote when the stamp answers 404, and resets it when a
  verified stamp changes. A self-quote needs no approval (FEP-044f, and Mastodon's own comment at `:43`). Accepted,
  2026-11-16.
- A status that arrives again (an `Update`, a boost, a delivered `Create`) while its quote's verification is in flight,
  or waits to retry after a failure that may pass, is answered by that verification, not by a fetch of its own, and
  the wait runs out as it was; Mastodon verifies the quote at each `Update` (`process_status_update_service.rb:60`,
  `:348`) and has no deferred work to interrupt. Kopje's notification of that verification's move follows the first of
  those `Update`s (or the first after a failure that may pass), as Mastodon's first verification is the one that
  moves the state. When the stamp's answer changes between them, Mastodon notifies once more or once less: a stamp gone
  after a same-version `Update` and before a significant newer one is notified once by Mastodon (the edit) and twice
  by Kopje (the edit and the decision); gone after a significant newer `Update` and before a same-version one, twice by
  Mastodon and once by Kopje (the edit). Accepted, 2026-11-16.
- When a remote post that quotes a local post with an approval is edited to quote another post, Kopje retires the
  approval (it never verifies again) but sends no `Delete` of it, where Mastodon 4.7.5 sends one to the servers both
  posts reach (`RevokeQuoteService`, run by `ProcessStatusUpdateService#update_quote!`,
  `process_status_update_service.rb:362`). Neither Mastodon nor Kopje edits a quote's target, and servers that receive
  the edit drop the old quote themselves. When software that sends such an edit appears, Kopje sends the `Delete` as
  Mastodon does. Accepted, 2026-11-16.

Forwarded deletes (a remote author's `Delete` of a status that local accounts boosted or quoted; Mastodon's
`ActivityPub::Forwarder`, `app/lib/activitypub/forwarder.rb`, run by `Activity::Delete#delete_status`):

- Kopje forwards only once the author's own proof verifies, an RsaSignature2017 Linked Data Signature or an FEP-8b32
  proof; Mastodon's `forwardable?` checks only that a `signature` is present, so it forwards an unverified LD signature
  and never an FEP-8b32 proof alone.
- The body goes as received, serialized once in the Store (`JSON.stringify`), byte for byte to every inbox; Mastodon
  sends its processed document (`Oj.dump(@json)`, compacted JSON-LD after `patch_for_forwarding!`), without the
  `signature` unless it is safe to forward.
- Each local booster or quoter forwards it to its own reach, signed with its own key: its followers' inboxes (shared,
  else personal) and the inboxes that received its boost or quoting status, or may still (receipts, earlier rows in any
  state). Mastodon signs once, for everyone, with the replied-to local account's key when there is one, else the first
  sharer's (reboosters before quoters), sends to the followers of every local booster and quoter and of the replied-to
  account, less the author's own inbox, and reads no receipts; both leave out the inboxes of a host marked unavailable
  (Kopje writes their rows given up, "Unavailable delivery hosts"). So a server may get one POST per local booster or
  quoter, and the deleting author's server may get it back.
- A quote in any state forwards, as in Mastodon (`forwarder.rb:30-32` reads every quote), but a direct or limited
  quoting status forwards only to the inboxes it was delivered to (its receipts), never its author's followers, who
  may not see it, nor an inbox whose delivery of it is still in flight or never succeeded; Mastodon sends a direct
  quote's forward to its quoter's followers.
- A quoting status whose removal has begun (withdrawn) forwards nothing, a reported or preserved one included, which
  Mastodon keeps discarded with its quote and forwards through (`remove_status_service.rb:53`, `:162-164`).
- At most 16 owners forward (the boosters first by account id, then the owners of the quotes read by account id),
  through at most 64 quoting statuses across all owners (the first by status id, one owner may hold them all; a policy
  cap, logged when passed), and nothing is forwarded for a body over 65,536 bytes as serialized or holding a number
  JSON cannot carry; Mastodon has no such caps.
- A boost forwards only when it is kept and neither direct nor limited (a converted direct boost is one Kopje kept from
  legacy data; Mastodon's kept scope counts it, and sends to the booster's followers): neither a reply to a local
  account nor an `Update` is forwarded, nor are a quoting status's poll voters reached.
- A status's `Delete` another server relays (its HTTP signer is not its actor) is applied, and forwarded, as the
  author's own only when it carries the author's proof, verified (an RsaSignature2017 signature or an FEP-8b32 proof),
  and only to a public or unlisted original Kopje holds as that author's, on the author's origin (ID-1). Mastodon
  verifies a relayed `Delete`'s RsaSignature2017 signature by its author (4.5's `process_collection_service.rb`
  `verify_account!`, 4.7's `process_activity_service.rb` `actor_from_verified_ld_signature`; a past `expires` does not
  verify) and applies it as the author's own (`activity/delete.rb` `delete_status`) to a status of any
  visibility or a boost, and a relayed `Delete` of the author's account as the account's deletion (`delete_person`);
  it forwards one only for a distributable (public or unlisted) status (`forwarder.rb` `forwardable?`). Its inbox
  answers 202 before processing, and drops a relay whose signature does not verify; Kopje answers such a relay 202
  too, applying nothing. Kopje changes no status for a relay without a proof, nor for a private, direct or limited
  status or a boost. Mastodon also applies, as its author's, a relayed `Delete` of an actor and a relay of another type
  whose signature verifies (a reply to one of its accounts forwarded as `Create`, `create.rb` `forward_for_reply`; an
  edit forwarded as `Update`, `process_status_update_service.rb` `forward_activity!`); Kopje applies none of them: once
  the relaying server owns its HTTP signature's key, such a relay is answered 202 and dropped, logged, and a signer
  that does not own its key is answered 401.
- An author's proof on a `Delete`, relayed or the author's own, is considered only on a body in one of the sender
  profiles (`PROFILES` in `src/federation/author-proof.ts`; ID-1 in [threat-model.md](threat-model.md) defines them):
  Mastodon's status `Delete` (`DeleteSerializer`, `DeleteNoteSerializer` from 4.6) and stamp `Delete`
  (`DeleteQuoteAuthorizationSerializer`, as 4.5.10 to 4.7 write it), each with the `@context` Mastodon writes and the
  keys its serializer and `LinkedDataSignature#sign!` write (`expires` from 4.7.0, judged at the time the request
  reached the inbox); Kopje's own; Mastodon's and Kopje's status and stamp `Delete` as a Mastodon 4.4 to 4.7 forwards it
  (a stamp's by `Activity::Delete#revoke_quote`, through the local sharers of the quoting status, with no `forwardable?`
  check; a Mastodon before 4.5.10 drops Mastodon's stamp signature, its `full_context` lacking the stamp's terms),
  compacted under its `full_context` (`app/helpers/context_helper.rb`); and a `Delete` Fedify 2.4.5 signs with an
  FEP-8b32 proof (`eddsa-jcs-2022`, without `expires`). Mastodon verifies a signature whatever the body's context and
  keys, refusing only JSON-LD features it does not support (`json_ld_helper.rb` `unsupported_jsonld_features?`). So a
  relayed `Delete` from Misskey, or forwarded by a Mastodon whose `full_context` holds a named context, term or
  definition outside 4.4 to 4.7, is dropped with 202, as Mastodon drops one whose signature does not verify, and an
  author's own `Delete` in such a form applies but is not forwarded. Adding a profile is a change of its own.
  Accepted, 2026-11-13. Mastodon 4.7 also verifies an `mldsa44-jcs-2024` proof and a proof with `expires`, judged at
  receipt (`object_integrity_proof.rb:7`, `:19`). Kopje answers either as a proof that does not verify: no sender of a
  profile writes them, its verifier (Fedify 2.4.5) does not include the ML-DSA-44 suite although the runtime could
  verify it, and it judges `expires` at its own clock. Accepted, 2026-11-15.
- The local boosts still get their `Undo(Announce)`, after the forwarded `Delete` in each lane; Mastodon's
  `RemoveStatusService` sends none for them.

Relayed activities (an activity whose HTTP signer is not its actor; ID-1 in [threat-model.md](threat-model.md)):

- Of the activities another server relays, Kopje applies only a status's or a stamp's `Delete` that carries its author's
  proof (Forwarded deletes, above), and a stamp's `Delete` without one only as a reason to verify the quote naming it
  again, which Mastodon drops; any other changes nothing, answered 202 and dropped once the relaying server owns its
  key, and 401 when it does not. Mastodon applies a relayed activity of any type whose RsaSignature2017 signature by its
  actor verifies (`ActivityPub::ProcessActivityService`; before 4.7, `ProcessCollectionService#verify_account!`), and
  from 4.7.0 one whose FEP-8b32 proof by its actor verifies (`process_activity_service.rb:42-75`). An inbound activity
  acts only for its signer, and Kopje weighs an author's proof only on a body it has a profile for
  (`src/federation/author-proof.ts`). Accepted, 2026-11-15.

Deletes of local statuses (`DELETE /api/v1/statuses/:id`; Mastodon's `RemoveStatusService` and
`ActivityPub::DeleteSerializer`; VIS-3 in `docs/threat-model.md`):

- The `Delete` of a public or unlisted status is LD-signed (RsaSignature2017) by its author and addressed to Public
  alone, as Mastodon signs it (`always_sign`, `Status#sign?`) and addresses it; its context defines `atomUri`, so a
  Mastodon booster or quoter keeps the signature when it forwards it (`safe_for_forwarding?`). This matches Mastodon.
- The `Delete` of a private, direct or limited status is unsigned, as in Mastodon, but addressed as the status was:
  a private one `to` its author's followers with its named mentions in `cc`, a direct or limited one `to` its named
  mentions with no `cc`; Mastodon's `DeleteSerializer` addresses every `Delete` to Public. A receiver applies either by
  its object. Accepted, 2026-11-13.
- When the author's key cannot sign the `Delete` (no key, it does not unwrap, or signing fails), the DELETE answers
  503 and nothing changes: the status stays, so a later DELETE can send a proven `Delete`. Mastodon removes the status
  in the request and signs in its job, which raises and is retried. Accepted, 2026-11-13.
- An imported public or unlisted status whose uri or author's actor id can never be signed (not an http or https URL
  in the spelling URL serializing gives it, with no fragment, nor an absolute IRI to jsonld) is deleted with its
  `Delete` unsigned and addressed as the status was, and the reason is logged (`kopje.delivery.delete_unsigned`);
  Mastodon's ids are always its own URLs. Accepted, 2026-11-13.
- The `Undo(Announce)` of a public or unlisted boost is unsigned; Mastodon signs it through the same path. No receiver
  forwards an `Undo`. Accepted, 2026-11-13.
- The signed body goes unchanged to every target, a silent recipient's own copy included, and an inbox that is a
  target of the neutral copy and of one or more personal copies gets the same bytes once for each; Mastodon delivers
  one copy per inbox. Each is applied once. Accepted, 2026-11-13.

Outboxes (`/ap/users/:username/outbox` and the instance actor's `/actor/outbox`; Mastodon's
`ActivityPub::OutboxesController`, which serves the instance actor's for `Account.representative`, empty):

- Pages are linked by `cursor`, the first as `?cursor=first`; Mastodon's by `page=true` with `max_id` or `min_id`. The
  collection has no `last` and a page no `prev`.
- A page that lists nothing has no `orderedItems`; Mastodon's has `[]`.
- A request whose `Accept` prefers HTML or names no JSON type answers 406; Mastodon serves the collection whatever the
  `Accept`.
- No `Cache-Control` is sent; Mastodon lets the collection be cached for three minutes and a page for one.

Follow requests from an account that blocks the local one (`/api/v1/follow_requests`; the request an inbound `Block`
keeps, or a `Follow` that arrives after its sender's `Block`):

- The request is kept, listed, and may be authorized or rejected, as in Mastodon, but no notification of it is shown
  while its sender blocks the account: Kopje's notification rule leaves out a notification from an account that blocks
  its recipient (`shownSql`), so the kept request's `follow_request` notification is hidden and a later `Follow` writes
  none, where Mastodon's `NotifyService::DropCondition#drop?` checks only the recipient's own blocks and mutes.
- Authorizing a request (`POST /api/v1/follow_requests/:id/authorize`, or unlocking) writes no `follow` notification,
  whoever the requester; Mastodon's controller queues one (`follow_requests_controller.rb:14-16`).
