import { describe, expect, it } from "vitest";

import { fullMessage, type Problem, validationBody, validationDetails } from "../src/mastodon/errors";

// ValidationErrorFormatter (app/lib/validation_error_formatter.rb) and ActiveModel's full_message, as Mastodon 4.7.5
// answers them: the base body below is an unsaved Account's on M1 (`errors.add(:base, :invalid, message: ...)`).
describe("validation details", () => {
  const expired: Problem = { attribute: "base", type: "invalid", description: "The upload expired" };
  const M1_BASE =
    '{"error":"Validation failed: The upload expired","details":{"base":[{"error":"ERR_INVALID","description":"The upload expired"}]}}';

  it("formats as ValidationErrorFormatter", async () => {
    const flat = validationDetails([expired], "flat");
    expect(flat.status).toBe(422);
    expect(await flat.text()).toBe(M1_BASE);
    const nested = validationDetails([expired], "nested");
    expect(nested.status).toBe(422);
    expect(await nested.text()).toBe(`{"error":${M1_BASE}}`);
    // Humanized as Rails humanizes an attribute name; a type that is a message keeps its space when upcased.
    expect(
      [
        { attribute: "avatar_content_type", type: "invalid", description: "is invalid" },
        { attribute: "account_id", type: "blank", description: "must exist" },
        { attribute: "_private", type: "blank", description: "can't be blank" },
        { attribute: "collection_items.account", type: "taken", description: "is taken" },
      ].map(fullMessage),
    ).toEqual([
      "Avatar content type is invalid",
      "Account must exist",
      "Private can't be blank",
      "Collection items account is taken",
    ]);
    // error keeps the order the problems were added; details groups them by attribute, in first-added order.
    const fields = (type: string, description: string): Problem => ({ attribute: "fields", type, description });
    expect(
      JSON.stringify(
        validationBody([
          fields("too_long", "is too long (maximum is 4 characters)"),
          { attribute: "note", type: "too_long", description: "is too long (maximum is 500 characters)" },
          fields("fields_with_values_missing_labels", "contains values with missing labels"),
          { attribute: "avatar", type: "is invalid", description: "is invalid" },
        ]),
      ),
    ).toBe(
      JSON.stringify({
        error:
          "Validation failed: Fields is too long (maximum is 4 characters), Note is too long (maximum is 500 characters), Fields contains values with missing labels, Avatar is invalid",
        details: {
          fields: [
            { error: "ERR_TOO_LONG", description: "is too long (maximum is 4 characters)" },
            { error: "ERR_FIELDS_WITH_VALUES_MISSING_LABELS", description: "contains values with missing labels" },
          ],
          note: [{ error: "ERR_TOO_LONG", description: "is too long (maximum is 500 characters)" }],
          avatar: [{ error: "ERR_IS INVALID", description: "is invalid" }],
        },
      }),
    );
  });
});
