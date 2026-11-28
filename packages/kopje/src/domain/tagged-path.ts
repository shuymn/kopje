// The path of an account's statuses with the hashtag `tag` (Mastodon's short_account_tag_url): /@acct/tagged/:tag,
// `acct` as the caller gives it and the hashtag percent-encoded. The profile's tagged tab, the Featured tab's links and
// the API's featured tag url (featured-tags.ts taggedUrl) are built by it.
export function taggedPath(acct: string, tag: string): string {
  return `/@${acct}/tagged/${encodeURIComponent(tag)}`;
}
