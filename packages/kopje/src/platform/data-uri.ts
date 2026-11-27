// A base64 data URI as Mastodon reads one for a profile image: Paperclip's DataUriAdapter (kt-paperclip 8.0.0
// lib/paperclip/io_adapters/data_uri_adapter.rb:11,21, registered by Mastodon v4.7.5 config/initializers/paperclip.rb:3)
// matches `/\Adata:([-\w]+\/[-\w\+\.]+)?;base64,(.*)/m` and decodes the rest with Base64.decode64, which is Ruby's
// `unpack1("m")`. The declared media type is never read: the bytes' signature decides (MEDIA-4). The value is up to
// API_BODY_LIMIT bytes of client text, so the prefix is scanned once from its start and the payload decoded in one pass,
// both linear in it, with no pattern that backtracks over the payload (RES-2).

// Ruby's `\w` without the u flag: [A-Za-z0-9_].
function word(unit: number): boolean {
  return (
    (unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a) || unit === 0x5f
  );
}

const MARKER = ";base64,";

// The index of the payload of `value` when it is a base64 data URI by Paperclip's pattern (case-sensitive), else
// undefined. The optional type is `[-\w]+` then `/` then `[-\w+.]+`, and `;base64,` must follow it directly; neither
// run can hold `;`, so the pattern has one way to match and a single scan decides it.
export function base64DataUriPayload(value: string): number | undefined {
  if (!value.startsWith("data:")) {
    return undefined;
  }
  let at = 5;
  if (value.charCodeAt(at) !== 0x3b) {
    const type = at;
    while (at < value.length && (word(value.charCodeAt(at)) || value.charCodeAt(at) === 0x2d)) {
      at++;
    }
    if (at === type || value.charCodeAt(at) !== 0x2f) {
      return undefined;
    }
    const subtype = ++at;
    while (at < value.length && subtypeUnit(value.charCodeAt(at))) {
      at++;
    }
    if (at === subtype) {
      return undefined;
    }
  }
  return value.startsWith(MARKER, at) ? at + MARKER.length : undefined;
}

function subtypeUnit(unit: number): boolean {
  return word(unit) || unit === 0x2d || unit === 0x2b || unit === 0x2e;
}

// The sextet of each base64 alphabet code unit, -1 for every other ASCII one; a code unit past ASCII is not looked up.
const SEXTETS = (() => {
  const table = new Int8Array(128).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
})();

const PAD = 0x3d;

// The bytes of `value` from `start`, as Ruby's `unpack1("m")` (pack.c, the non-strict 'm' branch) reads the payload's
// UTF-8 bytes: a code unit outside the alphabet is skipped (every non-ASCII character's UTF-8 bytes are), `=` is
// skipped while a group's first or second sextet is sought and ends decoding while its third or fourth is, a full group
// gives three bytes, and at the end two sextets give one byte, three give two and a lone one is dropped.
export function decodeRubyBase64(value: string, start: number): Uint8Array {
  const out = new Uint8Array(Math.floor(((value.length - start) * 3) / 4));
  let written = 0;
  let group = 0;
  let sextets = 0;
  for (let at = start; at < value.length; at++) {
    const unit = value.charCodeAt(at);
    const sextet = unit < 128 ? SEXTETS[unit]! : -1;
    if (sextet < 0) {
      if (unit === PAD && sextets >= 2) {
        break;
      }
      continue;
    }
    group = (group << 6) | sextet;
    if (++sextets === 4) {
      out[written++] = group >> 16;
      out[written++] = (group >> 8) & 0xff;
      out[written++] = group & 0xff;
      group = 0;
      sextets = 0;
    }
  }
  if (sextets === 2) {
    out[written++] = group >> 4;
  } else if (sextets === 3) {
    out[written++] = group >> 10;
    out[written++] = (group >> 2) & 0xff;
  }
  return out.subarray(0, written);
}
