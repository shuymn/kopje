#!/usr/bin/env bash
# The media processor bench's inputs (#1828, P27), made with the ffmpeg build the image pins, in Docker. Synthetic
# footage only: video is testsrc2 with temporal noise (so encoding costs what camera footage costs), audio a sine sweep
# with pink noise, and every container carries seeded metadata (KOPJEMARK, a location). Every file stays within
# AV_UPLOAD_LIMIT (94,371,840 bytes) and Mastodon's source limits (8,294,400 pixels, 120 fps, 36,000 frames).
#
#   bash packages/kopje/bench/media-processor/fixtures.sh <dir>     (makes what <dir> lacks; the 4K ten-minute clip
#                                                                     takes the longest, tens of minutes)
#   bash packages/kopje/bench/media-processor/fixtures.sh --matrix <dir>
#                         the boundary matrix's inputs instead (#1828 PR2, A3): every fixture of matrix.json, just below
#                         and above each rung boundary and each envelope edge (measure.sh MATRIX=1). Needs jq.
#
#   sdr-h264.mp4          60 s 1080p30 H.264/AAC with metadata keys
#   hdr-hevc-rotated.mov  60 s 1080p30 10-bit HEVC HLG, rotation 90, Apple keys
#   vp9-90s.webm          90 s 1080p30 VP9/Opus (the duration on the segment only)
#   near-cap.mp4          60 s 1080p30 H.264 at a constant 11.5 Mb/s, about 88 MiB
#   hlg-4k.mov            30 s 2160p30 10-bit HEVC HLG BT.2020, rotation 90
#   pq-4k.mp4             30 s 2160p30 10-bit HEVC PQ BT.2020
#   sdr-1080p-5min.mp4    300 s 1080p30 H.264      sdr-1080p-10min.mp4   600 s 1080p30 H.264
#   sdr-4k-5min.mp4       300 s 2160p30 HEVC       sdr-4k-10min.mp4      600 s 2160p30 HEVC
#   tagged.m4a, tagged.flac, tagged.ogg            60 s audio with tags (and cover art for M4A and FLAC)
#
# HDR inputs carry their transfer in the frames and in a colr box, as a camera's file does: the server's header probe
# reads the colr box, and for a file without one, discovery recovers the transfer from the HEVC VUI.
set -euo pipefail

matrix=""
if [ "${1:-}" = --matrix ]; then
  matrix="$(dirname "$0")/matrix.json"
  shift
fi
out="$(cd "${1:?usage: fixtures.sh [--matrix] <dir>}" && pwd)"
pkg="$(cd "$(dirname "$0")/../.." && pwd)"
ffmpeg_image="$(sed -n 's/^FROM \(mwader\/static-ffmpeg[^ ]*\) AS ffmpeg$/\1/p' "$pkg/container/Dockerfile")"
ff() { docker run --rm --network none -v "$out:/w" -w /w --entrypoint /ffmpeg "$ffmpeg_image" -hide_banner -loglevel error -y "$@"; }

GPS='+35.6586+139.7454+040.000/'
CREATED='2024-05-01T12:34:56.000000Z'
src() { echo "testsrc2=s=$1:r=30,noise=alls=24:allf=t+u"; }
AUDIO='sine=f=220:beep_factor=4:sample_rate=48000,aformat=channel_layouts=stereo[s];anoisesrc=c=pink:a=0.05:r=48000,aformat=channel_layouts=stereo[n];[s][n]amix=inputs=2'
TAGS=(-metadata title=KOPJEMARK_TITLE -metadata comment=KOPJEMARK_COMMENT -metadata location="$GPS"
  -metadata creation_time="$CREATED")
mkdir -p "$out/.work"
trap 'rm -rf "$out/.work"' EXIT
[ -f "$out/.work/cover.png" ] || ff -f lavfi -i 'color=c=0x336699:s=600x600:d=1' -frames:v 1 .work/cover.png

make() { # <file> <ffmpeg args...>
  local file=$1
  shift
  if [ ! -f "$out/$file" ]; then
    echo "making $file" >&2
    ff "$@" "$file"
  fi
}

# H.264 SDR with audio, at a bitrate; extra args before the output.
h264() { # <file> <seconds> <size> <bitrate> [args...]
  local file=$1 t=$2 size=$3 rate=$4
  shift 4
  make "$file" -f lavfi -t "$t" -i "$(src "$size")" -f lavfi -t "$t" -i "$AUDIO" -map 0:v -map 1:a \
    -c:v libx264 -preset veryfast -b:v "$rate" -maxrate "$rate" -bufsize "$rate" -pix_fmt yuv420p -c:a aac -b:a 160k \
    "${TAGS[@]}" "$@"
}

# HEVC 10-bit, HDR when a transfer is given. An HDR file's -movflags gain +write_colr (one -movflags takes effect).
hevc() { # <file> <seconds> <size> <bitrate> <transfer|sdr> [<movflags>]
  local file=$1 t=$2 size=$3 rate=$4 trc=$5 flags=${6:-} color=() tag="" movflags=()
  if [ "$trc" != sdr ]; then
    # ffmpeg takes the tags from the frames (setparams), and the MP4 muxer writes colr only with +write_colr.
    tag=",setparams=color_primaries=bt2020:color_trc=$trc:colorspace=bt2020nc"
    color=(-x265-params "log-level=error:colorprim=bt2020:transfer=$trc:colormatrix=bt2020nc")
    flags="+write_colr$flags"
  else
    color=(-x265-params log-level=error)
  fi
  [ -z "$flags" ] || movflags=(-movflags "$flags")
  make "$file" -f lavfi -t "$t" -i "$(src "$size"),format=yuv420p10le$tag" -f lavfi -t "$t" -i "$AUDIO" -map 0:v -map 1:a \
    -c:v libx265 -preset superfast -b:v "$rate" -pix_fmt yuv420p10le -tag:v hvc1 "${color[@]}" -c:a aac -b:a 128k \
    "${TAGS[@]}" ${movflags[@]+"${movflags[@]}"}
}

if [ -n "$matrix" ]; then
  while read -r name codec size seconds transfer rate; do
    if [ "$codec" = h264 ]; then
      h264 "$name" "$seconds" "$size" "$rate" -movflags +faststart
    else
      hevc "$name" "$seconds" "$size" "$rate" "$transfer" +faststart
    fi
  done < <(jq -r '.fixtures[] | [.name, .codec, .size, .seconds, .transfer, .rate] | @tsv' "$matrix")
else
h264 sdr-h264.mp4 60 1920x1080 8M -movflags +faststart+use_metadata_tags
h264 near-cap.mp4 60 1920x1080 11500k -x264-params nal-hrd=cbr -movflags +faststart
hevc .work/hdr-plain.mov 60 1920x1080 6M arib-std-b67
make hdr-hevc-rotated.mov -display_rotation:v:0 90 -i .work/hdr-plain.mov -map 0 -c copy -movflags use_metadata_tags \
  -metadata com.apple.quicktime.location.ISO6709="$GPS" -metadata com.apple.quicktime.make=KOPJEMARK_MAKE -f mov
make vp9-90s.webm -f lavfi -t 90 -i "$(src 1920x1080)" -f lavfi -t 90 -i "$AUDIO" -c:v libvpx-vp9 -deadline realtime \
  -cpu-used 8 -row-mt 1 -b:v 4M -pix_fmt yuv420p -c:a libopus -b:a 128k "${TAGS[@]}"
hevc .work/hlg-plain.mov 30 3840x2160 20M arib-std-b67
make hlg-4k.mov -display_rotation:v:0 90 -i .work/hlg-plain.mov -map 0 -c copy -f mov
hevc pq-4k.mp4 30 3840x2160 20M smpte2084 +faststart
h264 sdr-1080p-5min.mp4 300 1920x1080 2M -movflags +faststart
h264 sdr-1080p-10min.mp4 600 1920x1080 1M -movflags +faststart
hevc sdr-4k-5min.mp4 300 3840x2160 2M sdr +faststart
hevc sdr-4k-10min.mp4 600 3840x2160 1M sdr +faststart
make tagged.m4a -f lavfi -t 60 -i "$AUDIO" -i .work/cover.png -map 0:a -map 1:v -c:a aac -b:a 192k -c:v png \
  -disposition:v attached_pic "${TAGS[@]}"
make tagged.flac -f lavfi -t 60 -i "$AUDIO" -i .work/cover.png -map 0:a -map 1:v -c:a flac -c:v png \
  -disposition:v attached_pic "${TAGS[@]}"
make tagged.ogg -f lavfi -t 60 -i "$AUDIO" -c:a libvorbis -q:a 5 "${TAGS[@]}"
fi

for f in "$out"/*.*; do
  size=$(wc -c <"$f")
  [ "$size" -le 94371840 ] || { echo "$(basename "$f") is $size bytes, over AV_UPLOAD_LIMIT" >&2; exit 1; }
  printf '%-22s %10d bytes\n' "$(basename "$f")" "$size"
done
