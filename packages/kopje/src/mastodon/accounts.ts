import type { AccountUpdate, CredentialChanges, CredentialsUpdated, ProfileImages } from "../domain/account-actions";
import {
  type FieldSource,
  MAX_ACCOUNTS_BY_ID,
  MAX_ATTRIBUTION_DOMAINS,
  MAX_DISPLAY_NAME,
  MAX_FIELD_NAME,
  MAX_FIELD_VALUE,
  MAX_FIELDS,
  MAX_NOTE,
  type RelationshipResult,
  type Visibility,
} from "../domain/accounts";
import { QUOTE_POLICY_NAMES, type QuotePolicyName } from "../domain/audience";
import type { Authorized, UserCredential } from "../domain/auth";
import { DIRECTORY_DEFAULT_LIMIT, DIRECTORY_MAX_LIMIT } from "../domain/directory";
import { PROFILE_IMAGES, type ProfileImage } from "../domain/media";
import { MAX_RAW_LENGTH, noteLength } from "../domain/status-text";
import { base64DataUriPayload, decodeRubyBase64 } from "../platform/data-uri";
import { parseAddress } from "../platform/domain-name";
import { PROFILE_IMAGE_LIMIT, PROFILE_TOO_LARGE, profileImageAccepted, SIGNATURE_BYTES } from "../platform/images";
import { railsBlank } from "../platform/rails-blank";
import type { StoreStub } from "../platform/store-client";
import { StoreUnavailableError } from "../platform/store-errors";
import {
  cutCodePoints,
  PROFILE_DESCRIPTION_LIMIT,
  withinAttributionDomainBound,
  yieldsMoreThan,
} from "../platform/stored-bounds";
import { rubyStrip } from "../platform/strip";
import { grantsAny } from "../security/scopes";
import {
  type ApiContext,
  type ApiDeps,
  type ApiHandler,
  authorized,
  credential,
  credential as tokenCredential,
  judged,
  optionalCredential,
  optionalTokenCredential,
  present,
  refuseAfterAuth,
  requestJobsSoon,
  storeCall,
  userCredential,
  withParams,
} from "./context";
import { mastodonError, type Problem, recordNotFound, validationDetails, validationFailed } from "./errors";
import {
  discardProfileUploads,
  type Failure,
  PIXELS_PROBLEM,
  type ProfileUpload,
  storeProfileImage,
  sweepSoon,
  type UploadContext,
} from "./media";
import { pageQuery, pageResponse, unlimitedResponse } from "./pagination";
import { limitParam, mediaTypeOf, offsetParam, type Params, parseBoolean, readParams } from "./params";
import { MAX_SEARCH_OFFSET, resolveQuery, searchParams } from "./search";

// /api/v1/accounts: credentials, lookup, search, relationships, follow, follower lists, notes and endorsements.

export const verifyCredentials: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  const account = authorized(
    await storeCall(c, deps, (s, b) => s.verifyCredentials(b, { credential, present: present(c) })),
  );
  return account === null ? recordNotFound() : c.json(account);
};

const VISIBILITIES: readonly string[] = ["public", "unlisted", "private", "direct"];
const LANGUAGE = /^[a-z]{2,3}$/;
// ActiveModel's inclusion error on `attribute`.
function notIncluded(attribute: string): Problem {
  return { attribute, type: "inclusion", description: "is not included in the list" };
}

// ActiveModel's too_long error on `attribute`.
function tooLong(attribute: string, maximum: number): Problem {
  return { attribute, type: "too_long", description: `is too long (maximum is ${maximum} characters)` };
}

// The validation problems of a form's avatar and header files (profileFiles), by image.
export type ImageProblems = Readonly<Record<ProfileImage, readonly Problem[]>>;

const NO_IMAGE_PROBLEMS: ImageProblems = { avatar: [], header: [] };

// The changes both update_credentials and the profile update ask for (Mastodon's account_params), and the validation
// problems with them, as Mastodon validates them: Account::Avatar's (the file's, then its description's) and
// Account::Header's, Account::AttributionDomains', then the display name's, the note's and the fields'
// (app/models/account.rb:33-50, 131-134).
function accountChanges(p: Params, images: ImageProblems): { changes: CredentialChanges; problems: Problem[] } {
  const changes: CredentialChanges = {};
  const problems: Problem[] = [];
  // Stored as sent: Mastodon strips neither. '' clears one; an absent one is kept.
  const avatarDescription = p.get("avatar_description");
  const headerDescription = p.get("header_description");
  for (const [kind, description] of [
    ["avatar", avatarDescription],
    ["header", headerDescription],
  ] as const) {
    problems.push(...images[kind]);
    if (description !== undefined && yieldsMoreThan(description, PROFILE_DESCRIPTION_LIMIT)) {
      problems.push(tooLong(`${kind}_description`, PROFILE_DESCRIPTION_LIMIT));
    }
  }
  changes.avatarDescription = avatarDescription;
  changes.headerDescription = headerDescription;
  const attribution = p.list("attribution_domains");
  if (attribution !== undefined) {
    const domains = normalizeAttributionDomains(attribution);
    // A domain past ATTRIBUTION_DOMAIN_BYTES (a host padded with characters IDNA ignores) is refused as not valid,
    // so every stored domain is presented (presentedAttributionDomains; docs/mastodon-deviations.md). Each invalid
    // domain is reported with its text, as DomainValidator reports it, but only the first MAX_ATTRIBUTION_DOMAINS:
    // the cap bounds the answer (test/accounts.test.ts derives its maximum).
    const invalid = domains.filter((d) => !compliantDomain(d) || !withinAttributionDomainBound(d));
    for (const domain of invalid.slice(0, MAX_ATTRIBUTION_DOMAINS)) {
      problems.push({
        attribute: "attribution_domains",
        type: "invalid_domain_on_line",
        description: `${domain} is not a valid domain name`,
      });
    }
    if (domains.length > MAX_ATTRIBUTION_DOMAINS) {
      problems.push(tooLong("attribution_domains", MAX_ATTRIBUTION_DOMAINS));
    }
    changes.attributionDomains = domains;
  }
  // Account#prepare_contents strips both before they are validated and stored; a NUL left inside counts here and is
  // dropped when stored (storedText).
  const rawName = p.get("display_name");
  if (rawName !== undefined) {
    const displayName = rubyStrip(rawName);
    if (yieldsMoreThan(displayName, MAX_DISPLAY_NAME)) {
      problems.push(tooLong("display_name", MAX_DISPLAY_NAME));
    }
    changes.displayName = displayName;
  }
  // The note is counted as NoteLengthValidator counts it (noteLength), after the raw bound of a status's text on the
  // note as sent, before anything is parsed: a link counts 23 characters whatever its length.
  const rawNote = p.get("note");
  if (rawNote !== undefined) {
    const note = rubyStrip(rawNote);
    if (rawNote.length > MAX_RAW_LENGTH || noteLength(note) > MAX_NOTE) {
      problems.push(tooLong("note", MAX_NOTE));
    }
    changes.note = note;
  }
  // fields_attributes replaces every field (Account#fields_attributes=, app/models/account.rb:399-416), which drops a
  // pair whose name and value are both blank by Rails and stores the rest as sent; Account#fields reads each through
  // Account::Field#sanitize, stripped by Ruby and cut to its first MAX_FIELD_NAME characters, and leaves out one without
  // a name or a value (sanitize raises on nil), so a JSON null reads as not sent. Kopje stores what that read gives, so
  // the count and the labels are judged on it as Mastodon judges them. An empty JSON object (`{}`, `{"0":{}}`) is a
  // sent, empty hash, which clears the fields.
  if (p.has("fields_attributes") || p.sentObject("fields_attributes") || p.objects("fields_attributes").length > 0) {
    const fields: FieldSource[] = p.objects("fields_attributes", { nulls: "absent" }).flatMap(({ name, value }) =>
      name === undefined || value === undefined || (railsBlank(name) && railsBlank(value))
        ? []
        : [
            {
              name: cutCodePoints(rubyStrip(name), MAX_FIELD_NAME),
              value: cutCodePoints(rubyStrip(value), MAX_FIELD_VALUE),
            },
          ],
    );
    if (fields.length > MAX_FIELDS) {
      problems.push(tooLong("fields", MAX_FIELDS));
    }
    // EmptyProfileFieldNamesValidator.
    if (fields.some((field) => railsBlank(field.name) && !railsBlank(field.value))) {
      problems.push({
        attribute: "fields",
        type: "fields_with_values_missing_labels",
        description: "contains values with missing labels",
      });
    }
    changes.fields = fields;
  }
  changes.locked = parseBoolean(p.get("locked"));
  changes.bot = parseBoolean(p.get("bot"));
  changes.discoverable = parseBoolean(p.get("discoverable"));
  changes.indexable = parseBoolean(p.get("indexable"));
  changes.hideCollections = parseBoolean(p.get("hide_collections"));
  return { changes, problems };
}

// The changes update_credentials asks for: accountChanges and its source[...] (Mastodon's user_params), with their
// validation problems, the form's image files' (profileFiles) among them. Shared by the API and the settings page
// (app/web.tsx), which posts the same names. Avatar and header come through the media pipeline on the settings page
// only.
export function credentialChanges(
  p: Params,
  images: ImageProblems = NO_IMAGE_PROBLEMS,
): { changes: CredentialChanges; problems: Problem[] } {
  const { changes, problems } = accountChanges(p, images);
  // Mastodon saves the account first and raises on another value of these (500); Kopje refuses it with the account's
  // problems, as a Rails inclusion error.
  const privacy = p.get("source[privacy]");
  if (privacy !== undefined) {
    if (!VISIBILITIES.includes(privacy)) {
      problems.push(notIncluded("privacy"));
    }
    changes.privacy = privacy as Visibility;
  }
  // UserSettings' default_quote_policy (public, followers or nobody).
  const quotePolicy = p.get("source[quote_policy]");
  if (quotePolicy !== undefined) {
    if (!QUOTE_POLICY_NAMES.includes(quotePolicy as QuotePolicyName)) {
      problems.push(notIncluded("quote_policy"));
    }
    changes.quotePolicy = quotePolicy as QuotePolicyName;
  }
  const language = p.get("source[language]");
  if (language !== undefined) {
    if (language !== "" && !LANGUAGE.test(language)) {
      problems.push({ attribute: "language", type: "invalid", description: "is not a valid language code" });
    }
    changes.language = language === "" ? null : language;
  }
  changes.sensitive = parseBoolean(p.get("source[sensitive]"));
  return { changes, problems };
}

// The changes the profile update asks for (Api::V1::ProfilesController#account_params): accountChanges and the display
// settings, which only it sets. source[...] is neither read nor validated, as there.
function profileChanges(p: Params, images: ImageProblems): { changes: CredentialChanges; problems: Problem[] } {
  const { changes, problems } = accountChanges(p, images);
  changes.showFeatured = parseBoolean(p.get("show_featured"));
  changes.showMedia = parseBoolean(p.get("show_media"));
  changes.showMediaReplies = parseBoolean(p.get("show_media_replies"));
  return { changes, problems };
}

// Account::AttributionDomains' normalization: each value stripped as Ruby strips (rubyStrip) and of an http://,
// https:// and *. prefix, then dropped when blank (`presence`: railsBlank), duplicates removed. Values are kept as
// written otherwise.
function normalizeAttributionDomains(values: readonly string[]): string[] {
  const domains = values
    .map((value) =>
      rubyStrip(value)
        .replace(/^http:\/\//, "")
        .replace(/^https:\/\//, "")
        .replace(/^\*\./, ""),
    )
    .filter((value) => !railsBlank(value));
  return [...new Set(domains)];
}

const MAX_DOMAIN_LENGTH = 256;
const DOMAIN_LABEL = /^[a-z0-9-]{1,63}$/;
const MAX_LABEL_CHARACTERS = 64;

// DomainValidator#compliant?: the host, lowercased and IDNA-encoded, shorter than 256 characters, of labels of 1 to 63
// letters, digits and hyphens (a trailing dot is allowed, as Ruby's split drops the empty label after it). A value
// with a character a host cannot hold (Addressable::URI::InvalidURIError) is not compliant. Addressable converts only
// a '.'-separated label of fewer than 64 characters as written (addressable 2.9.2, idna/native.rb to_ascii) and keeps
// a longer one, which then fails the label rule, so a label of 64 or more characters as written is not compliant
// whatever IDNA would drop of it (U+00AD).
function compliantDomain(value: string): boolean {
  if (value.split(".").some((label) => [...label].length >= MAX_LABEL_CHARACTERS)) {
    return false;
  }
  let host: string;
  if (/^[\x21-\x7e]*$/.test(value)) {
    host = value.toLowerCase();
  } else if ([...value].some((c) => c <= " " || c === "\x7f" || '/\\?#@:"<>{}'.includes(c))) {
    return false;
  } else {
    const hostname = URL.parse(`https://${value}/`)?.hostname;
    if (hostname === undefined) {
      return false;
    }
    host = hostname;
  }
  const labels = host.split(".");
  while (labels.length > 0 && labels.at(-1) === "") {
    labels.pop();
  }
  return host.length < MAX_DOMAIN_LENGTH && labels.every((label) => DOMAIN_LABEL.test(label));
}

const PROFILE_FILES = { names: PROFILE_IMAGES, maxBytes: PROFILE_IMAGE_LIMIT };

// Paperclip's content type validation of an image (validators/attachment_content_type_validator.rb): its error on the
// content type, copied to the image as the message string it is (add_validation_errors_to: :both).
function contentTypeProblems(kind: ProfileImage): Problem[] {
  return [
    { attribute: `${kind}_content_type`, type: "invalid", description: "is invalid" },
    { attribute: kind, type: "is invalid", description: "is invalid" },
  ];
}

// The avatar and header of a credentials form, each a file part or a base64 data URI (platform/data-uri.ts), checked
// as Paperclip validates them before anything is reserved, each problem as Paperclip adds it (the content type's, then
// the size's: attachment_size_validator.rb adds less_than to the image and then to its file size); or 'string' for any
// other non-empty text value (Paperclip has no handler for it: 400). An empty value reads as absent.
export async function profileFiles(
  p: Params,
): Promise<{ images: Partial<Record<ProfileImage, Blob>>; problems: ImageProblems } | "string"> {
  const images: Partial<Record<ProfileImage, Blob>> = {};
  const problems: Record<ProfileImage, Problem[]> = { avatar: [], header: [] };
  for (const kind of PROFILE_IMAGES) {
    const text = p.get(kind) ?? "";
    const payload = base64DataUriPayload(text);
    if (text !== "" && payload === undefined) {
      return "string";
    }
    const file = payload === undefined ? p.file(kind) : new Blob([decodeRubyBase64(text, payload)]);
    if (file === undefined) {
      continue;
    }
    if (!profileImageAccepted(new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer()))) {
      problems[kind].push(...contentTypeProblems(kind));
    }
    if (file.size >= PROFILE_IMAGE_LIMIT) {
      problems[kind].push(
        { attribute: kind, type: "less_than", description: PROFILE_TOO_LARGE },
        { attribute: `${kind}_file_size`, type: "less_than", description: PROFILE_TOO_LARGE },
      );
    }
    if (problems[kind].length === 0) {
      images[kind] = file;
    }
  }
  return { images, problems };
}

// A base error, as an unsaved Account answers an expired upload.
export const UPLOAD_EXPIRED: Problem = { attribute: "base", type: "invalid", description: "The upload expired" };

// Each image through the upload pipeline (mastodon/media.ts storeProfileImage), in turn, its bytes read only then; the
// uploads made so far are passed to `owned` as they complete, so the caller can discard them if the request fails. A
// validation failure is its problems: the content type's as profileFiles reports it, the pixel limit as the image's
// invalid, an expired upload as UPLOAD_EXPIRED.
export async function storeProfileImages(
  c: UploadContext,
  deps: ApiDeps,
  credential: () => UserCredential,
  images: Partial<Record<ProfileImage, Blob>>,
  owned: ProfileUpload[],
): Promise<ProfileImages | Failure | Problem[]> {
  const ids: ProfileImages = {};
  for (const kind of PROFILE_IMAGES) {
    const file = images[kind];
    if (file === undefined) {
      continue;
    }
    const stored = await storeProfileImage(c, deps, credential, new Uint8Array(await file.arrayBuffer()));
    if (!stored.ok) {
      return profileFailure(kind, stored);
    }
    owned.push(stored.upload);
    ids[kind] = stored.upload.id;
  }
  return ids;
}

function profileFailure(kind: ProfileImage, failure: Failure): Failure | Problem[] {
  switch (failure.problem) {
    case "content_type":
      return contentTypeProblems(kind);
    case "pixels":
      return [{ attribute: kind, type: "invalid", description: PIXELS_PROBLEM }];
    case "expired":
      return [UPLOAD_EXPIRED];
    default:
      return failure;
  }
}

// PATCH /api/v1/accounts/update_credentials and PATCH or PUT /api/v1/profile: `changesOf` takes the changes from the
// parameters, `call` applies them and presents the account. A multipart body may carry the avatar and header files, so
// its token is checked before the body is read (an invalid or under-scoped token reads no 17.9 MB body); text, then
// images, are validated before anything is reserved, and the Store applies everything in one transaction.
function credentialsUpdate<A>(
  changesOf: (p: Params, images: ImageProblems) => { changes: CredentialChanges; problems: Problem[] },
  call: (
    store: StoreStub,
    build: string,
    input: Omit<AccountUpdate, "storeNow"> & { credential: UserCredential },
  ) => Promise<Authorized<CredentialsUpdated<A>>>,
): ApiHandler {
  return async (c, deps) => {
    const multipart = mediaTypeOf(c.req.header("content-type")) === "multipart/form-data";
    if (multipart) {
      const value = credential(c, deps);
      authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)));
    }
    const read = await readParams(c.req.raw, { files: PROFILE_FILES });
    if (!read.ok) {
      const response = mastodonError(
        read.status,
        read.status === 413 ? "Request body is too large" : "Malformed request body",
      );
      return multipart ? response : refuseAfterAuth(c, deps, response);
    }
    const p = read.params;
    const files = await profileFiles(p);
    if (files === "string") {
      return refuseAfterAuth(c, deps, mastodonError(400, "Bad Request"));
    }
    const { changes, problems } = changesOf(p, files.problems);
    if (problems.length > 0) {
      return refuseAfterAuth(c, deps, validationDetails(problems, "flat"));
    }
    const owned: ProfileUpload[] = [];
    let committed = false;
    try {
      const images = await storeProfileImages(c, deps, () => userCredential(c, deps), files.images, owned);
      if (Array.isArray(images)) {
        return validationDetails(images, "flat");
      }
      if ("error" in images) {
        return mastodonError(images.status, images.error);
      }
      const value = userCredential(c, deps);
      const result = authorized(
        await storeCall(c, deps, (s, b) =>
          call(s, b, { credential: value, changes, images, present: present(c), now: deps.now() }),
        ),
      );
      if (result.status === "upload_gone") {
        return validationDetails([UPLOAD_EXPIRED], "flat");
      }
      if (result.status === "not_found") {
        return recordNotFound();
      }
      committed = true;
      if (owned.length > 0) {
        // The replaced images' uploads go with the sweep.
        sweepSoon(c, deps);
      }
      if (result.accepting) {
        requestJobsSoon(c, deps);
      }
      return c.json(result.account);
    } finally {
      if (!committed) {
        await discardProfileUploads(c, deps, owned);
      }
    }
  };
}

export const updateCredentials = credentialsUpdate(credentialChanges, (s, b, input) => s.updateCredentials(b, input));

// The profile update, answered with the Profile (REST::ProfileSerializer).
export const updateProfile = credentialsUpdate(profileChanges, (s, b, input) => s.updateProfile(b, input));

// GET /api/v1/profile.
export const getProfile: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  const profile = authorized(await storeCall(c, deps, (s, b) => s.profile(b, { credential, present: present(c) })));
  return profile === null ? recordNotFound() : c.json(profile);
};

// DELETE /api/v1/profile/avatar and /api/v1/profile/header: the account shows the default image again and other
// servers receive the Update; the removed image's files go with the sweep after the response.
function removeProfileImage(kind: ProfileImage): ApiHandler {
  return async (c, deps) => {
    const credential = userCredential(c, deps);
    const account = authorized(
      await storeCall(c, deps, (s, b) =>
        s.removeProfileImage(b, { credential, kind, present: present(c), now: deps.now() }),
      ),
    );
    if (account === null) {
      return recordNotFound();
    }
    sweepSoon(c, deps);
    return c.json(account);
  };
}

export const removeAvatar = removeProfileImage("avatar");
export const removeHeader = removeProfileImage("header");

export const getAccount: ApiHandler = async (c, deps) => {
  const id = c.req.param("id") ?? "";
  const credential = optionalTokenCredential(c, deps);
  const account = judged(
    c,
    await storeCall(c, deps, (s, b) => s.getAccount(b, { id, present: present(c), credential })),
  ).value;
  return account === null ? recordNotFound() : c.json(account);
};

// GET /api/v1/accounts?id[]= (AccountsController#index): the accounts getAccount would show, in one read. More than
// DEFAULT_ACCOUNTS_LIMIT distinct ids raise Mastodon::ValidationError, which answers 422 with the class's name.
export const getAccounts: ApiHandler = withParams(async (c, deps, p) => {
  const ids = [...new Set(p.getAll("id"))];
  if (ids.length > MAX_ACCOUNTS_BY_ID) {
    return mastodonError(422, "Mastodon::ValidationError");
  }
  const credential = optionalTokenCredential(c, deps);
  return c.json(
    judged(c, await storeCall(c, deps, (s, b) => s.getAccounts(b, { ids, present: present(c), credential }))).value,
  );
});

// POST /api/v1/accounts (AccountsController#create): Kopje has no open registration, so it answers as Mastodon does
// with registrations closed, after Mastodon's checks in their order: the token (doorkeeper_authorize! :write,
// :'write:accounts'), then an app token (require_client_credentials!), then check_enabled_registrations's `forbidden`.
export const register: ApiHandler = async (c, deps) => {
  const value = tokenCredential(c, deps);
  const viewer = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)));
  if (!grantsAny(viewer.scopes, "write:accounts")) {
    authorized({ status: "insufficient_scope" });
  }
  if (viewer.accountId !== null) {
    return mastodonError(403, "This method requires an client credentials authentication");
  }
  return mastodonError(403, "Forbidden");
};

// acct (Rails' params[:acct], the last value the query gives) is "user" or "user@domain"; the instance's own host means
// a local account.
export const lookupAccount: ApiHandler = async (c, deps) => {
  // ResolveAccountService: stripped as Ruby strips (rubyStrip), then one leading @ dropped.
  const acct = rubyStrip(c.req.queries("acct")?.at(-1) ?? "").replace(/^@/, "");
  const at = acct.indexOf("@");
  const username = at === -1 ? acct : acct.slice(0, at);
  const host = at === -1 ? null : acct.slice(at + 1).toLowerCase();
  if (username === "" || host === "") {
    return recordNotFound();
  }
  const domain = host === null || host === new URL(c.req.url).host ? null : host;
  const credential = optionalTokenCredential(c, deps);
  const account = judged(
    c,
    await storeCall(c, deps, (s, b) => s.lookupAccount(b, { username, domain, present: present(c), credential })),
  ).value;
  return account === null ? recordNotFound() : c.json(account);
};

export const relationships: ApiHandler = withParams(async (c, deps, p) => {
  const ids = p.getAll("id");
  const withSuspended = parseBoolean(p.get("with_suspended")) === true;
  const credential = userCredential(c, deps);
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.relationships(b, { credential, ids, withSuspended }))));
});

// resolve=true (AccountSearchService#exact_match): at offset 0, a user@domain query is resolved as /api/v2/search
// resolves it (resolveQuery), after the token is verified; a URL query is not. The resolution failing, a Store in
// maintenance included, leaves the answer to local data (Mastodon's suppress_errors). The final search takes a fresh
// credential, so a token that expired while resolving is refused.
export const searchAccounts: ApiHandler = withParams(async (c, deps, p) => {
  const parsed = searchParams(p);
  if ("error" in parsed) {
    return refuseAfterAuth(c, deps, parsed.error);
  }
  const { limit } = pageQuery(p);
  const following = parseBoolean(p.get("following")) ?? false;
  const resolving = parseBoolean(p.get("resolve")) === true && parsed.offset === 0;
  // Mastodon's limit_param(40) can be 0 (`limit=0`, a non-number), which answers [] before resolving
  // (account_search_service.rb:196); pageQuery serves at least one.
  // AccountSearchService strips q as Ruby does (rubyStrip) and drops one leading @: a query then blank (railsBlank)
  // finds nothing, before any resolution (account_search_service.rb:173, :200).
  const query = rubyStrip(parsed.query);
  if (parsed.offset > MAX_SEARCH_OFFSET || limitParam(p, 40, 80) === 0 || railsBlank(query.replace(/^@/, ""))) {
    authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, userCredential(c, deps))));
    return c.json([]);
  }
  let resolvedAccountId: string | undefined;
  if (resolving && parseAddress(query) !== null) {
    try {
      resolvedAccountId = (await resolveQuery(c, deps, query))?.accounts[0]?.id;
    } catch (error) {
      if (!(error instanceof StoreUnavailableError)) {
        throw error;
      }
    }
  }
  const accounts = await storeCall(c, deps, (s, b) =>
    s.searchAccounts(b, {
      credential: userCredential(c, deps),
      query,
      limit,
      offset: parsed.offset,
      following,
      localDomain: new URL(c.req.url).host,
      present: present(c),
      resolvedAccountId,
    }),
  );
  return c.json(authorized(accounts));
});

export function relationshipResponse(c: ApiContext, result: RelationshipResult): Response {
  switch (result.status) {
    case "ok":
      return c.json(result.relationship);
    case "not_found":
      return recordNotFound();
    case "forbidden":
      return mastodonError(403, "This action is not allowed");
    case "unavailable":
      return mastodonError(503, "This action cannot be recorded right now");
  }
}

export const follow: ApiHandler = withParams(async (c, deps, p) => {
  // Absent keeps the follow's filter; an empty list (`languages: []`, `languages[]=`) clears it.
  const languages = p.has("languages") ? p.getAll("languages").filter((language) => language !== "") : undefined;
  const input = {
    credential: userCredential(c, deps),
    target: c.req.param("id") ?? "",
    reblogs: parseBoolean(p.get("reblogs")),
    notify: parseBoolean(p.get("notify")),
    languages,
    now: deps.now(),
  };
  const result = authorized(await storeCall(c, deps, (s, b) => s.follow(b, input)));
  return result.status === "invalid" ? validationFailed(result.errors) : relationshipResponse(c, result);
});

export const unfollow: ApiHandler = async (c, deps) => {
  const target = c.req.param("id") ?? "";
  const credential = userCredential(c, deps);
  const input = { credential, target, now: deps.now() };
  return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.unfollow(b, input))));
};

// POST /api/v1/accounts/:id/remove_from_followers (RemoveFromFollowersService).
export const removeFromFollowers: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), target: c.req.param("id") ?? "", now: deps.now() };
  return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.removeFromFollowers(b, input))));
};

// POST /api/v1/accounts/:id/note (Accounts::NotesController): the viewer's private note, `comment`.
export const note: ApiHandler = withParams(async (c, deps, p) => {
  const input = {
    credential: userCredential(c, deps),
    target: c.req.param("id") ?? "",
    comment: p.get("comment"),
    now: deps.now(),
  };
  const result = authorized(await storeCall(c, deps, (s, b) => s.setNote(b, input)));
  return result.status === "invalid" ? validationFailed(result.errors) : relationshipResponse(c, result);
});

// POST /api/v1/accounts/:id/endorse and /pin, /unendorse and /unpin (Accounts::EndorsementsController).
export const endorse: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), target: c.req.param("id") ?? "", now: deps.now() };
  const result = authorized(await storeCall(c, deps, (s, b) => s.endorse(b, input)));
  return result.status === "invalid" ? validationFailed(result.errors) : relationshipResponse(c, result);
};

export const unendorse: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), target: c.req.param("id") ?? "", now: deps.now() };
  return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.unendorse(b, input))));
};

// GET /api/v1/endorsements (EndorsementsController): the viewer's, 40 by default and at most 80 with Link headers, or
// every one at once with limit=0, without them. Kopje's limit=0 answer stops at MAX_ENDORSEMENTS_ANSWERED and
// ANSWER_BYTES (8 MiB, RES-3); one cut by the bytes links next to the rest (unlimitedResponse).
export const endorsements: ApiHandler = withParams(async (c, deps, p) => {
  const query = pageQuery(p);
  const page = p.get("limit") === "0" ? null : query;
  const input = { credential: userCredential(c, deps), page, from: query.maxId, present: present(c) };
  const result = authorized(await storeCall(c, deps, (s, b) => s.listEndorsements(b, input)));
  return page === null ? unlimitedResponse(c, result) : pageResponse(c, result, page.limit);
});

// GET /api/v1/directory (Api::V1::DirectoriesController#show, domain/directory.ts). Parameters as Mastodon reads them:
// `order` new or active (the default; Kopje reads any other value as active, where Mastodon fails), `local` as a
// Rails boolean, `offset` (a negative or unreadable one is 0), and `limit` as limit_param (the absolute value, at
// most 80; 0 or an unreadable one answers no accounts).
export const directory: ApiHandler = withParams(async (c, deps, p) => {
  const credential = optionalTokenCredential(c, deps);
  const input = {
    credential,
    order: p.get("order") === "new" ? ("new" as const) : ("active" as const),
    local: parseBoolean(p.get("local")) ?? false,
    offset: offsetParam(p),
    limit: limitParam(p, DIRECTORY_DEFAULT_LIMIT, DIRECTORY_MAX_LIMIT),
    now: deps.now(),
    present: present(c),
  };
  const accounts = authorized(await storeCall(c, deps, (s, b) => s.directory(b, input)));
  return c.json(accounts);
});

// GET /api/v1/accounts/:id/endorsements (Accounts::EndorsementsController#index): public.
export const accountEndorsements: ApiHandler = withParams(async (c, deps, p) => {
  const page = pageQuery(p);
  const input = {
    credential: optionalCredential(c, deps),
    account: c.req.param("id") ?? "",
    page,
    now: deps.now(),
    present: present(c),
  };
  const result = authorized(await storeCall(c, deps, (s, b) => s.accountEndorsements(b, input)));
  return result === null ? recordNotFound() : pageResponse(c, result, page.limit);
});

function followList(direction: "followers" | "following"): ApiHandler {
  return withParams(async (c, deps, p) => {
    const page = pageQuery(p);
    const credential = optionalCredential(c, deps);
    const result = authorized(
      await storeCall(c, deps, (s, b) =>
        s.listFollows(b, {
          credential,
          account: c.req.param("id") ?? "",
          direction,
          page,
          now: deps.now(),
          present: present(c),
        }),
      ),
    );
    if (result === null) {
      return recordNotFound();
    }
    return pageResponse(c, result, page.limit);
  });
}

export const followers = followList("followers");
export const following = followList("following");

// /api/v1/follow_requests: the viewer's pending followers, and the decision on one of them (VIS-9).
export const followRequests: ApiHandler = withParams(async (c, deps, p) => {
  const page = pageQuery(p);
  const credential = userCredential(c, deps);
  const result = authorized(
    await storeCall(c, deps, (s, b) => s.listFollowRequests(b, { credential, page, present: present(c) })),
  );
  return pageResponse(c, result, page.limit);
});

function answerFollowRequest(decision: "authorize" | "reject"): ApiHandler {
  return async (c, deps) => {
    const input = { credential: userCredential(c, deps), account: c.req.param("id") ?? "", decision, now: deps.now() };
    return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.answerFollowRequest(b, input))));
  };
}

export const authorizeFollowRequest = answerFollowRequest("authorize");
export const rejectFollowRequest = answerFollowRequest("reject");

export const preferences: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  const result = authorized(await storeCall(c, deps, (s, b) => s.preferences(b, { credential })));
  return result === null ? recordNotFound() : c.json(result);
};

export const familiarFollowers: ApiHandler = withParams(async (c, deps, p) => {
  const ids = p.getAll("id");
  const credential = userCredential(c, deps);
  return c.json(
    authorized(await storeCall(c, deps, (s, b) => s.familiarFollowers(b, { credential, ids, present: present(c) }))),
  );
});
