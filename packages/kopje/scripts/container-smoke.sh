#!/usr/bin/env bash
# Runs the media processor's image locally with no network (`docker run --network none`, a read-only root and a tmpfs
# work directory) and drives its operations over HTTP from a curl container that shares only its network namespace:
# /healthz, then for each input normalize (with the still it keeps) and still, and two refusals (an input over the cap,
# and text). Two inputs made here always follow the given ones: a WAV tone, and a MOV of PNG frames that carry EXIF
# and text chunks. Each operation is checked on its own: HTTP 200, the exact Content-Type (video/mp4 or audio/mpeg by
# Kopje-Kind, image/png for a still), a Content-Length equal to the bytes received, the codec the pinned ffprobe reads
# (h264, mp3, png), a full decode by the pinned ffmpeg with -xerror, and none of the seeded metadata (KOPJEMARK, the
# fixture's location) in its bytes; a still has only image chunks (no eXIf, tEXt, iTXt, zTXt or tIME), and normalize
# a duration within 0.5 s of the input's. Prints a Markdown table with the server's stage times and the wall time this
# script saw, and exits 1 when a check failed. Needs docker, node and python3.
#
#   bash packages/kopje/scripts/container-smoke.sh [--build] <image tag> [<input>...]
#     --build  builds packages/kopje/container into the tag first
#     inputs   default: packages/kopje/container/probe.mp4
#   CPUS (default 2, standard-3's vCPUs) and MEMORY (default 8g) size the container; ENCODE_MS (default 600000) is
#   the encode stage time normalize is given.
set -euo pipefail

pkg="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" = --build ]; then
  shift
  docker build --quiet -t "${1:?image tag}" "$pkg/container" >/dev/null
fi
image="${1:?usage: container-smoke.sh [--build] <image tag> [<input>...]}"
shift
inputs=("$@")
[ ${#inputs[@]} -gt 0 ] || inputs=("$pkg/container/probe.mp4")

CURL_IMAGE='curlimages/curl:8.17.0@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40'
ffmpeg_image="$(sed -n 's/^FROM \(mwader\/static-ffmpeg[^ ]*\) AS ffmpeg$/\1/p' "$pkg/container/Dockerfile")"
CPUS="${CPUS:-2}"
MEMORY="${MEMORY:-8g}"
ENCODE_MS="${ENCODE_MS:-600000}"
work="$(mktemp -d "${TMPDIR:-/tmp}/kopje-container-smoke.XXXXXX")"
name="kopje-media-smoke-$$"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker run -d --name "$name" --network none --cpus "$CPUS" --memory "$MEMORY" --read-only \
  --tmpfs /tmp:rw,size=4g "$image" >/dev/null

mkdir -p "$work/in" "$work/out" "$work/fixture"
# tone.wav: three seconds of a sine, the audio input, tagged with a seeded title.
docker run --rm --network none -v "$work/fixture:/f" --entrypoint /ffmpeg "$ffmpeg_image" -v error \
  -f lavfi -i sine=frequency=440:duration=3 -metadata title=KOPJEMARK_WAV_TITLE /f/tone.wav
# exif.mov: three seconds of one 64x48 PNG frame carrying an eXIf chunk (a TIFF whose Make is KOPJEMARK_EXIF_MAKE) and
# a tEXt chunk, copied into MOV unchanged, so the frames the still is made from carry both.
python3 -I - "$work/fixture/frame.png" <<'PY'
import struct, sys, zlib
def chunk(t, data):
    return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data))
make = b"KOPJEMARK_EXIF_MAKE\0"
tiff = b"MM\0*" + struct.pack(">I", 8) + struct.pack(">H", 1) + struct.pack(">HHII", 0x010F, 2, len(make), 26)
tiff += struct.pack(">I", 0) + make
rows = b"".join(b"\0" + b"".join(bytes((x * 4, y * 5, 128)) for x in range(64)) for y in range(48))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 48, 8, 2, 0, 0, 0))
png += chunk(b"eXIf", tiff) + chunk(b"tEXt", b"Comment\0KOPJEMARK_PNG_TEXT") + chunk(b"IDAT", zlib.compress(rows))
open(sys.argv[1], "wb").write(png + chunk(b"IEND", b""))
PY
docker run --rm --network none -v "$work/fixture:/f" --entrypoint /ffmpeg "$ffmpeg_image" -v error -framerate 1 \
  -loop 1 -t 3 -i /f/frame.png -c:v copy -f mov /f/exif.mov
inputs+=("$work/fixture/tone.wav" "$work/fixture/exif.mov")
# curl: -o <out> -D - prints the headers; the curl image runs as a user that writes to /out.
chmod 777 "$work/out"
req() { # <output file> <curl args...>
  local out=$1
  shift
  docker run --rm --network "container:$name" -v "$work/in:/in:ro" -v "$work/out:/out" "$CURL_IMAGE" \
    -sS -H 'Expect:' -o "/out/$out" -D - "$@" | tr -d '\r'
}
header() { sed -n "s/^$1: //Ip" <<<"$2" | head -1; }
status() { sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p' <<<"$1"; }
ffprobe() { docker run --rm --network none -v "$work/out:/o:ro" --entrypoint /ffprobe "$ffmpeg_image" -v error "$@"; }
decodes() { docker run --rm --network none -v "$work/out:/o:ro" --entrypoint /ffmpeg "$ffmpeg_image" -v error -xerror \
  -i "/o/$1" -f null - >/dev/null 2>&1; }
# The chunk types of a PNG, space-separated, or "malformed".
png_chunks() {
  python3 -I - "$1" <<'PY'
import struct, sys
b = open(sys.argv[1], "rb").read()
if b[:8] != b"\x89PNG\r\n\x1a\n":
    sys.exit(print("malformed"))
p, types = 8, []
while p + 12 <= len(b):
    n, t = struct.unpack(">I4s", b[p : p + 8])
    types.append(t.decode("latin-1"))
    p += 12 + n
print(" ".join(types) if p == len(b) and types[-1:] == ["IEND"] else "malformed")
PY
}
now_ms() { node -e 'console.log(Date.now())'; }

for _ in $(seq 1 100); do
  if [ "$(status "$(req healthz http://127.0.0.1:8080/healthz 2>/dev/null || true)")" = 200 ]; then
    break
  fi
  sleep 0.1
done
[ "$(status "$(req healthz http://127.0.0.1:8080/healthz)")" = 200 ] || { echo "no /healthz" >&2; exit 1; }

failed=0
check() { # <ok?> <message>
  if [ "$1" != true ]; then
    echo "FAIL: $2" >&2
    failed=1
  fi
}
clean() { ! grep -aqE 'KOPJEMARK|\+35\.6586' "$work/out/$1"; }
size() { if [ -f "$work/out/$1" ]; then echo "$(wc -c <"$work/out/$1" | tr -d ' ') B"; else echo -; fi; }
# verify <label> <output file> <headers> <content type> <codec>: the checks every operation's answer passes. Sets
# checks to what it read, for the table (it runs in this shell, so that check can set failed).
verify() {
  local label=$1 file=$2 h=$3 type=$4 codec=$5 code length bytes stream got chunks=
  code="$(status "$h")"
  check "$([ "$code" = 200 ] && echo true)" "$label: HTTP $code $(header Kopje-Error "$h")"
  checks=-
  [ "$code" = 200 ] || return 0
  check "$([ "$(header Content-Type "$h")" = "$type" ] && echo true)" \
    "$label: Content-Type $(header Content-Type "$h"), want $type"
  length="$(header Content-Length "$h")"
  bytes="$(wc -c <"$work/out/$file" | tr -d ' ')"
  check "$([ -n "$length" ] && [ "$length" = "$bytes" ] && echo true)" "$label: Content-Length $length, $bytes bytes"
  stream=v:0
  [ "$codec" = mp3 ] && stream=a:0
  got="$(ffprobe -select_streams "$stream" -show_entries stream=codec_name -of csv=p=0 "/o/$file")"
  check "$([ "$got" = "$codec" ] && echo true)" "$label: codec $got, want $codec"
  check "$(decodes "$file" && echo true)" "$label: does not decode"
  check "$(clean "$file" && echo true)" "$label: seeded metadata in the output"
  if [ "$codec" = png ]; then
    chunks="$(png_chunks "$work/out/$file")"
    check "$([ "$chunks" != malformed ] && ! grep -qE 'eXIf|tEXt|iTXt|zTXt|tIME' <<<"$chunks" && echo true)" \
      "$label: chunks $chunks"
    chunks="; chunks $chunks"
  fi
  checks="$got"
  [ "$stream" = a:0 ] ||
    checks="$checks $(ffprobe -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "/o/$file")"
  checks="$checks$chunks"
}

echo "| input | operation | status | wall s | input s | probe s | encode s | encode CPU s | still s | output | checks |"
echo "|---|---|---|---|---|---|---|---|---|---|---|"
seconds() { # <stage> <headers>: the server's Kopje-<stage>-Ms in seconds
  local v
  v="$(header "Kopje-$1-Ms" "$2")"
  [ -z "$v" ] || awk -v v="$v" 'BEGIN{printf "%.1f", v/1000}'
}
row() { # <input> <operation> <status> <wall ms> <headers> <output> <checks>
  printf '| %s | %s | %s | %.1f | %s | %s | %s | %s | %s | %s | %s |\n' "$1" "$2" "$3" "$(awk -v v="$4" 'BEGIN{print v/1000}')" \
    "$(seconds Input "$5")" "$(seconds Probe "$5")" "$(seconds Encode "$5")" "$(seconds Encode-Cpu "$5")" \
    "$(seconds Still "$5")" "$6" "$7"
}

for input in "${inputs[@]}"; do
  base="$(basename "$input")"
  cp "$input" "$work/in/$base"
  expected="$(docker run --rm --network none -v "$work/in:/i:ro" --entrypoint /ffprobe "$ffmpeg_image" -v error \
    -show_entries format=duration -of csv=p=0 "/i/$base")"

  t0="$(now_ms)"
  h="$(req "$base.normalized" -X POST --data-binary "@/in/$base" -H 'Content-Type: application/octet-stream' \
    "http://127.0.0.1:8080/normalize?probe_ms=10000&encode_ms=$ENCODE_MS")"
  wall=$(($(now_ms) - t0))
  kind="$(header Kopje-Kind "$h")"
  case "$kind" in
    video) type=video/mp4 codec=h264 ;;
    audio) type=audio/mpeg codec=mp3 ;;
    *) type="a Kopje-Kind" codec=- ;;
  esac
  verify "$base normalize" "$base.normalized" "$h" "$type" "$codec"
  if [ "$(status "$h")" = 200 ]; then
    got="$(ffprobe -show_entries format=duration -of csv=p=0 "/o/$base.normalized")"
    check "$(awk -v a="$got" -v b="$expected" 'BEGIN{d=a-b; print (a>0 && d*d<0.25) ? "true" : "false"}')" \
      "$base normalize: duration $got, input $expected"
    checks="$checks ${got%.*}s"
  fi
  row "$base" "normalize ($kind)" "$(status "$h")" "$wall" "$h" "$(size "$base.normalized")" "$checks"

  if [ "$kind" = video ]; then
    h="$(req "$base.still.png" http://127.0.0.1:8080/normalize/still)"
    verify "$base normalize/still" "$base.still.png" "$h" image/png png
    row "$base" "normalize/still" "$(status "$h")" 0 "$h" "$(size "$base.still.png")" "$checks"

    t0="$(now_ms)"
    h="$(req "$base.png" -X POST --data-binary "@/in/$base" -H 'Content-Type: application/octet-stream' \
      http://127.0.0.1:8080/still)"
    wall=$(($(now_ms) - t0))
    verify "$base still" "$base.png" "$h" image/png png
    if [ "$(status "$h")" = 200 ]; then
      dims="$(ffprobe -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "/o/$base.png")"
      check "$(awk -F, '{print ($1 <= 640 && $2 <= 640) ? "true" : "false"}' <<<"$dims")" "$base still: $dims"
    fi
    row "$base" still "$(status "$h")" "$wall" "$h" "$(size "$base.png")" "$checks"
  fi
  rm -f "$work/in/$base" "$work/out/$base".*
done

# Refusals: one byte over AV_UPLOAD_LIMIT (94,371,840 bytes) is 413; text is 422 unreadable.
head -c 94371841 /dev/zero >"$work/in/over-cap.bin"
printf 'not media' >"$work/in/text.txt"
for case in "over-cap.bin 413 too_large" "text.txt 422 unreadable"; do
  read -r file want code_want <<<"$case"
  h="$(req refusal -X POST --data-binary "@/in/$file" "http://127.0.0.1:8080/normalize?probe_ms=10000&encode_ms=60000")"
  got="$(status "$h") $(header Kopje-Error "$h")"
  check "$([ "$got" = "$want $code_want" ] && echo true)" "$file: $got, want $want $code_want"
  echo "| $file | normalize | $(status "$h") | | | | | | | | $(header Kopje-Error "$h") |"
done
exit "$failed"
