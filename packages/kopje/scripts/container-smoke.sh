#!/usr/bin/env bash
# Runs the media processor's image locally with no network (`docker run --network none`, a read-only root and a tmpfs
# work directory) and drives its operations over HTTP from a curl container that shares only its network namespace:
# /healthz, then for each input normalize (with the still it keeps) and still, and two refusals (an input over the cap,
# and text). Inputs made here always follow the given ones: a WAV tone; a MOV of PNG frames that carry EXIF and text
# chunks; a MOV of Display P3 PNG frames whose only colour tag is an ICC profile carrying a seeded marker; a MOV of
# grayscale PNG frames with a gray ICC profile; an M4A with a 4096x4096 cover; a MOV of H.264 then PNG; and raw AAC.
# One more input, an MP4 whose headers declare 320x240 but whose frames after the first are 4096x2160, is checked
# apart: the decoder must refuse those frames (normalize keeps at most the first frame, and a still is the first
# frame's 320x240), or the operation must fail.
# Each input's kind (video or audio) is the fixture table's, never the server's Kopje-Kind: a given input's is its
# `video:` or `audio:` prefix, else its extension's. Each operation is checked on its own: HTTP 200, Kopje-Kind equal
# to the expected kind, the exact Content-Type (video/mp4 or audio/mpeg, image/png for a still), a Content-Length
# equal to the bytes received, the codec the pinned ffprobe reads (h264, mp3, png), a full decode by the pinned ffmpeg
# with -xerror, and none of the seeded metadata (KOPJEMARK, the fixture's location) in its bytes; for a video both
# stills always run. A still has only image chunks (no eXIf, tEXt, iTXt, zTXt or tIME) and no marker in its ICC
# profile, and the P3 input's stills render (the pinned ffmpeg: iccdetect, then zscale to sRGB; an untagged PNG as
# sRGB) within 2 of the source frame's rendered sample in each channel, and its normalized video's first frame decoded
# as BT.709 within 4. Normalize has a duration within 0.5 s of the input's. Prints a Markdown table with the server's
# stage times and the wall time this script saw, and exits 1 when a check failed. Needs docker, node and python3.
#
#   bash packages/kopje/scripts/container-smoke.sh [--build] <image tag> [<input>...]
#     --build  builds packages/kopje/container into the tag first
#     inputs   [video:|audio:]<path>; default: packages/kopje/container/probe.mp4
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
# p3.mov: three seconds of one 64x48 frame of (210,70,40) in Display P3, its PNG tagged only by an ICC profile (the
# pinned ffmpeg's for P3, with KOPJEMARK_ICC appended inside the profile), copied into MOV unchanged.
p3_frame='color=c=0xD24628:s=64x48:d=1,format=rgb24'
p3_frame+=',setparams=color_primaries=smpte432:color_trc=iec61966-2-1,iccgen=force=1'
docker run --rm --network none -v "$work/fixture:/f" --entrypoint /ffmpeg "$ffmpeg_image" -v error -f lavfi \
  -i "$p3_frame" -frames:v 1 -c:v png /f/p3-generated.png
python3 -I - "$work/fixture/p3-generated.png" "$work/fixture/p3.png" <<'PY'
import struct, sys, zlib
def chunk(t, data):
    return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data))
b, p, out = open(sys.argv[1], "rb").read(), 8, b""
while p < len(b):
    n, t = struct.unpack(">I4s", b[p : p + 8])
    data = b[p + 8 : p + 8 + n]
    if t == b"iCCP":
        k = data.index(b"\0")
        icc = zlib.decompress(data[k + 2 :]) + b"KOPJEMARK_ICC" * 4
        out += chunk(t, b"P3\0\0" + zlib.compress(struct.pack(">I", len(icc)) + icc[4:]))
    elif t not in (b"cHRM", b"gAMA", b"sRGB", b"cICP", b"pHYs"):
        out += b[p : p + 12 + n]
    p += 12 + n
open(sys.argv[2], "wb").write(b[:8] + out)
PY
docker run --rm --network none -v "$work/fixture:/f" --entrypoint /ffmpeg "$ffmpeg_image" -v error -framerate 1 \
  -loop 1 -t 3 -i /f/p3.png -c:v copy -f mov /f/p3.mov
# gray.mov: three seconds of one 64x48 grayscale PNG frame with a gray-gamma-2.2 ICC profile, which iccdetect cannot
# use (it needs an RGB transform): normalize and both stills must still answer, the profile dropped.
python3 -I - "$work/fixture/gray.png" <<'PY'
import struct, sys, zlib
def chunk(t, data):
    return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data))
def s15(x):
    return struct.pack(">i", round(x * 65536))
d50 = s15(0.9642) + s15(1.0) + s15(0.8249)
tags = [
    (b"desc", b"desc" + bytes(4) + struct.pack(">I", 5) + b"Gray\0" + bytes(81)),
    (b"wtpt", b"XYZ " + bytes(4) + d50),
    (b"kTRC", b"curv" + bytes(4) + struct.pack(">IH", 1, round(2.2 * 256)) + bytes(2)),
]
table, data, offset = struct.pack(">I", len(tags)), b"", 128 + 4 + 12 * len(tags)
for sig, body in tags:
    data += bytes(-(offset + len(data)) % 4)
    table += sig + struct.pack(">II", offset + len(data), len(body))
    data += body
size = 128 + len(table) + len(data)
header = struct.pack(">I", size) + b"lcms" + bytes([2, 0x10, 0, 0]) + b"mntrGRAYXYZ " + bytes(12) + b"acspAPPL"
header += bytes(24) + d50 + bytes(48)
icc = header + table + data
rows = b"".join(b"\0" + bytes(x * 4 for x in range(64)) for _ in range(48))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 48, 8, 0, 0, 0, 0))
png += chunk(b"iCCP", b"Gray\0\0" + zlib.compress(icc)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
PY
docker run --rm --network none -v "$work/fixture:/f" --entrypoint /ffmpeg "$ffmpeg_image" -v error -framerate 1 \
  -loop 1 -t 3 -i /f/gray.png -c:v copy -f mov /f/gray.mov
# cover.m4a: AAC with a 4096x4096 PNG cover (over the pixel limit; it is not the video and is never decoded);
# twostream.mov: H.264 then a PNG stream; tone.aac: raw ADTS AAC, whose headers declare no duration.
ffm() { docker run --rm --network none -v "$work/fixture:/f" -w /f --entrypoint /ffmpeg "$ffmpeg_image" -v error "$@"; }
ffm -f lavfi -i color=c=red:s=4096x4096:d=1 -frames:v 1 -c:v png cover.png
ffm -f lavfi -i sine=d=3 -i cover.png -map 0 -map 1 -c:a aac -c:v copy -disposition:v attached_pic cover.m4a
ffm -f lavfi -i testsrc2=s=320x240:d=2 -f lavfi -i color=c=blue:s=64x48:d=2:r=1 -map 0 -map 1 -c:v:0 libx264 \
  -c:v:1 png twostream.mov
ffm -f lavfi -i sine=d=3 -c:a aac tone.aac
# lie.mp4: one 320x240 H.264 frame, then a second of 4096x2160 ones in the same stream; the MP4's headers carry only
# the first parameters, so they declare 320x240.
ffm -f lavfi -i testsrc2=s=320x240:d=0.04:r=25 -c:v libx264 -f h264 small.h264
ffm -f lavfi -i testsrc2=s=4096x2160:d=1:r=25 -c:v libx264 -preset ultrafast -f h264 big.h264
cat "$work/fixture/small.h264" "$work/fixture/big.h264" >"$work/fixture/lie.h264"
ffm -r 25 -f h264 -i lie.h264 -c copy lie.mp4
inputs+=("audio:$work/fixture/tone.wav" "video:$work/fixture/exif.mov" "video:$work/fixture/p3.mov"
  "video:$work/fixture/gray.mov" "audio:$work/fixture/cover.m4a" "video:$work/fixture/twostream.mov"
  "audio:$work/fixture/tone.aac")
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
# The chunk types of a PNG, space-separated (an iCCP whose profile holds KOPJEMARK as "iCCP-marked"), or "malformed".
png_chunks() {
  python3 -I - "$1" <<'PY'
import struct, sys, zlib
b = open(sys.argv[1], "rb").read()
if b[:8] != b"\x89PNG\r\n\x1a\n":
    sys.exit(print("malformed"))
p, types = 8, []
while p + 12 <= len(b):
    n, t = struct.unpack(">I4s", b[p : p + 8])
    name = t.decode("latin-1")
    if name == "iCCP":
        data = b[p + 8 : p + 8 + n]
        if b"KOPJEMARK" in zlib.decompress(data[data.index(b"\0") + 2 :]):
            name = "iCCP-marked"
    types.append(name)
    p += 12 + n
print(" ".join(types) if p == len(b) and types[-1:] == ["IEND"] else "malformed")
PY
}
# The top-left pixel of the first frame of <dir>/<file> through the filter <vf>, as "r g b".
pixel() { # <dir> <file> <vf>
  docker run --rm --network none -v "$1:/p:ro" --entrypoint /ffmpeg "$ffmpeg_image" -v quiet -i "/p/$2" \
    -vf "$3,crop=1:1:0:0" -frames:v 1 -f rawvideo - | od -An -tu1
}
# The top-left pixel of an image as sRGB "r g b": through its colour tags (iccdetect, zscale), or as stored when it has
# none.
srgb_pixel() { # <dir> <file>
  local v
  v="$(pixel "$1" "$2" 'iccdetect,zscale=p=bt709:t=iec61966-2-1:m=gbr,format=rgb24' || true)"
  [ -n "$v" ] || v="$(pixel "$1" "$2" format=rgb24)"
  echo $v
}
# The top-left pixel of a normalized video's first frame, its BT.709 YUV as RGB, which a player shows as sRGB.
video_pixel() { # <dir> <file>
  local v
  v="$(pixel "$1" "$2" 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24')"
  echo $v
}
# Whether two "r g b" samples are within <tolerance> (default 2) in each channel.
near() { # <a> <b> [<tolerance>]
  awk -v a="$1" -v b="$2" -v t="${3:-2}" 'BEGIN{
    n = split(a, x, " "); split(b, y, " "); ok = (n == 3)
    for (i = 1; i <= 3; i++) { d = x[i] - y[i]; if (d * d > t * t) ok = 0 }
    print ok ? "true" : "false"
  }'
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
    check "$([ "$chunks" != malformed ] && ! grep -qE 'eXIf|tEXt|iTXt|zTXt|tIME|marked' <<<"$chunks" && echo true)" \
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

for entry in "${inputs[@]}"; do
  case "$entry" in
    video:* | audio:*) want="${entry%%:*}" input="${entry#*:}" ;;
    *.m4a | *.mp3 | *.flac | *.ogg | *.opus | *.wav | *.aac) want=audio input="$entry" ;;
    *) want=video input="$entry" ;;
  esac
  base="$(basename "$input")"
  cp "$input" "$work/in/$base"
  expected="$(docker run --rm --network none -v "$work/in:/i:ro" --entrypoint /ffprobe "$ffmpeg_image" -v error \
    -show_entries format=duration -of csv=p=0 "/i/$base")"

  t0="$(now_ms)"
  h="$(req "$base.normalized" -X POST --data-binary "@/in/$base" -H 'Content-Type: application/octet-stream' \
    "http://127.0.0.1:8080/normalize?probe_ms=10000&encode_ms=$ENCODE_MS")"
  wall=$(($(now_ms) - t0))
  kind="$(header Kopje-Kind "$h")"
  type=video/mp4 codec=h264
  [ "$want" = audio ] && type=audio/mpeg codec=mp3
  verify "$base normalize" "$base.normalized" "$h" "$type" "$codec"
  if [ "$(status "$h")" = 200 ]; then
    check "$([ "$kind" = "$want" ] && echo true)" "$base normalize: Kopje-Kind $kind, want $want"
    got="$(ffprobe -show_entries format=duration -of csv=p=0 "/o/$base.normalized")"
    check "$(awk -v a="$got" -v b="$expected" 'BEGIN{d=a-b; print (a>0 && d*d<0.25) ? "true" : "false"}')" \
      "$base normalize: duration $got, input $expected"
    checks="$checks ${got%.*}s"
  fi
  row "$base" "normalize ($kind)" "$(status "$h")" "$wall" "$h" "$(size "$base.normalized")" "$checks"

  if [ "$want" = video ]; then
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
    if [ "$base" = p3.mov ]; then
      source_px="$(srgb_pixel "$work/fixture" p3.png)"
      # The normalized video, decoded: its primaries were converted to BT.709 before it was labelled so (within 4:
      # limited range and 4:2:0 chroma).
      if [ -f "$work/out/$base.normalized" ]; then
        got_px="$(video_pixel "$work/out" "$base.normalized")"
        check "$(near "$got_px" "$source_px" 4)" "$base normalize: sRGB $got_px, source $source_px"
        echo "| $base | colour of normalize | | | | | | | | | sRGB $got_px, source $source_px |"
      fi
      for still in "$base.still.png" "$base.png"; do
        [ -f "$work/out/$still" ] || continue
        got_px="$(srgb_pixel "$work/out" "$still")"
        check "$(near "$got_px" "$source_px")" "$still: sRGB $got_px, source $source_px"
        echo "| $base | colour of $still | | | | | | | | | sRGB $got_px, source $source_px |"
      done
    fi
  fi
  rm -f "$work/in/$base" "$work/out/$base".*
done

# lie.mp4: no frame over the pixel limit is decoded, whatever its headers declared.
cp "$work/fixture/lie.mp4" "$work/in/lie.mp4"
h="$(req lie.normalized -X POST --data-binary @/in/lie.mp4 -H 'Content-Type: application/octet-stream' \
  "http://127.0.0.1:8080/normalize?probe_ms=10000&encode_ms=$ENCODE_MS")"
got="$(status "$h") $(header Kopje-Error "$h")"
if [ "$(status "$h")" = 200 ]; then
  got="$(status "$h"), $(ffprobe -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 \
    /o/lie.normalized) frames"
  check "$([ "$got" = "200, 1 frames" ] && echo true)" "lie.mp4 normalize: $got, want at most the first frame"
  h="$(req lie.still.png http://127.0.0.1:8080/normalize/still)"
  if [ "$(status "$h")" = 200 ]; then
    dims="$(ffprobe -show_entries stream=width,height -of csv=p=0 /o/lie.still.png)"
    check "$([ "$dims" = 320,240 ] && echo true)" "lie.mp4 normalize/still: $dims, want the first frame's 320,240"
    got="$got; still $dims"
  fi
fi
echo "| lie.mp4 | normalize | $got | | | | | | | | |"
h="$(req lie.png -X POST --data-binary @/in/lie.mp4 -H 'Content-Type: application/octet-stream' \
  http://127.0.0.1:8080/still)"
got="$(status "$h") $(header Kopje-Error "$h")"
if [ "$(status "$h")" = 200 ]; then
  got="$(status "$h"), $(ffprobe -show_entries stream=width,height -of csv=p=0 /o/lie.png)"
  check "$([ "$got" = "200, 320,240" ] && echo true)" "lie.mp4 still: $got, want the first frame's 320,240"
fi
echo "| lie.mp4 | still | $got | | | | | | | | |"

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
