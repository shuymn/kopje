#!/usr/bin/env bash
# Runs the media processor's image locally with no network (`docker run --network none`, a read-only root and a tmpfs
# work directory) and drives its operations over HTTP from a curl container that shares only its network namespace:
# /healthz, then for each input normalize (with the still it keeps) and still, and two refusals (an input over the cap,
# and text). Inputs made here always follow the given ones: a WAV tone; a MOV of PNG frames that carry EXIF and text
# chunks; a MOV of Display P3 PNG frames whose only colour tag is an ICC profile carrying a seeded marker; a MOV of
# grayscale PNG frames with a gray ICC profile; an M4A with a 4096x4096 PNG cover and one with a 4096x4096 BMP cover;
# a MOV of H.264 then PNG; raw AAC; one input per rung of the output ladder (3 s of 1080p60, 121 s of 1080p60 and
# 600 s of 720p30, each with audio, scaled to 1920x1080 at 60 fps, 1280x720 at 30 fps and 852x480 at 30 fps); one at
# each rung's last duration (exactly 120 s of 320x180 at 60 fps and 300 s of 720p30, with audio, kept at 60 fps and at
# 1280x720), and 119.9 s of the first with its audio starting 500 ms late, which the verifier must hold to the same rung;
# and M4A, FLAC, Ogg, MP3 and Opus-only WebM audio.
# Lower-rung planning (#1202): the 3 s 1080p60 input again, given LOWER_ENCODE_MS of encode time, which its estimate
# fits at 720p30 and not on its own 1080p60 rung, is encoded at 1280x720 and 30 fps with each stream as long as the
# input's.
# The work deadline (#1828 PR4 plan, P8): rung1.mp4 delivered over about 4 s, to a second container held to
# SLOW_CPUS so that its encode really takes longer than the time left, answers from its arrival within the work
# deadline SLOW_WORK_MS (refused for the envelope, or cut at the deadline), where the old fixed stage times (an encode
# time counted after the input and the probe) answered past it.
# One more input, an MP4 whose headers declare 320x240 but whose frames after the first are 4096x2160, is checked
# apart: normalize refuses it (422 pixels: the decoder's diagnostic for the frames it dropped over the limit refuses it,
# whatever the output's length), and a still is the first frame's 320x240 or the operation fails. Its AV1 counterpart (a second of
# 320x240, then one of 4096x2160, which libdav1d refuses with its own diagnostic) is refused 422 pixels as well.
# Each input's kind (video or audio) is the fixture table's, never the server's Kopje-Kind: a given input's is its
# `video:` or `audio:` prefix, else its extension's. Each operation is checked on its own: HTTP 200, Kopje-Kind equal
# to the expected kind, the exact Content-Type (video/mp4 or audio/mpeg, image/png for a still), a Content-Length
# equal to the bytes received, the codec the pinned ffprobe reads (h264, mp3, png), a full decode by the pinned ffmpeg
# with -xerror, and none of the seeded metadata (KOPJEMARK, the fixture's location) in its bytes; for a video both
# stills always run. A still has only image chunks (no eXIf, tEXt, iTXt, zTXt or tIME) and no marker in its ICC
# profile, and the P3 input's stills render (the pinned ffmpeg: iccdetect, then zscale to sRGB; an untagged PNG as
# sRGB) within 2 of the source frame's rendered sample in each channel, and its normalized video's first frame decoded
# as BT.709 and rendered as sRGB within 4. Normalize has a duration within 0.5 s of the input's; each rung's output has the rung's geometry
# and frame rate, and the 600 s one an SSIM of at least MIN_SSIM_480P against its source scaled to 852x480; a 1200 s
# MP3 input gives an MP3 at exactly AUDIO_DURATION_LIMIT.
# Decoded content (design #1828 4.11): a 128x72 frame with a white marker in its top-left corner, stored rotated by
# 90, 180 and 270 degrees with the display matrix that turns it upright, decodes from normalize upright with the marker
# top left, and so do both its stills; HLG and PQ frames of a black and a reference-white patch, tagged by a colr box or
# only in the VUI, decode as BT.709 with the black at most 24 and the white within 150-235 in luma, its chroma within 12
# of neutral, and their stills with the black at most 24 and the white at least 150 in gray, its chroma within 12 of
# neutral; a frame of BT.709 primaries tagged with sRGB's transfer decodes, as BT.709 rendered as sRGB, within 4 of the
# source's sRGB sample, and so does that frame coded with BT.601's matrix and tagged with none; a VFR
# input, audio longer than video and an MP4 whose mvhd states 1 s or 10 s over 3 s of streams give an output whose
# streams decode as long as the input's, within 0.15 s.
# Every output and still of these runs is kept and then verified by Kopje's own verifier (src/platform/av-bytes.ts,
# test/av-fresh/), with each output held to its input's duration. Prints a Markdown table with the server's
# stage times and the wall time this script saw, and exits 1 when a check failed. Needs docker, node, pnpm (the
# workspace installed) and python3.
#
#   bash packages/kopje/scripts/container-smoke.sh [--build] <image tag> [<input>...]
#     --build  builds packages/kopje/container into the tag first
#     inputs   [video:|audio:]<path>; default: packages/kopje/container/probe.mp4
#   CPUS (default 2, standard-3's vCPUs) and MEMORY (default 8g) size the container; WORK_MS (default 660000) is
#   the work deadline normalize is given and STILL_MS (default 30000) its still's reserve; MIN_SSIM_480P (default 0.95; the noisy input measured 0.990) the
#   480p30 quality floor.
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
WORK_MS="${WORK_MS:-660000}"
STILL_MS="${STILL_MS:-30000}"
SLOW_WORK_MS=30000
# Encode time for rung1.mp4 short of its 1080p60 estimate (about 9.8 s; plan.go's coefficients), which 0.7 of it
# reaches only past 14.0 s, and past its 720p30 one (about 3.7 s), which it covers while more than 5.3 s is left: the
# input and the probe may take about 8 s before the plan changes to 480p30 (locally they took under 30 ms).
LOWER_ENCODE_MS=13500
SLOW_CPUS=0.05
MIN_SSIM_480P="${MIN_SSIM_480P:-0.95}"
work="$(mktemp -d "${TMPDIR:-/tmp}/kopje-container-smoke.XXXXXX")"
# The fixtures are written as this user, so the script can rewrite them (the image's user may be root or another uid).
as_me=(--user "$(id -u):$(id -g)")
name="kopje-media-smoke-$$"
cleanup() {
  docker rm -f "$name" "$name-slow" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker run -d --name "$name" --network none --cpus "$CPUS" --memory "$MEMORY" --read-only \
  --tmpfs /tmp:rw,size=4g "$image" >/dev/null

mkdir -p "$work/in" "$work/out" "$work/fixture"
# ffm runs the pinned ffmpeg on $work/fixture, mounted as /f and its working directory.
ffm() { docker run --rm --network none "${as_me[@]}" -v "$work/fixture:/f" -w /f --entrypoint /ffmpeg "$ffmpeg_image" -v error "$@"; }
# tone.wav: three seconds of a sine, the audio input, tagged with a seeded title.
ffm -f lavfi -i sine=frequency=440:duration=3 -metadata title=KOPJEMARK_WAV_TITLE /f/tone.wav
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
ffm -framerate 1 -loop 1 -t 3 -i /f/frame.png -c:v copy -f mov /f/exif.mov
# p3.mov: three seconds of one 64x48 frame of (210,70,40) in Display P3, its PNG tagged only by an ICC profile (the
# pinned ffmpeg's for P3, with KOPJEMARK_ICC appended inside the profile), copied into MOV unchanged.
p3_frame='color=c=0xD24628:s=64x48:d=1,format=rgb24'
p3_frame+=',setparams=color_primaries=smpte432:color_trc=iec61966-2-1,iccgen=force=1'
ffm -f lavfi -i "$p3_frame" -frames:v 1 -c:v png /f/p3-generated.png
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
ffm -framerate 1 -loop 1 -t 3 -i /f/p3.png -c:v copy -f mov /f/p3.mov
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
ffm -framerate 1 -loop 1 -t 3 -i /f/gray.png -c:v copy -f mov /f/gray.mov
# cover.m4a and cover-bmp.m4a: AAC with a 4096x4096 PNG or BMP cover (over the pixel limit; it is not the video and is
# never decoded);
# twostream.mov: H.264 then a PNG stream; tone.aac: raw ADTS AAC, whose headers declare no duration.
ffm -f lavfi -i color=c=red:s=4096x4096:d=1 -frames:v 1 -c:v png cover.png
ffm -f lavfi -i sine=d=3 -i cover.png -map 0 -map 1 -c:a aac -c:v copy -disposition:v attached_pic cover.m4a
ffm -f lavfi -i color=c=red:s=4096x4096:d=1 -frames:v 1 -c:v bmp cover.bmp
ffm -f lavfi -i sine=d=3 -i cover.bmp -map 0 -map 1 -c:a aac -c:v copy -disposition:v attached_pic cover-bmp.m4a
ffm -f lavfi -i testsrc2=s=320x240:d=2 -f lavfi -i color=c=blue:s=64x48:d=2:r=1 -map 0 -map 1 -c:v:0 libx264 \
  -c:v:1 png twostream.mov
ffm -f lavfi -i sine=d=3 -c:a aac tone.aac
# lie.mp4: one 320x240 H.264 frame, then a second of 4096x2160 ones in the same stream; the MP4's headers carry only
# the first parameters, so they declare 320x240.
ffm -f lavfi -i testsrc2=s=320x240:d=0.04:r=25 -c:v libx264 -f h264 small.h264
ffm -f lavfi -i testsrc2=s=4096x2160:d=1:r=25 -c:v libx264 -preset ultrafast -f h264 big.h264
cat "$work/fixture/small.h264" "$work/fixture/big.h264" >"$work/fixture/lie.h264"
ffm -r 25 -f h264 -i lie.h264 -c copy lie.mp4
# lie-av1.mp4: the same in AV1, a second of each size: libdav1d takes -max_pixels as its frame size limit and reports
# the later frames as "Frame size ... exceeds limit".
ffm -f lavfi -i testsrc2=s=320x240:d=1:r=25 -c:v libaom-av1 -cpu-used 8 -f obu small.obu
ffm -f lavfi -i testsrc2=s=4096x2160:d=1:r=25 -c:v libaom-av1 -cpu-used 8 -row-mt 1 -f obu big.obu
cat "$work/fixture/small.obu" "$work/fixture/big.obu" >"$work/fixture/lie.obu"
ffm -r 25 -f obu -i lie.obu -c copy lie-av1.mp4
# One input per rung (testsrc2 with seeded temporal noise, so the encoder has detail to keep) with a stereo tone, and
# the audio types. The rung inputs are capped at 1 Mbit/s, which keeps the 600 s one under the upload limit (90 MiB).
noisy() { echo "testsrc2=s=$1:r=$2:d=$3,noise=alls=10:allf=t:all_seed=1"; }
ffm -f lavfi -i "$(noisy 1920x1080 60 3)" -f lavfi -i sine=d=3:sample_rate=48000 -ac 2 -c:v libx264 -preset ultrafast \
  -b:v 1M -maxrate 1M -bufsize 2M -c:a aac rung1.mp4
ffm -f lavfi -i "$(noisy 1920x1080 60 121)" -f lavfi -i sine=d=121:sample_rate=48000 -ac 2 -c:v libx264 -preset ultrafast \
  -b:v 1M -maxrate 1M -bufsize 2M -c:a aac rung2.mp4
ffm -f lavfi -i "$(noisy 1280x720 30 600)" -f lavfi -i sine=d=600:sample_rate=44100 -ac 2 -c:v libx264 -preset ultrafast \
  -b:v 1M -maxrate 1M -bufsize 2M -c:a aac rung3.mp4
# Each rung's last duration: plan.go's rung by the source's, the verifier's by the output's (RUNG_SLACK_MS).
ffm -f lavfi -i testsrc2=s=320x180:r=60:d=120 -f lavfi -i sine=d=120:sample_rate=44100 -ac 2 -c:v libx264 \
  -preset ultrafast -c:a aac edge120.mp4
ffm -f lavfi -i testsrc2=s=1280x720:r=30:d=300 -f lavfi -i sine=d=300:sample_rate=44100 -ac 2 -c:v libx264 \
  -preset ultrafast -b:v 1M -maxrate 1M -bufsize 2M -c:a aac edge300.mp4
# The audio starts 500 ms late: an empty edit makes the output's movie about 120.4 s, while each stream lasts under
# 120 s (119.9 s; at 120 s the AAC track's rounding already takes the source past the first rung).
ffm -f lavfi -i testsrc2=s=320x180:r=60:d=119.9 -itsoffset 0.5 -f lavfi -i sine=d=119.9:sample_rate=44100 -ac 2 \
  -c:v libx264 -preset ultrafast -c:a aac delay120.mp4
ffm -f lavfi -i sine=d=3 -c:a aac tone.m4a
ffm -f lavfi -i sine=d=3 -ac 2 -c:a flac tone.flac
ffm -f lavfi -i sine=d=3:sample_rate=48000 -ac 2 -c:a libvorbis tone.ogg
ffm -f lavfi -i sine=d=3 -c:a libmp3lame tone.mp3
ffm -f lavfi -i sine=d=3:sample_rate=48000 -c:a libopus tone.webm
# Exactly AUDIO_DURATION_LIMIT: the MP3 holds LAME's delay and padding past it, which are not presented (#1828 A7).
ffm -f lavfi -i sine=d=1200 -c:a libmp3lame cap1200.mp3
inputs+=("$work/fixture/rung1.mp4" "$work/fixture/rung2.mp4" "$work/fixture/rung3.mp4" "$work/fixture/edge120.mp4"
  "$work/fixture/edge300.mp4" "$work/fixture/delay120.mp4" "audio:$work/fixture/tone.m4a"
  "audio:$work/fixture/tone.flac" "audio:$work/fixture/tone.ogg" "audio:$work/fixture/tone.mp3"
  "audio:$work/fixture/tone.webm" "audio:$work/fixture/cap1200.mp3")
inputs+=("audio:$work/fixture/tone.wav" "video:$work/fixture/exif.mov" "video:$work/fixture/p3.mov"
  "video:$work/fixture/gray.mov" "audio:$work/fixture/cover.m4a" "audio:$work/fixture/cover-bmp.m4a" "video:$work/fixture/twostream.mov"
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
# The headers of a normalize of <input in $work/in>, its output written to <output file>.
post_normalize() { # <input> <output file>
  req "$2" -X POST --data-binary "@/in/$1" -H 'Content-Type: application/octet-stream' \
    "http://127.0.0.1:8080/normalize?work_ms=$WORK_MS&still_ms=$STILL_MS"
}
# The headers of a /still of <input in $work/in>, its output written to <output file>.
post_still() { # <input> <output file>
  req "$2" -X POST --data-binary "@/in/$1" -H 'Content-Type: application/octet-stream' http://127.0.0.1:8080/still
}
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
# The top-left pixel of a normalized video's first frame as sRGB "r g b": its BT.709 YUV through BT.709's transfer.
video_pixel() { # <dir> <file>
  local v
  v="$(pixel "$1" "$2" 'zscale=pin=bt709:tin=bt709:min=bt709:rin=limited:p=bt709:t=iec61966-2-1:m=gbr:r=full,format=gbrp,format=rgb24')"
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
# Outputs kept for Kopje's verifier, and its list: keep <output file in $work/out> <name> <type> [<duration>].
fresh="$work/fresh"
mkdir -p "$fresh"
fresh_list=()
keep() {
  [ -f "$work/out/$1" ] || return 0
  cp "$work/out/$1" "$fresh/$2"
  fresh_list+=("{\"file\": \"$2\", \"type\": \"$3\"${4:+, \"expectedDuration\": $4}}")
}
# The luma (and chroma) of an 8x8 block of a file's first frame, decoded as BT.709: "y" or "y u v".
block() { # <dir> <file> <x> <y> [yuv]
  local fmt=gray
  [ "${5:-}" = yuv ] && fmt=yuv444p
  docker run --rm --network none -v "$1:/p:ro" --entrypoint /ffmpeg "$ffmpeg_image" -v quiet -i "/p/$2" \
    -vf "crop=8:8:$3:$4,scale=1:1:flags=area,format=$fmt" -frames:v 1 -f rawvideo - | od -An -tu1 | xargs
}
# The decoded length of a file's stream (v or a): the end of its last frame.
decoded() { # <dir> <file> <v|a>
  docker run --rm --network none -v "$1:/p:ro" --entrypoint /ffprobe "$ffmpeg_image" -v error -select_streams "$3:0" \
    -show_entries frame=pts_time,duration_time -of csv=p=0 "/p/$2" |
    awk -F, '$1 != "" { e = $1 + ($2 == "" ? 0 : $2); if (e > m) m = e } END { printf "%.3f", m }'
}
within() { awk -v a="$1" -v b="$2" -v t="$3" 'BEGIN{d=a-b; print (d*d <= t*t) ? "true" : "false"}'; }

for _ in $(seq 1 100); do
  if [ "$(status "$(req healthz http://127.0.0.1:8080/healthz 2>/dev/null || true)")" = 200 ]; then
    break
  fi
  sleep 0.1
done
[ "$(status "$(req healthz http://127.0.0.1:8080/healthz)")" = 200 ] || { echo "no /healthz" >&2; exit 1; }
# The protocol version the Worker requires (src/media-processor.ts NORMALIZE_PROTOCOL).
# Its top-level field, exactly; the body is not printed.
python3 -I -c 'import json, sys; v = json.load(open(sys.argv[1])).get("protocol"); sys.exit(0 if type(v) is int and v == 2 else 1)' \
  "$work/out/healthz" 2>/dev/null || { echo "/healthz names no protocol 2" >&2; exit 1; }

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
  h="$(post_normalize "$base" "$base.normalized")"
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
    if [ "$want" = video ]; then
      keep "$base.normalized" "$base.mp4" video/mp4 "$expected"
    else
      keep "$base.normalized" "$base.mp3" audio/mpeg "$expected"
    fi
    # Each rung's geometry and frame rate.
    rung=""
    case "$base" in
      rung1.mp4) rung="1920,1080,60/1" ;;
      rung2.mp4) rung="1280,720,30/1" ;;
      rung3.mp4) rung="852,480,30/1" ;;
      edge120.mp4 | delay120.mp4) rung="320,180,60/1" ;;
      edge300.mp4) rung="1280,720,30/1" ;;
    esac
    if [ -n "$rung" ]; then
      geometry="$(ffprobe -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 \
        "/o/$base.normalized")"
      check "$([ "$geometry" = "$rung" ] && echo true)" "$base normalize: $geometry, want $rung"
      checks="$checks $geometry"
    fi
    if [ "$base" = rung3.mp4 ]; then
      # 480p30 quality at 600 s (design 4.11): SSIM against the source scaled as normalize scales it.
      ssim="$(docker run --rm --network none -v "$work/out:/o:ro" -v "$work/in:/i:ro" --entrypoint /ffmpeg \
        "$ffmpeg_image" -nostats -i "/o/$base.normalized" -i "/i/$base" \
        -lavfi '[1:v]scale=852:480:flags=bicubic,setsar=1[ref];[0:v][ref]ssim' -f null - 2>&1 |
        sed -n 's/.*SSIM .* All:\([0-9.]*\).*/\1/p')"
      check "$(awk -v s="$ssim" -v m="$MIN_SSIM_480P" 'BEGIN{print (s != "" && s >= m) ? "true" : "false"}')" \
        "$base normalize: SSIM $ssim, want at least $MIN_SSIM_480P"
      checks="$checks SSIM $ssim"
    fi
  fi
  row "$base" "normalize ($kind)" "$(status "$h")" "$wall" "$h" "$(size "$base.normalized")" "$checks"

  if [ "$want" = video ]; then
    h="$(req "$base.still.png" http://127.0.0.1:8080/normalize/still)"
    verify "$base normalize/still" "$base.still.png" "$h" image/png png
    [ "$(status "$h")" = 200 ] && keep "$base.still.png" "$base.still.png" image/png
    row "$base" "normalize/still" "$(status "$h")" 0 "$h" "$(size "$base.still.png")" "$checks"

    t0="$(now_ms)"
    h="$(post_still "$base" "$base.png")"
    wall=$(($(now_ms) - t0))
    verify "$base still" "$base.png" "$h" image/png png
    [ "$(status "$h")" = 200 ] && keep "$base.png" "$base.png" image/png
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

# Decoded content (design #1828 4.11). normalize <input in $work/in> <output name>: the status, keeping a 200's output.
normalize() {
  local h
  h="$(post_normalize "$1" "$2")"
  echo "$(status "$h") $(header Kopje-Error "$h")"
}
# A normalize's still and a /still of <input>, as <input>.still.png and <input>.png, kept for the verifier; sets made to
# the ones answered 200. It runs in this shell (never in a command substitution), so keep's fresh_list entries stay.
stills() { # <input>
  local h
  made=""
  h="$(req "$1.still.png" http://127.0.0.1:8080/normalize/still)"
  [ "$(status "$h")" = 200 ] && keep "$1.still.png" "$1.still.png" image/png && made="$1.still.png"
  h="$(post_still "$1" "$1.png")"
  [ "$(status "$h")" = 200 ] && keep "$1.png" "$1.png" image/png && made="$made $1.png"
  return 0
}
# Whether both stills of <input> are in the verifier's list.
both_listed() { # <input>
  local entries="${fresh_list[*]}"
  [[ $entries == *"\"file\": \"$1.still.png\""* && $entries == *"\"file\": \"$1.png\""* ]] && echo true
  return 0
}
# The dimensions and the luma of the four corners of <file in $work/out>, as dims and marks.
corners() { # <file>
  dims="$(ffprobe -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "/o/$1")"
  marks="$(block "$work/out" "$1" 0 0) $(block "$work/out" "$1" 120 0)"
  marks="$marks $(block "$work/out" "$1" 0 64) $(block "$work/out" "$1" 120 64)"
}
# Whether dims and marks are 128x72 with the white marker top left and the other corners black.
upright() {
  awk -v m="$marks" -v d="$dims" 'BEGIN{n = split(m, c, " ");
    print (d == "128,72" && n == 4 && c[1] > 180 && c[2] < 60 && c[3] < 60 && c[4] < 60) ? "true" : "false"}'
}
# The marker: 128x72 black with a white 16x16 square top left, stored rotated with the matrix that shows it upright.
ffm -f lavfi -i "color=c=black:s=128x72:r=30:d=2,drawbox=x=0:y=0:w=16:h=16:c=white:t=fill" -c:v libx264 upright.mp4
for turn in "90 transpose=clock" "180 hflip,vflip" "270 transpose=cclock"; do
  read -r degrees filter <<<"$turn"
  dims=""
  ffm -i upright.mp4 -vf "$filter" -c:v libx264 "stored$degrees.mp4"
  ffm -display_rotation:v:0 "$degrees" -i "stored$degrees.mp4" -c copy "/f/rotated$degrees.mp4"
  cp "$work/fixture/rotated$degrees.mp4" "$work/in/"
  got="$(normalize "rotated$degrees.mp4" "rotated$degrees.out")"
  marks="-"
  if [ "${got% *}" = 200 ]; then
    corners "rotated$degrees.out"
    keep "rotated$degrees.out" "rotated$degrees.mp4" video/mp4 2
    got="$got, $dims, corners $marks"
  fi
  check "$(upright)" "rotated$degrees.mp4: $got, want 128,72 with the marker top left"
  echo "| rotated$degrees.mp4 | normalize | $got | | | | | | | | |"
  stills "rotated$degrees.mp4"
  check "$(both_listed "rotated$degrees.mp4")" "rotated$degrees.mp4: stills $made, want both, listed for the verifier"
  for still in $made; do
    corners "$still"
    check "$(upright)" "$still: $dims, corners $marks, want 128,72 with the marker top left"
    echo "| rotated$degrees.mp4 | $still | $dims, corners $marks | | | | | | | | |"
  done
done
# HLG and PQ: left half black (code 64), right half reference white (HLG 75 %: 721; PQ 203 cd/m2: 573), 10-bit
# BT.2020 with HDR10 mastering display and light level metadata (which the output must not keep: the verifier refuses
# an mdcv or clli box), the tags on the frames and in a colr box, as a camera writes them; and the same file with its
# colr box renamed free (<label>-vui.mp4), so the tags are only in the HEVC VUI, which the header probe does not read:
# it must read unknown there, and discovery must find the transfer, so both are tone mapped alike.
for hdr in "arib-std-b67 721 hlg" "smpte2084 573 pq" "arib-std-b67 721 hlg-vui" "smpte2084 573 pq-vui"; do
  read -r trc white label <<<"$hdr"
  ffm -f lavfi -i "nullsrc=s=128x72:r=30:d=2,format=yuv420p10le,geq=lum='if(lt(X,64),64,$white)':cb=512:cr=512,setparams=color_primaries=bt2020:color_trc=$trc:colorspace=bt2020nc" \
    -c:v libx265 -preset superfast -pix_fmt yuv420p10le -tag:v hvc1 -movflags +write_colr \
    -x265-params "log-level=error:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400" \
    "$label.mp4"
  if [ "${label%-vui}" != "$label" ]; then
    python3 -c 'import sys; p = sys.argv[1]; b = open(p, "rb").read(); assert b.count(b"colr") == 1; open(p, "wb").write(b.replace(b"colr", b"free"))' \
      "$work/fixture/$label.mp4"
    seen="$(docker run --rm --network none -v "$work/fixture:/i:ro" --entrypoint /ffprobe "$ffmpeg_image" -v error \
      -nofind_stream_info -select_streams v:0 -show_entries stream=color_transfer -of csv=p=0 "/i/$label.mp4")"
    check "$([ "$seen" = unknown ] && echo true)" "$label.mp4: the header probe reads transfer $seen, want unknown"
  fi
  cp "$work/fixture/$label.mp4" "$work/in/"
  got="$(normalize "$label.mp4" "$label.out")"
  black="-" patch="- - -"
  if [ "${got% *}" = 200 ]; then
    black="$(block "$work/out" "$label.out" 24 32)"
    patch="$(block "$work/out" "$label.out" 96 32 yuv)"
    keep "$label.out" "$label.mp4" video/mp4 2
    got="$got, black $black, white $patch"
  fi
  check "$(awk -v b="$black" -v p="$patch" 'BEGIN{split(p, w, " ");
    print (b <= 24 && w[1] >= 150 && w[1] <= 235 && (w[2]-128)^2 <= 144 && (w[3]-128)^2 <= 144) ? "true" : "false"}')" \
    "$label.mp4: $got, want black <= 24 and white 150-235 in luma, its chroma within 12 of 128"
  echo "| $label.mp4 | normalize | $got | | | | | | | | |"
  stills "$label.mp4"
  check "$(both_listed "$label.mp4")" "$label.mp4: stills $made, want both, listed for the verifier"
  for still in $made; do
    black="$(block "$work/out" "$still" 24 32)"
    patch="$(block "$work/out" "$still" 96 32 yuv)"
    check "$(awk -v b="$black" -v p="$patch" 'BEGIN{split(p, w, " ");
      print (b <= 24 && w[1] >= 150 && (w[2]-128)^2 <= 144 && (w[3]-128)^2 <= 144) ? "true" : "false"}')" \
      "$still: black $black, white $patch, want black <= 24 and white at least 150, its chroma within 12 of 128"
    echo "| $label.mp4 | $still | black $black, white $patch | | | | | | | | |"
  done
done
# sRGB's transfer on BT.709 primaries, tagged as a screen recording is: one 64x48 frame of (210,70,40) coded with that
# curve, which normalize converts to BT.709's before labelling the output BT.709.
ffm -f lavfi -i color=c=0xD24628:s=64x48:r=30:d=2 \
  -vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv \
  -c:v libx264 -color_primaries bt709 -color_trc iec61966-2-1 -colorspace bt709 -color_range tv -movflags +write_colr \
  srgb.mp4
cp "$work/fixture/srgb.mp4" "$work/in/"
source_px="$(pixel "$work/fixture" srgb.mp4 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24')"
source_px="$(echo $source_px)"
got="$(normalize srgb.mp4 srgb.out)"
got_px="-"
if [ "${got% *}" = 200 ]; then
  got_px="$(video_pixel "$work/out" srgb.out)"
  keep srgb.out srgb.mp4 video/mp4 2
fi
check "$(near "$got_px" "$source_px" 4)" "srgb.mp4 normalize: $got, sRGB $got_px, source $source_px"
echo "| srgb.mp4 | normalize | $got, sRGB $got_px, source $source_px | | | | | | | | |"
# The same frame coded with BT.601's matrix and tagged with no matrix at all: normalize reads a frame of 576 lines or
# fewer with BT.601's (matrixFor), as a player would, and converts its transfer as above.
ffm -f lavfi -i color=c=0xD24628:s=64x48:r=30:d=2 \
  -vf scale=out_color_matrix=bt601:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=unknown:range=tv \
  -c:v libx264 -color_primaries bt709 -color_trc iec61966-2-1 -color_range tv -movflags +write_colr nomatrix.mp4
cp "$work/fixture/nomatrix.mp4" "$work/in/"
source_px="$(pixel "$work/fixture" nomatrix.mp4 'scale=in_color_matrix=bt601:in_range=tv,format=rgb24')"
source_px="$(echo $source_px)"
got="$(normalize nomatrix.mp4 nomatrix.out)"
got_px="-"
if [ "${got% *}" = 200 ]; then
  got_px="$(video_pixel "$work/out" nomatrix.out)"
  keep nomatrix.out nomatrix.mp4 video/mp4 2
fi
check "$(near "$got_px" "$source_px" 4)" "nomatrix.mp4 normalize: $got, sRGB $got_px, source $source_px"
echo "| nomatrix.mp4 | normalize | $got, sRGB $got_px, source $source_px | | | | | | | | |"
# Durations: VFR (30 fps for a second, then 10 fps), audio (4 s) longer than video (2 s), and an mvhd of 1 s and of
# 10 s over 3 s of streams.
ffm -f lavfi -i "testsrc2=s=128x72:r=30:d=3,select='lt(n\,30)+not(mod(n\,3))'" -fps_mode vfr -c:v libx264 vfr.mp4
ffm -f lavfi -i testsrc2=s=128x72:r=30:d=2 -f lavfi -i sine=d=4 -c:v libx264 -c:a aac longaudio.mp4
ffm -f lavfi -i testsrc2=s=128x72:r=30:d=3 -f lavfi -i sine=d=3 -c:v libx264 -c:a aac -movflags +faststart header.mp4
python3 -I - "$work/fixture/header.mp4" <<'PY'
import struct, sys
b = open(sys.argv[1], "rb").read()
i = b.index(b"mvhd")
scale = struct.unpack(">I", b[i + 16 : i + 20])[0]
for name, seconds in (("header-short.mp4", 1), ("header-long.mp4", 10)):
    out = bytearray(b)
    out[i + 20 : i + 24] = struct.pack(">I", seconds * scale)
    open(sys.argv[1].replace("header.mp4", name), "wb").write(out)
PY
for case in vfr.mp4 longaudio.mp4 header-short.mp4 header-long.mp4; do
  cp "$work/fixture/$case" "$work/in/"
  got="$(normalize "$case" "$case.out")"
  ok=false
  if [ "${got% *}" = 200 ]; then
    ok=true
    for stream in v a; do
      want="$(decoded "$work/in" "$case" "$stream")"
      [ "$stream" = v ] && video_length="$want"
      have="$(decoded "$work/out" "$case.out" "$stream")"
      [ "$want" = 0.000 ] && [ "$have" = 0.000 ] && continue
      [ "$(within "$have" "$want" 0.15)" = true ] || ok=false
      got="$got, $stream $have s (input $want s)"
    done
    keep "$case.out" "$case" video/mp4 "$video_length"
  fi
  check "$ok" "$case: $got, want 200 with each stream as long as the input's"
  echo "| $case | normalize | $got | | | | | | | | |"
done

# Lower-rung planning: rung1.mp4, which the loop above saw encoded at 1080p60 with a roomy work deadline, is encoded at
# 720p30 when only the lower rung's estimate fits, and its output passes the verifier.
cp "$work/fixture/rung1.mp4" "$work/in/lower.mp4"
h="$(req lower.normalized -X POST --data-binary @/in/lower.mp4 -H 'Content-Type: application/octet-stream' \
  "http://127.0.0.1:8080/normalize?work_ms=$((LOWER_ENCODE_MS + 1000))&still_ms=1000")"
got="$(status "$h") $(header Kopje-Error "$h")"
ok=false
if [ "$(status "$h")" = 200 ]; then
  geometry="$(ffprobe -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 /o/lower.normalized)"
  got="200, $geometry"
  [ "$geometry" = "1280,720,30/1" ] && ok=true
  for stream in v a; do
    want="$(decoded "$work/in" lower.mp4 "$stream")"
    [ "$stream" = v ] && video_length="$want"
    have="$(decoded "$work/out" lower.normalized "$stream")"
    [ "$(within "$have" "$want" 0.15)" = true ] || ok=false
    got="$got, $stream $have s (input $want s)"
  done
  keep lower.normalized lower.mp4 video/mp4 "$video_length"
fi
check "$ok" "lower.mp4: $got, want 200 at 1280,720,30/1 with each stream as long as the input's"
echo "| lower.mp4 | normalize, encode about $LOWER_ENCODE_MS ms | $got | | | | | | | | $(header Kopje-Estimate-Ms "$h") ms estimated |"

# lie.mp4 and lie-av1.mp4: no frame over the pixel limit is decoded, whatever its headers declared, and the output
# that would leave is refused as the input's (422 pixels).
cp "$work/fixture/lie-av1.mp4" "$work/in/lie-av1.mp4"
got="$(normalize lie-av1.mp4 lie-av1.normalized)"
check "$([ "$got" = "422 pixels" ] && echo true)" "lie-av1.mp4 normalize: $got, want 422 pixels"
echo "| lie-av1.mp4 | normalize | $got | | | | | | | | |"
cp "$work/fixture/lie.mp4" "$work/in/lie.mp4"
got="$(normalize lie.mp4 lie.normalized)"
check "$([ "$got" = "422 pixels" ] && echo true)" "lie.mp4 normalize: $got, want 422 pixels"
echo "| lie.mp4 | normalize | $got | | | | | | | | |"
h="$(post_still lie.mp4 lie.png)"
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
  h="$(req refusal -X POST --data-binary "@/in/$file" "http://127.0.0.1:8080/normalize?work_ms=60000&still_ms=1000")"
  got="$(status "$h") $(header Kopje-Error "$h")"
  check "$([ "$got" = "$want $code_want" ] && echo true)" "$file: $got, want $want $code_want"
  echo "| $file | normalize | $(status "$h") | | | | | | | | $(header Kopje-Error "$h") |"
done

# The work deadline: rung1.mp4 sent at a quarter of its size a second, so its input takes about 4 s, to a container
# held to SLOW_CPUS. The answer is one of the envelope refused for the time left (422 envelope), a timeout at the cut
# (504 timeout) or an output that decodes, and its first byte arrives by SLOW_WORK_MS from the request's start, never a
# fixed encode time after the input.
slow="$name-slow"
docker run -d --name "$slow" --network none --cpus "$SLOW_CPUS" --memory "$MEMORY" --read-only \
  --tmpfs /tmp:rw,size=1g "$image" >/dev/null
for _ in $(seq 1 240); do
  docker run --rm --network "container:$slow" "$CURL_IMAGE" -sf http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break
  sleep 0.5
done
cp "$work/fixture/rung1.mp4" "$work/in/slow.mp4"
rate=$(($(wc -c <"$work/in/slow.mp4") / 4 + 1))
h="$(docker run --rm --network "container:$slow" -v "$work/in:/in:ro" -v "$work/out:/out" "$CURL_IMAGE" -sS -H 'Expect:' \
  -o /out/slow.normalized -D - \
  -w 'starttransfer: %{time_starttransfer}\n' --limit-rate "$rate" -X POST --data-binary @/in/slow.mp4 \
  -H 'Content-Type: application/octet-stream' \
  "http://127.0.0.1:8080/normalize?work_ms=$SLOW_WORK_MS&still_ms=1000" | tr -d '\r')"
docker rm -f "$slow" >/dev/null
first="$(header starttransfer "$h")"
input_ms="$(header Kopje-Input-Ms "$h")"
got="$(status "$h") $(header Kopje-Error "$h")"
check "$(python3 -I -c 'import sys; print("true" if float(sys.argv[1]) * 1000 <= int(sys.argv[2]) and int(sys.argv[3]) >= 3000 else "false")' \
  "${first:-99}" "$SLOW_WORK_MS" "${input_ms:-0}")" \
  "slow input: $got, first byte at ${first:-?} s, input ${input_ms:-?} ms, want by $SLOW_WORK_MS ms with 3 s or more of input"
case "$got" in
  "200 ") check "$(decodes slow.normalized && echo true)" "slow input: its output does not decode" ;;
  "422 envelope" | "504 timeout") ;;
  *) check false "slow input: $got, want 200, 422 envelope or 504 timeout" ;;
esac
echo "| slow.mp4 | normalize, work $SLOW_WORK_MS ms | $(status "$h") | ${first:-} | $(awk -v ms="${input_ms:-0}" 'BEGIN { printf "%.1f", ms / 1000 }') | | | | | | $(header Kopje-Error "$h") |"

# Kopje's verifier on every output and still kept above.
(IFS=,; printf '[%s]\n' "${fresh_list[*]}") >"$fresh/list.json"
if ! (cd "$pkg" && AV_FRESH_LIST="$fresh/list.json" pnpm exec vitest run -c vitest.av-fresh.config.ts --max-workers=2 \
  --silent=false >"$work/verifier.log" 2>&1); then
  cat "$work/verifier.log" >&2
  check false "the output verifier refused fresh output (above)"
fi
echo "| ${#fresh_list[@]} outputs and stills | verifier | $(grep -cE '^[^ ]+\.(mp4|mp3) \{"kind"' "$work/verifier.log") verified | | | | | | | | |"
exit "$failed"
