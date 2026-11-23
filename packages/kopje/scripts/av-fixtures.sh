#!/usr/bin/env bash
# The output verifier's positive controls (#1828 PR2, src/platform/av-bytes.ts): short, low-resolution inputs made with
# the ffmpeg build the image pins, each run through the image's POST /normalize with no network, and the outputs
# written to packages/kopje/test/fixtures/av/ with manifest.json (name, input, kind, bytes, SHA-256). Everything runs
# as linux/amd64, the platform Cloudflare runs the image on. test-node/av-fixtures.test.ts holds the committed files
# to the manifest's SHA-256 and the manifest to the list below. That is integrity, not reproducibility: x264, the AAC
# encoder and LAME may write other bytes on other CPU paths, so the CI container job verifies fresh output instead
# (scripts/container-smoke.sh).
#
#   bash packages/kopje/scripts/av-fixtures.sh [--build] <image tag>
#     --build  builds packages/kopje/container into the tag first, for linux/amd64
#
# Inputs (each name is the output's, with .mp4 or .mp3):
#   r1-av         4 s 160x90 at 60 fps with 48 kHz stereo audio (the first rung keeps 60 fps)
#   r1-silent     3 s 160x90 at 30 fps, no audio
#   r1-32k        2 s 160x90 with 32 kHz mono audio (resampled to 44.1 kHz stereo)
#   r2-av         121 s of one static 64x36 frame at 60 fps with silent audio (the 720p30 rung: 30 fps)
#   r2-silent     121 s of one static 64x36 frame at 60 fps, no audio
#   r3-av         301 s of one static 32x18 frame at 10 fps with silent audio (the 480p30 rung, 128 kb/s audio)
#   r3-silent     301 s of one static 32x18 frame at 10 fps, no audio
#   cap-44k, cap-48k
#                 exactly VIDEO_DURATION_LIMIT (600 s) of one static 16x16 frame at 1 fps with silent 44.1 and 48 kHz
#                 audio: the AAC track holds its priming past the limit (#1828 A7)
#   rotated       2 s 160x90 with a display rotation of 90 (rotated into the pixels: 90x160)
#   hlg, pq       2 s 160x90 10-bit HEVC BT.2020 HLG and PQ (tone mapped to BT.709)
#   vfr           3 s 160x90: 30 fps for a second, then 10 fps
#   opus          3 s Opus-only WebM
#   m4a, flac, ogg, mp3, wav, aac
#                 3 s audio in each container: mono 44.1 kHz, the FLAC stereo, the Ogg stereo at 48 kHz, the WAV at
#                 8 kHz (resampled to 48 kHz), the AAC raw ADTS (its priming decoded: a LAME padding over one frame)
#   m2            3 s mono 24 kHz AAC in M4A: MPEG-2 Layer III, 576 samples a frame
set -euo pipefail

pkg="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" = --build ]; then
  shift
  docker build --platform linux/amd64 --quiet -t "${1:?image tag}" "$pkg/container" >/dev/null
fi
image="${1:?usage: av-fixtures.sh [--build] <image tag>}"
dest="$pkg/test/fixtures/av"
CURL_IMAGE='curlimages/curl:8.17.0@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40'
work="$(mktemp -d "${TMPDIR:-/tmp}/kopje-av-fixtures.XXXXXX")"
name="kopje-av-fixtures-$$"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/in" "$work/out" "$dest"
chmod 777 "$work/in" "$work/out"

# The inputs are made with the image's own ffmpeg (the pinned build), which runs as nonroot.
ff() { docker run --rm --platform linux/amd64 --network none -v "$work/in:/f" -w /f --entrypoint /usr/local/bin/ffmpeg "$image" -hide_banner \
  -loglevel error -y "$@"; }
video() { echo "testsrc2=s=$1:r=$2:d=$3"; }
still() { echo "smptebars=s=$1:r=$2:d=$3"; }
tone() { echo "sine=f=440:sample_rate=${2:-48000}:d=$1"; }
silence() { echo "anullsrc=r=48000:cl=stereo:d=$1"; }
h264=(-c:v libx264 -preset veryfast -pix_fmt yuv420p)

{
  ff -f lavfi -i "$(video 160x90 60 4)" -f lavfi -i "$(tone 4),aformat=channel_layouts=stereo" "${h264[@]}" -c:a aac r1-av.mp4
  ff -f lavfi -i "$(video 160x90 30 3)" "${h264[@]}" r1-silent.mp4
  ff -f lavfi -i "$(video 160x90 30 2)" -f lavfi -i "$(tone 2 32000)" "${h264[@]}" -c:a aac r1-32k.mp4
  ff -f lavfi -i "$(still 64x36 60 121)" -f lavfi -i "$(silence 121)" "${h264[@]}" -c:a aac r2-av.mp4
  ff -f lavfi -i "$(still 64x36 60 121)" "${h264[@]}" r2-silent.mp4
  ff -f lavfi -i "$(still 32x18 10 301)" -f lavfi -i "$(silence 301)" "${h264[@]}" -c:a aac r3-av.mp4
  ff -f lavfi -i "$(still 32x18 10 301)" "${h264[@]}" r3-silent.mp4
  ff -f lavfi -i "$(still 16x16 1 600)" -f lavfi -i "anullsrc=r=44100:cl=stereo:d=600" "${h264[@]}" -c:a aac -t 600 cap-44k.mp4
  ff -f lavfi -i "$(still 16x16 1 600)" -f lavfi -i "$(silence 600)" "${h264[@]}" -c:a aac -t 600 cap-48k.mp4
  ff -f lavfi -i "$(video 160x90 30 2)" "${h264[@]}" upright.mp4
  ff -display_rotation:v:0 90 -i upright.mp4 -c copy rotated.mp4
  # The frames carry the tags (the encoder takes them from the frames, not from -color_*), and the colr box carries
  # them to the header probe, as a camera's file does: without it the transfer is only in the HEVC VUI, which the
  # probe does not read.
  for trc in arib-std-b67 smpte2084; do
    out=hlg.mp4
    [ "$trc" = smpte2084 ] && out=pq.mp4
    ff -f lavfi -i "$(video 160x90 30 2),format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=${trc}:colorspace=bt2020nc" \
      -c:v libx265 -preset superfast -pix_fmt yuv420p10le -x265-params log-level=error -tag:v hvc1 -movflags +write_colr \
      "$out"
  done
  ff -f lavfi -i "$(video 160x90 30 3),select='lt(n\,30)+not(mod(n\,3))'" -fps_mode vfr "${h264[@]}" vfr.mp4
  ff -f lavfi -i "$(tone 3)" -c:a libopus opus.webm
  ff -f lavfi -i "$(tone 3 44100)" -c:a aac m4a.m4a
  ff -f lavfi -i "$(tone 3 24000)" -c:a aac m2.m4a
  ff -f lavfi -i "$(tone 3 44100),aformat=channel_layouts=stereo" -c:a flac flac.flac
  ff -f lavfi -i "$(tone 3 48000),aformat=channel_layouts=stereo" -c:a libvorbis ogg.ogg
  ff -f lavfi -i "$(tone 3 44100)" -c:a libmp3lame mp3.mp3
  ff -f lavfi -i "$(tone 3 8000)" -c:a pcm_s16le wav.wav
  ff -f lavfi -i "$(tone 3 44100)" -c:a aac aac.aac
}
rm "$work/in/upright.mp4"

docker run -d --platform linux/amd64 --name "$name" --network none --read-only --tmpfs /tmp:rw,size=1g "$image" >/dev/null
req() { # <output file> <curl args...>
  docker run --rm --network "container:$name" -v "$work/in:/in:ro" -v "$work/out:/out" "$CURL_IMAGE" \
    -sS -H 'Expect:' -o "/out/$1" -w '%{http_code} %header{kopje-kind}' "${@:2}"
}
for _ in $(seq 1 100); do
  [ "$(req healthz http://127.0.0.1:8080/healthz 2>/dev/null || true)" = "200 " ] && break
  sleep 0.1
done

manifest="["
sep=""
for input in "$work"/in/*; do
  base="$(basename "$input")"
  stem="${base%.*}"
  got="$(req "$stem" -X POST --data-binary "@/in/$base" -H 'Content-Type: application/octet-stream' \
    'http://127.0.0.1:8080/normalize?probe_ms=10000&encode_ms=600000')"
  read -r code kind <<<"$got"
  [ "$code" = 200 ] || { echo "$base: HTTP $code" >&2; exit 1; }
  ext=mp4
  [ "$kind" = audio ] && ext=mp3
  mv "$work/out/$stem" "$dest/$stem.$ext"
  bytes="$(wc -c <"$dest/$stem.$ext" | tr -d ' ')"
  sha="$(shasum -a 256 "$dest/$stem.$ext" | cut -d' ' -f1)"
  manifest+="$sep"$'\n'"  {\"name\": \"$stem.$ext\", \"input\": \"$base\", \"kind\": \"$kind\", \"bytes\": $bytes, \"sha256\": \"$sha\"}"
  sep=","
  echo "$stem.$ext $bytes" >&2
done
# Written as the formatter writes JSON.
printf '%s\n]\n' "$manifest" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")), null, 2) + "\n")' \
  >"$dest/manifest.json"
