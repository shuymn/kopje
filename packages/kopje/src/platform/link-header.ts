// A Link header value (RFC 8288) read as Mastodon reads it (FetchResourceService#process_link_headers, v4.7.5), with
// the link_header gem's LinkHeader.parse (0.0.8, the version Mastodon locks): a StringScanner over the value, each link
// an href between < and > (spaces after < dropped, before > kept) and its parameters as [name, value] pairs in order,
// names and values as written (a quoted value with \" unescaped and no other escape); the scan stops at the first part
// it cannot read and keeps the links read before it. No name is case-folded and no rel is split: a caller compares
// pairs exactly, as the gem's find_link does. Bounded: a value past LINK_HEADER_CHARS UTF-16 code units (header values
// are byte strings, so as many bytes), or one that holds more than LINK_HEADER_LINKS links, is not read at all (null),
// so that no link past the cap can be passed over for a later match. Linear in the value: the gem's href pattern
// (/ *< *([^>]*) *> *;? */) backtracks cubically on a "<" followed by spaces and no ">", so its match is computed
// directly (hrefAt), with the same result.

export const LINK_HEADER_CHARS = 8 * 1024;
export const LINK_HEADER_LINKS = 64;

export type HeaderLink = { href: string; params: [string, string][] };

// The gem's other patterns, with Ruby's \s (ASCII space, \t, \n, \v, \f, \r) spelled out and Ruby's . (anything but
// \n); each matches one way, so a failed match costs at most the rest of the value.
const TOKEN = String.raw`[^()<>@,;:"\[\]?={}\t\n\v\f\r ]+`;
const ATTR = new RegExp(String.raw`(${TOKEN}) *= *(?:(${TOKEN})|"((?:[^"\\]|\\[^\n])*)") *`, "y");
const SEMI = /; */y;
const COMMA = /, */y;

// The gem's HREF at `at`: spaces, "<", spaces, the href up to the first ">" (its trailing spaces kept, as the greedy
// [^>]* takes them before " *" can), ">", spaces, an optional ";", spaces. Null where there is no "<" or no ">".
function hrefAt(value: string, at: number): { href: string; end: number } | null {
  let i = skipSpaces(value, at);
  if (value[i] !== "<") {
    return null;
  }
  i = skipSpaces(value, i + 1);
  const close = value.indexOf(">", i);
  if (close === -1) {
    return null;
  }
  let end = skipSpaces(value, close + 1);
  if (value[end] === ";") {
    end = skipSpaces(value, end + 1);
  }
  return { href: value.slice(i, close), end };
}

function skipSpaces(value: string, at: number): number {
  let i = at;
  while (value[i] === " ") {
    i++;
  }
  return i;
}

export function parseLinkHeader(value: string): HeaderLink[] | null {
  if (value.length > LINK_HEADER_CHARS) {
    return null;
  }
  let at = 0;
  const scan = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = at;
    const match = pattern.exec(value);
    if (match !== null) {
      at = pattern.lastIndex;
    }
    return match;
  };
  const links: HeaderLink[] = [];
  for (let href = hrefAt(value, at); href !== null; href = hrefAt(value, at)) {
    if (links.length === LINK_HEADER_LINKS) {
      return null;
    }
    at = href.end;
    const params: [string, string][] = [];
    for (let attr = scan(ATTR); attr !== null; attr = scan(ATTR)) {
      params.push([attr[1] ?? "", attr[2] ?? (attr[3] ?? "").replaceAll('\\"', '"')]);
      if (scan(SEMI) === null) {
        break;
      }
    }
    links.push({ href: href.href, params });
    if (scan(COMMA) === null) {
      break;
    }
  }
  return links;
}
