// Mastodon's error entity: { "error": "..." }.
export function mastodonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

// ActiveRecord::RecordNotFound, as Api::ErrorHandling answers it.
export function recordNotFound(): Response {
  return mastodonError(404, "Record not found");
}

// ActiveRecord::RecordInvalid: the model's error messages, joined as Rails joins them.
export function validationFailed(errors: readonly string[]): Response {
  return mastodonError(422, `Validation failed: ${errors.join(", ")}`);
}

// One error of a Rails model (ActiveModel::Error): the attribute it is on ("base" for the record), its type (a symbol
// such as too_long, or a message string such as the "is invalid" Paperclip adds) and its message.
export interface Problem {
  readonly attribute: string;
  readonly type: string;
  readonly description: string;
}

// ActiveModel::Error#full_message: the description alone on base, else the attribute as Rails' humanize writes it and
// the description. No attribute of Account or Collection has a label in Mastodon's activerecord locale
// (config/locales/activerecord.en.yml), so humanize alone names it.
export function fullMessage(problem: Problem): string {
  return problem.attribute === "base" ? problem.description : `${humanize(problem.attribute)} ${problem.description}`;
}

// ActiveSupport's humanize of an attribute name as full_message passes it ('.' read as '_'): leading underscores and a
// trailing _id dropped, '_' as a space, the first letter capitalized.
function humanize(attribute: string): string {
  const words = attribute
    .replaceAll(".", "_")
    .replace(/^_+/, "")
    .replace(/_id$/, "")
    .replaceAll("_", " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type ValidationBody = {
  error: string;
  details: Record<string, { error: string; description: string }[]>;
};

// ValidationErrorFormatter#as_json (app/lib/validation_error_formatter.rb): error is RecordInvalid's message, every full
// message in the order added; details groups the problems by attribute in the order each was first added, each as
// ERR_ and its type upcased.
export function validationBody(problems: readonly Problem[]): ValidationBody {
  const details: ValidationBody["details"] = {};
  for (const { attribute, type, description } of problems) {
    (details[attribute] ??= []).push({ error: `ERR_${type.toUpperCase()}`, description });
  }
  return { error: `Validation failed: ${problems.map(fullMessage).join(", ")}`, details };
}

// The 422 of a controller that answers with ValidationErrorFormatter: flat (update_credentials, /api/v1/profile) or
// nested in error (collections).
export function validationDetails(problems: readonly Problem[], form: "flat" | "nested"): Response {
  const body = validationBody(problems);
  return Response.json(form === "flat" ? body : { error: body }, { status: 422 });
}

export const INVALID_TOKEN = "The access token is invalid";

// A missing, unknown or expired bearer token, answered as Mastodon's Doorkeeper answers it: 401 with an RFC 6750 §3
// Bearer challenge naming the error.
export function invalidTokenError(): Response {
  const response = mastodonError(401, INVALID_TOKEN);
  response.headers.set("www-authenticate", bearerChallenge(INVALID_TOKEN));
  return response;
}

// Doorkeeper's RFC 6750 §3 challenge (OAuth::ErrorResponse#authenticate_info) for `error` with `description`.
export function bearerChallenge(description: string, error = "invalid_token"): string {
  return `Bearer realm="Doorkeeper", error="${error}", error_description="${description}"`;
}

// How long a client or peer should wait before asking again during maintenance. A cutover keeps an instance in
// maintenance for well under half an hour (docs/cutover-runbook.md); peers retry deliveries on their own schedule.
export const MAINTENANCE_RETRY_AFTER_SECONDS = 600;

export function maintenanceError(): Response {
  const response = mastodonError(503, "This server is under maintenance. Try again later.");
  response.headers.set("retry-after", String(MAINTENANCE_RETRY_AFTER_SECONDS));
  return response;
}

// How long the admin should wait before listing active or suspended accounts again while the domain job reconciles
// the domain marks (R38, domain/remote-suspension.ts): its rounds run back to back through the Queue.
const MODERATION_RETRY_AFTER_SECONDS = 30;

export function moderatingError(): Response {
  const response = mastodonError(503, "moderation in progress, try again");
  response.headers.set("retry-after", String(MODERATION_RETRY_AFTER_SECONDS));
  return response;
}
