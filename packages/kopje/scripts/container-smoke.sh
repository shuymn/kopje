#!/usr/bin/env bash
# Runs the media processor's image locally with no network (`docker run --network none`, a read-only root and a tmpfs
# work directory) and drives its operations over HTTP from a curl container that shares only its network namespace:
# /healthz, then for each input normalize (with the still it keeps) and still, and two refusals (an input over the cap,
# and text). Each output is checked with the pinned ffprobe: its type, its duration within 0.5 s of the input's (for
# normalize), and none of the seeded metadata (KOPJEMARK, the fixture's location) in its bytes. Prints a Markdown
# table with the server's stage times and the wall time this script saw, and exits 1 when a check failed.
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

mkdir -p "$work/in" "$work/out"
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
  code="$(status "$h")"
  kind="$(header Kopje-Kind "$h")"
  checks=-
  ext=
  if [ "$code" = 200 ]; then
    ext=mp4
    [ "$kind" = audio ] && ext=mp3
    mv "$work/out/$base.normalized" "$work/out/$base.$ext"
    got="$(ffprobe -show_entries format=duration -of csv=p=0 "/o/$base.$ext")"
    codecs="$(ffprobe -show_entries stream=codec_name -of csv=p=0 "/o/$base.$ext" | tr '\n' ' ')"
    duration_ok="$(awk -v a="$got" -v b="$expected" 'BEGIN{d=a-b; print (a>0 && d*d<0.25) ? "true" : "false"}')"
    clean_ok=false
    clean "$base.$ext" && clean_ok=true
    check "$duration_ok" "$base normalize: duration $got, input $expected"
    check "$clean_ok" "$base normalize: seeded metadata in the output"
    checks="${codecs}${got%.*}s metadata-free=$clean_ok"
    if [ "$kind" = video ]; then
      sh="$(req "$base.still.png" http://127.0.0.1:8080/normalize/still)"
      check "$([ "$(status "$sh")" = 200 ] && echo true)" "$base: GET /normalize/still answered $(status "$sh")"
      still_dims="$(ffprobe -show_entries stream=codec_name,width,height -of csv=p=0 "/o/$base.still.png")"
      checks="$checks; still $still_dims"
    fi
  else
    check false "$base normalize: HTTP $code $(header Kopje-Error "$h")"
  fi
  row "$base" "normalize ($kind)" "$code" "$wall" "$h" "$(size "$base.${ext:-none}")" "$checks"

  if [ "$kind" = video ]; then
    t0="$(now_ms)"
    h="$(req "$base.png" -X POST --data-binary "@/in/$base" -H 'Content-Type: application/octet-stream' \
      http://127.0.0.1:8080/still)"
    wall=$(($(now_ms) - t0))
    code="$(status "$h")"
    checks=-
    if [ "$code" = 200 ]; then
      dims="$(ffprobe -show_entries stream=codec_name,width,height -of csv=p=0 "/o/$base.png")"
      long="$(awk -F, '{print ($2>$3)?$2:$3}' <<<"$dims")"
      check "$([ "$long" -le 640 ] && echo true)" "$base still: $dims"
      clean_ok=false
      clean "$base.png" && clean_ok=true
      check "$clean_ok" "$base still: seeded metadata in the output"
      checks="$dims metadata-free=$clean_ok"
    else
      check false "$base still: HTTP $code $(header Kopje-Error "$h")"
    fi
    row "$base" still "$code" "$wall" "$h" "$(size "$base.png")" "$checks"
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
