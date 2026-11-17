// ActiveModel::Type::Boolean::FALSE_VALUES (activemodel 8.1.3.1, boolean.rb) as JSON or a parameter can give them:
// false, the integer 0 and these strings, each in its own case only ("False" is true). The Set compares by eql?, so a
// float 0.0 is not among them; JSON.parse reads a 0.0 as 0 (docs/mastodon-deviations.md).
const RAILS_FALSE: ReadonlySet<unknown> = new Set([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);

// A value as ActiveModel::Type::Boolean#cast assigns it to a boolean column: null for nil and "", false for a member of
// RAILS_FALSE, true for anything else (any other number or string, an array, empty or not, and an object).
export function railsBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return !RAILS_FALSE.has(value);
}
