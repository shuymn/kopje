// A base64 data URI as Mastodon reads one for a profile image: Paperclip's DataUriAdapter (kt-paperclip 8.0.0
// lib/paperclip/io_adapters/data_uri_adapter.rb:11,21, registered by Mastodon v4.7.5 config/initializers/paperclip.rb:3)
// matches `/\Adata:([-\w]+\/[-\w\+\.]+)?;base64,(.*)/m` and decodes the rest with Base64.decode64, which is Ruby's
// `unpack1("m")`. The declared media type is never read: the bytes' signature decides (MEDIA-4). The value is up to
// API_BODY_LIMIT bytes of client text, so the prefix is scanned once from its start and the payload decoded in one pass,
// both linear in it, with no pattern that backtracks over the payload (RES-2).

// A code unit of the media type's runs: `[-\w]`, and in the subtype also `+` and `.`, with Ruby's `\w` without the u
// flag ([A-Za-z0-9_]). charCodeAt past the end is NaN, which is none.
function mediaTypeUnit(unit: number, subtype: boolean): boolean {
  return (
    (unit >= 0x30 && unit <= 0x39) ||
    (unit >= 0x41 && unit <= 0x5a) ||
    (unit >= 0x61 && unit <= 0x7a) ||
    unit === 0x5f ||
    unit === 0x2d ||
    (subtype && (unit === 0x2b || unit === 0x2e))
  );
}

// The end of the run of media type code units from `at`.
function runEnd(value: string, at: number, subtype: boolean): number {
  while (mediaTypeUnit(value.charCodeAt(at), subtype)) {
    at++;
  }
  return at;
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
    const slash = runEnd(value, at, false);
    if (slash === at || value.charCodeAt(slash) !== 0x2f) {
      return undefined;
    }
    at = runEnd(value, slash + 1, true);
    if (at === slash + 1) {
      return undefined;
    }
  }
  return value.startsWith(MARKER, at) ? at + MARKER.length : undefined;
}

// The sextet of each base64 alphabet code unit, -1 for every other ASCII one; a code unit past ASCII reads undefined.
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
// skipped while a group's first or second sextet is sought and ends decoding while its third or fourth is, and each
// byte is written once its eight bits are read, so a lone final sextet is dropped. The bits pending after a group's
// first, second and third sextets are 6, 4 and 2.
export function decodeRubyBase64(value: string, start: number): Uint8Array {
  const out = new Uint8Array(Math.floor(((value.length - start) * 3) / 4));
  let written = 0;
  let bits = 0;
  let pending = 0;
  for (let at = start; at < value.length; at++) {
    const unit = value.charCodeAt(at);
    const sextet = SEXTETS[unit] ?? -1;
    if (sextet < 0) {
      if (unit === PAD && (bits === 4 || bits === 2)) {
        break;
      }
      continue;
    }
    pending = (pending << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = pending >> bits;
      pending &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, written);
}
