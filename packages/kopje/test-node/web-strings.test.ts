import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { webStrings } from "../lint/web-strings.js";

// The kopje/web-strings rule (lint/web-strings.js): a page or component writes no words outside the catalogue.
RuleTester.describe = describe;
RuleTester.it = it;

const flagged = (code: string, ...messages: string[]) => ({
  code,
  errors: messages.map((message) => ({ message })),
  filename: "probe.tsx",
});
const passed = (code: string) => ({ code, filename: "probe.tsx" });

new RuleTester().run("web-strings", webStrings, {
  invalid: [
    flagged("export const A = () => <p>Hello</p>", 'text "Hello"'),
    flagged("export const A = () => <p>こんにちは</p>", 'text "こんにちは"'),
    flagged("export const A = () => <p>{'Hello'}</p>", 'child "Hello"'),
    flagged("export const A = (n: number) => <p>{`${n} posts`}</p>", 'child " posts"'),
    flagged("export const A = (a: boolean) => <p>{a ? 'Avatar' : 'Header'}</p>", 'child "Avatar"', 'child "Header"'),
    flagged("export const A = (a: boolean) => <p>{a && 'Avatar'}</p>", 'child "Avatar"'),
    flagged('export const A = () => <a href="/" aria-label="Home">{1}</a>', 'aria-label "Home"'),
    flagged("export const A = () => <img src=\"/a.png\" alt={'An image'} />", 'alt "An image"'),
    flagged('export const A = () => <input placeholder="Search" />', 'placeholder "Search"'),
    flagged('export const A = () => <span title="Note" />', 'title "Note"'),
    flagged('export const A = () => <option label="First" />', 'label "First"'),
  ],
  valid: [
    passed("export const A = (m: { a: string }) => <p>{m.a}</p>"),
    passed("export const A = (t: string) => <p>#{t}{' · '}@</p>"),
    passed('export const A = () => <img src="/a.png" alt="" />'),
    passed('export const A = () => <a class="btn quiet" href="/about">{1}</a>'),
    passed("export const A = (k: string) => <p>{k === 'avatar' ? 1 : 2}</p>"),
  ],
});
