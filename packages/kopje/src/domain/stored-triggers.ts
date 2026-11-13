import {
  applicationIdPastBoundSql,
  blurhashPastBoundSql,
  cardImagePastBoundSql,
  contactUsernamePastBoundSql,
  documentRevisionPastBoundSql,
  EMOJI_COLUMNS,
  emojisPastBoundSql,
  filterTextUnitsPastBoundSql,
  indexablePastBoundSql,
  INSTANCE_SETTING_BOUNDS,
  INSTANCE_SETTING_NAMES,
  linkReviewPastBoundSql,
  MAX_ACCOUNT_INVITATIONS,
  MAX_TREND_LINKS,
  MAX_TREND_REVIEWS,
  movedToPastBoundSql,
  oembedEndpointPastBoundSql,
  remoteFieldLinkRowPastBoundSql,
  remoteMediaObjectPastBoundSql,
  remoteMediaSlotPastBoundSql,
  remoteMediaUsagePastBoundSql,
  staticImagesPastBoundSql,
  STORED_COLUMNS,
  statusCardPastBoundSql,
  trendLinkPastBoundSql,
  unverifiedLinksPastBoundSql,
  verifiedLinksPastBoundSql,
  warningStatusIdsPastBoundSql,
} from "../platform/stored-bounds";
import { pinsFullSql } from "./status-actions";

// The triggers in force that hold a stored bound or a cap of stored-bounds.ts (RES-2, RES-4), each as the last
// migration that defines it wrote it, built from the predicates its writers share, so that a writer drops what its
// trigger would refuse (docs/engineering.md, "Stored values"). test/migrations.test.ts holds every trigger of the
// migrated schema equal to emitTriggers' text, or listed there as written by hand. A new migration that adds or
// recreates one registers it here and writes emitTriggers' output for it.

// The BEFORE INSERT and BEFORE UPDATE OF `watched` triggers `<prefix>_insert` and `<prefix>_update` on `table` that
// abort with `message` when `when` holds of the NEW row.
function boundTriggers(prefix: string, table: string, watched: string, when: string, message: string): string[] {
  const body = `BEGIN\n  SELECT RAISE(ABORT, '${message}');\nEND;`;
  return [
    `CREATE TRIGGER ${prefix}_insert BEFORE INSERT ON ${table}\nWHEN ${when}\n${body}`,
    `CREATE TRIGGER ${prefix}_update BEFORE UPDATE OF ${watched} ON ${table}\nWHEN ${when}\n${body}`,
  ];
}

// A cap trigger that refuses only a new key when `table` holds `max` rows (0057's shape).
function capTrigger(table: string, key: string, max: number): string {
  return `CREATE TRIGGER ${table}_cap BEFORE INSERT ON ${table}
WHEN NOT EXISTS (SELECT 1 FROM ${table} WHERE ${key} = NEW.${key}) AND (SELECT count(*) FROM ${table}) >= ${max}
BEGIN
  SELECT RAISE(ABORT, '${table}: more than ${max}');
END;`;
}

// True when the stored column `column` is not a fixed point of its projection: P(x) IS NOT x, with JSON-bounded
// columns short of a sixth of their bound skipped before P (0048_stored_bounds).
function pastBoundSql(
  { projection, jsonBytes }: { projection: (column: string) => string; jsonBytes?: number },
  column: string,
): string {
  const moved = `(${projection(column)}) IS NOT ${column}`;
  return jsonBytes === undefined
    ? moved
    : `CASE WHEN length(CAST(${column} AS BLOB)) <= ${Math.floor((jsonBytes - 2) / 6)} THEN 0 ELSE ${moved} END`;
}

// True when a row named `name` holding `value` is not a fixed point of its name's P (0049_instance_bounds); 0 for a
// name INSTANCE_SETTING_BOUNDS does not cover.
function settingPastBoundSql(name: string, value: string): string {
  const cases = INSTANCE_SETTING_NAMES.map(
    (n) => `WHEN '${n}' THEN (${INSTANCE_SETTING_BOUNDS[n].projection(value)}) IS NOT ${value}`,
  );
  return `CASE ${name}\n  ${cases.join("\n  ")}\n  ELSE 0 END`;
}

const SETTING_REFUSED = "instance_settings: a value past its stored bound";

// The columns each update trigger watches, as it names them.
const CARD_COLUMNS =
  "status_id, url, due_at, enqueued_at, claim, attempts, generation, title, description, author_name, " +
  "author_url, provider_name, provider_url, language, published_at, fetched_at, card_type, width, " +
  "height, embed_src, iframe_width, iframe_height, image_url, image_id, image_description, link_type, " +
  "final_url, public";
const REMOTE_FIELD_LINK_COLUMNS =
  "account_id, link_back, links, generation, claim, attempts, due_at, armed_at, hold_until, checked_at";
const CARD_IMAGE_COLUMNS =
  "id, source_url, due_at, enqueued_at, claim, attempts, token, width, height, blurhash, stored_at";
const REMOTE_MEDIA_COLUMNS =
  "id, kind, owner_id, account_id, domain, url, host, category, lane, generation, due_at, enqueued_at, " +
  "claim, attempts, token, ext, still_ext, stored_at, failed_at, seen_at";
const REMOTE_MEDIA_OBJECT_COLUMNS =
  "token, slot_id, state, charge, kind, content_type, still_type, hosts, claimed_at, stored_at, due_at, " +
  "delete_attempts";

// A link review table's triggers (0071_link_trends): its bounds, keyed by `key`, and its cap.
function reviewTriggers(table: string, key: "url" | "domain"): string[] {
  return [
    ...boundTriggers(
      `${table}_bounds`,
      table,
      `${key}, trendable, reviewed_at`,
      linkReviewPastBoundSql("NEW", key),
      `${table}: a value past its stored bound`,
    ),
    capTrigger(table, key, MAX_TREND_REVIEWS),
  ];
}

const PIN_CAP_REFUSED = "status_pins: more pins than the account may keep";

// Each trigger's statement, by the migration that last defines it.
const STATEMENTS: readonly string[] = [
  // 0048_stored_bounds: a write where P(NEW.x) IS NOT NEW.x.
  ...Object.entries(STORED_COLUMNS).flatMap(([table, columns]) =>
    boundTriggers(
      `${table}_bounds`,
      table,
      columns.map((c) => c.column).join(", "),
      columns.map((c) => pastBoundSql(c, `NEW.${c.column}`)).join("\n  OR "),
      `${table}: a value past its stored bound`,
    ),
  ),
  // 0049_instance_bounds
  ...boundTriggers(
    "instance_settings_bounds",
    "instance_settings",
    "name, value",
    settingPastBoundSql("NEW.name", "NEW.value"),
    SETTING_REFUSED,
  ),
  // 0053_custom_emoji_snapshots
  ...Object.entries(EMOJI_COLUMNS).flatMap(([table, bytes]) =>
    boundTriggers(
      `${table}_emojis`,
      table,
      "emojis",
      emojisPastBoundSql("NEW.emojis", bytes),
      `${table}: emojis past their stored bound`,
    ),
  ),
  // 0058_profile_credentials
  ...boundTriggers(
    "accounts_indexable",
    "accounts",
    "indexable",
    indexablePastBoundSql("NEW.indexable"),
    "accounts: indexable past its stored bound",
  ),
  // 0059_contact_and_activity
  ...boundTriggers(
    "instance_settings_contact",
    "instance_settings",
    "name, value",
    `NEW.name = 'contact_username' AND (${contactUsernamePastBoundSql("NEW.value")})`,
    SETTING_REFUSED,
  ),
  // 0060_account_moves
  ...boundTriggers(
    "accounts_moved_to",
    "accounts",
    "moved_to_account_id, domain",
    movedToPastBoundSql("NEW"),
    "accounts: moved_to_account_id past its stored bound",
  ),
  // 0061_account_static_images
  ...boundTriggers(
    "accounts_static_images",
    "accounts",
    "avatar_url, header_url, avatar_static_url, header_static_url, domain",
    staticImagesPastBoundSql("NEW"),
    "accounts: static image past its stored bound",
  ),
  // 0062_account_warnings
  ...boundTriggers(
    "account_warnings_status_ids",
    "account_warnings",
    "status_ids",
    warningStatusIdsPastBoundSql("NEW.status_ids"),
    "account_warnings: status_ids past its stored bound",
  ),
  // 0064_status_applications
  ...boundTriggers(
    "statuses_application",
    "statuses",
    "application_id, reblog_of_id, account_id",
    applicationIdPastBoundSql("NEW"),
    "statuses: application_id past its stored bound",
  ),
  // 0065_media_blurhash
  ...boundTriggers(
    "media_attachments_blurhash",
    "media_attachments",
    "blurhash",
    blurhashPastBoundSql("NEW.blurhash"),
    "media_attachments: blurhash past its stored bound",
  ),
  // 0066_field_verification
  ...boundTriggers(
    "local_accounts_verified_links",
    "local_accounts",
    "verified_links",
    verifiedLinksPastBoundSql("NEW.verified_links"),
    "local_accounts: verified_links past its stored bound",
  ),
  // 0068_remote_field_verification
  ...boundTriggers(
    "remote_field_links_bounds",
    "remote_field_links",
    REMOTE_FIELD_LINK_COLUMNS,
    remoteFieldLinkRowPastBoundSql("NEW"),
    "remote_field_links: a value past its stored bound",
  ),
  // 0069_card_embeds
  ...boundTriggers(
    "card_oembed_endpoints_bounds",
    "card_oembed_endpoints",
    "domain, template, expires_at",
    oembedEndpointPastBoundSql("NEW"),
    "card_oembed_endpoints: a value past its stored bound",
  ),
  // 0070_card_images
  ...boundTriggers(
    "card_images_bounds",
    "card_images",
    CARD_IMAGE_COLUMNS,
    cardImagePastBoundSql("NEW"),
    "card_images: a value past its stored bound",
  ),
  // 0071_link_trends (status_cards' triggers recreated over every column 0067, 0069, 0070 and 0071 add)
  ...boundTriggers(
    "status_cards_bounds",
    "status_cards",
    CARD_COLUMNS,
    statusCardPastBoundSql("NEW"),
    "status_cards: a value past its stored bound",
  ),
  ...boundTriggers(
    "trend_links_bounds",
    "trend_links",
    "url, domain, language, score, max_score, max_score_at",
    trendLinkPastBoundSql("NEW"),
    "trend_links: a value past its stored bound",
  ),
  capTrigger("trend_links", "url", MAX_TREND_LINKS),
  ...reviewTriggers("link_trend_reviews", "url"),
  ...reviewTriggers("link_provider_reviews", "domain"),
  // 0072_activity_tracking
  ...boundTriggers(
    "instance_settings_activity",
    "instance_settings",
    "name, value",
    "NEW.name = 'activity_api_enabled' AND NEW.value IS NOT 'true' AND NEW.value IS NOT 'false'",
    SETTING_REFUSED,
  ),
  // 0073_actor_document_revision
  ...boundTriggers(
    "accounts_document_revision",
    "accounts",
    "document_revision",
    documentRevisionPastBoundSql("NEW"),
    "accounts: document_revision past its stored bound",
  ),
  // 0076_field_link_checks
  ...boundTriggers(
    "local_accounts_unverified_links",
    "local_accounts",
    "unverified_links",
    unverifiedLinksPastBoundSql("NEW.unverified_links"),
    "local_accounts: unverified_links past its stored bound",
  ),
  // 0077_remote_media
  ...boundTriggers(
    "remote_media_bounds",
    "remote_media",
    REMOTE_MEDIA_COLUMNS,
    remoteMediaSlotPastBoundSql("NEW"),
    "remote_media: a value past its stored bound",
  ),
  ...boundTriggers(
    "remote_media_objects_bounds",
    "remote_media_objects",
    REMOTE_MEDIA_OBJECT_COLUMNS,
    remoteMediaObjectPastBoundSql("NEW"),
    "remote_media_objects: a value past its stored bound",
  ),
  ...boundTriggers(
    "remote_media_usage_bounds",
    "remote_media_usage",
    "id, bytes, doomed, pending",
    remoteMediaUsagePastBoundSql("NEW"),
    "remote_media_usage: a value past its stored bound",
  ),
  // 0079_filter_text_units: the bound, and the clearing of a measure a text change left behind (one row, by key).
  ...boundTriggers(
    "statuses_filter_text",
    "statuses",
    "filter_text_units",
    filterTextUnitsPastBoundSql("NEW.filter_text_units"),
    "statuses: filter_text_units past its stored bound",
  ),
  `CREATE TRIGGER statuses_filter_text_stale AFTER UPDATE OF content, spoiler_text, source_text ON statuses
WHEN NEW.filter_text_units IS NOT NULL
BEGIN
  UPDATE statuses SET filter_text_units = NULL WHERE id = NEW.id;
END;`,
  // 0081_account_invitations: the cap, and an invitation is added or removed, never changed.
  `CREATE TRIGGER account_invitations_cap BEFORE INSERT ON account_invitations
WHEN (SELECT count(*) FROM account_invitations) >= ${MAX_ACCOUNT_INVITATIONS}
BEGIN
  SELECT RAISE(ABORT, 'account_invitations: more than ${MAX_ACCOUNT_INVITATIONS}');
END;`,
  `CREATE TRIGGER account_invitations_immutable BEFORE UPDATE ON account_invitations
BEGIN
  SELECT RAISE(ABORT, 'account_invitations: an invitation is added or removed, never changed');
END;`,
  // 0089_pin_cap: a pin past its account's limit, inserted or moved to another account.
  `CREATE TRIGGER status_pins_cap_insert BEFORE INSERT ON status_pins
WHEN ${pinsFullSql("NEW.account_id", "NEW.status_id")}
BEGIN
  SELECT RAISE(ABORT, '${PIN_CAP_REFUSED}');
END;`,
  `CREATE TRIGGER status_pins_cap_update BEFORE UPDATE OF account_id ON status_pins
WHEN NEW.account_id IS NOT OLD.account_id AND ${pinsFullSql("NEW.account_id", "NEW.status_id")}
BEGIN
  SELECT RAISE(ABORT, '${PIN_CAP_REFUSED}');
END;`,
];

// Each registered trigger's statement by its name.
export const STORED_TRIGGERS: ReadonlyMap<string, string> = (() => {
  const triggers = new Map<string, string>();
  for (const statement of STATEMENTS) {
    const name = /^CREATE TRIGGER (\w+) /.exec(statement)?.[1] ?? "";
    if (name === "" || triggers.has(name)) {
      throw new Error(`stored-triggers: unnamed or repeated trigger ${name}`);
    }
    triggers.set(name, statement);
  }
  return triggers;
})();

// The text a migration writes for the registered triggers `names`, in order: each statement, a blank line between
// them, and a final newline.
export function emitTriggers(names: readonly string[]): string {
  const statements = names.map((name) => {
    const statement = STORED_TRIGGERS.get(name);
    if (statement === undefined) {
      throw new Error(`stored-triggers: ${name} is not registered`);
    }
    return statement;
  });
  return `${statements.join("\n\n")}\n`;
}
