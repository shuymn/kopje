#!/usr/bin/env bash
# Makes the media processor's probe fixture with the ffmpeg build the image pins (container/Dockerfile), in Docker:
# container/probe.mp4, a 2-second 192x144 H.264/AAC clip carrying a 90-degree display rotation and seeded metadata
# (KOPJEMARK in its title, comment and handler name, a location and a creation time), and src/media-probe-fixture.ts,
# the same bytes as base64 for the Worker. test-node/container-image.test.ts holds the two equal.
#
#   bash packages/kopje/scripts/media-probe-fixture.sh
set -euo pipefail

pkg="$(cd "$(dirname "$0")/.." && pwd)"
ffmpeg_image="$(sed -n 's/^FROM \(mwader\/static-ffmpeg[^ ]*\) AS ffmpeg$/\1/p' "$pkg/container/Dockerfile")"
[ -n "$ffmpeg_image" ] || { echo "no ffmpeg stage in container/Dockerfile" >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/kopje-probe-fixture.XXXXXX")"
trap 'rm -rf "$work"' EXIT

ff() { docker run --rm --network none -v "$work:/w" -w /w --entrypoint /ffmpeg "$ffmpeg_image" -hide_banner -loglevel error -y "$@"; }

ff -f lavfi -t 2 -i 'testsrc2=s=192x144:r=15' -f lavfi -t 2 -i 'sine=f=440:sample_rate=48000' \
  -c:v libx264 -preset veryfast -crf 36 -pix_fmt yuv420p -g 15 -bsf:v filter_units=remove_types=6 \
  -c:a aac -b:a 24k -ac 1 plain.mp4
# A stream copy keeps the display matrix -display_rotation attaches.
ff -display_rotation:v:0 90 -i plain.mp4 -map 0 -c copy -movflags +faststart+use_metadata_tags \
  -metadata title=KOPJEMARK_TITLE -metadata comment=KOPJEMARK_COMMENT \
  -metadata location='+35.6586+139.7454+040.000/' -metadata creation_time=2024-05-01T12:34:56.000000Z \
  -metadata:s:v:0 handler_name=KOPJEMARK_HANDLER probe.mp4

cp "$work/probe.mp4" "$pkg/container/probe.mp4"
{
  echo '// container/probe.mp4 as base64, the probes'"'"' clip (src/media-processor.ts): a 2-second 192x144 H.264/AAC'
  echo '// clip with a 90-degree rotation and seeded metadata (KOPJEMARK, a location), made by scripts/media-probe-fixture.sh,'
  echo '// which writes both files. test-node/container-image.test.ts holds the two equal.'
  echo 'export const PROBE_FIXTURE_BASE64 ='
  printf '  "%s";\n' "$(base64 <"$work/probe.mp4" | tr -d '\n')"
} >"$pkg/src/media-probe-fixture.ts"
echo "wrote container/probe.mp4 ($(wc -c <"$pkg/container/probe.mp4") bytes) and src/media-probe-fixture.ts"
