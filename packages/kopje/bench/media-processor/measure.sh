#!/usr/bin/env bash
# Measures the media processor against a deployed bench (worker.ts) for P27 (design #1828): normalize on each instance
# type and ffmpeg threading option over every fixture, stills on standard-1, and the stages the allocation is made of.
#
#   BENCH_URL=https://kopje-media-bench.<subdomain>.workers.dev BENCH_TOKEN=... \
#     bash packages/kopje/bench/media-processor/measure.sh <fixtures dir>
#
# Optional:
#   INSTANCES="standard-3 standard-4"        the types normalize runs on
#   THREADS="ffmpeg filters:4 all:4"         MEDIASRV_THREADS values (container/server/args.go parseThreading; default
#                                            is Kopje's, all:4)
#   RUNS=3        normalize runs per fixture, type and threading (9 for the chosen type's p95, G13)
#   STILL_RUNS=9  still runs per video fixture on standard-1
#   DISPATCH_RUNS=20, HOLD="90 110 130"     the alarm dispatch samples, and the header holds tried (seconds)
#   FIXTURES="..."   the files of <fixtures dir> to run (default: every file fixtures.sh makes there)
#   SKIP_UPLOAD=1    the fixtures are in the bucket already
#   MATRIX=1         the boundary matrix instead (#1828 PR2, A3; fixtures.sh --matrix): on standard-4 with all:4 only,
#                    each matrix.json fixture normalized at each endpoint it lists, with the encode time that endpoint
#                    leaves passed as encode_ms (the endpoint's seconds less the assumed ingress, the input streaming,
#                    design 4.7's starting stage times and v1's reply), and the verdict expected there (admitted, or
#                    refused at the probe for the envelope). No stills, dispatch or holds.
#   MATRIX_EXTRA="clip.mp4 ..."   files of <fixtures dir> run at every endpoint too, with no verdict expected (the
#                    real camera clips)
#
# Writes bench-media-<time>/results.jsonl (one line per run) and results.md (report.mjs): per fixture, type and
# threading the runs that succeeded end to end out of all, and over those only the wall p95, encode p95, ffmpeg's CPU
# seconds and utilisation (ffmpeg's CPU time over the encode's wall time, measured in the container), and the stage
# p95s; with MATRIX=1, per run the server's estimate against its encode time (report.mjs matrix). Billed usage per fixture, type and threading comes from billing.sh, which joins it to these runs by run id; the
# script prints its command at the end. Needs curl, jq and node.
set -euo pipefail

: "${BENCH_URL:?set BENCH_URL}" "${BENCH_TOKEN:?set BENCH_TOKEN}"
dir="$(cd "${1:?usage: measure.sh <fixtures dir>}" && pwd)"
BENCH_URL="${BENCH_URL%/}"
INSTANCES="${INSTANCES:-standard-3 standard-4}"
THREADS="${THREADS:-ffmpeg filters:4 all:4}"
RUNS="${RUNS:-3}"
STILL_RUNS="${STILL_RUNS:-9}"
DISPATCH_RUNS="${DISPATCH_RUNS:-20}"
HOLD="${HOLD:-90 110 130}"
matrix_file="$(dirname "$0")/matrix.json"
# The matrix's rows: fixture, endpoint, encode_ms, expected verdict.
matrix_rows() {
  jq -r --arg extra "${MATRIX_EXTRA:-}" '
    (.stages | .dispatch + .start + .probe + .still + .commit) as $fixed | .stages.input as $input | .endpoints as $e
    | def encode($n): (($e[$n].seconds - $e[$n].ingress - $input - $fixed - $e[$n].reply) * 1000 | round);
      (.fixtures[] | .name as $f | .expect | to_entries[] | [$f, .key, encode(.key), .value]),
      ($extra | split(" ")[] | select(. != "") as $f | $e | keys[] | [$f, ., encode(.), "measured"])
    | @tsv' "$matrix_file"
}
if [ -n "${MATRIX:-}" ]; then
  FIXTURES="$(matrix_rows | cut -f1 | sort -u | tr '\n' ' ')"
fi
FIXTURES="${FIXTURES:-sdr-h264.mp4 hdr-hevc-rotated.mov vp9-90s.webm near-cap.mp4 hlg-4k.mov pq-4k.mp4 sdr-1080p-5min.mp4 sdr-1080p-10min.mp4 sdr-4k-5min.mp4 sdr-4k-10min.mp4 tagged.m4a tagged.flac tagged.ogg}"

out="bench-media-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
jsonl="$out/results.jsonl"
: >"$jsonl"
start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
auth=(-H "Authorization: Bearer $BENCH_TOKEN")
api() { curl -sS --fail-with-body "${auth[@]}" "$@"; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

for f in $FIXTURES; do
  [ -f "$dir/$f" ] || { echo "missing $dir/$f (fixtures.sh)" >&2; exit 1; }
done

# Ingress: each fixture streamed into R2 through the Worker, as an upload's body is.
if [ -z "${SKIP_UPLOAD:-}" ]; then
  for f in $FIXTURES; do
    t0=$(date +%s)
    r="$(api -H 'Expect:' -T "$dir/$f" "$BENCH_URL/object/fixtures/$f")"
    jq -c --arg f "$f" --argjson client "$(($(date +%s) - t0))" '{kind: "ingress", fixture: $f, bytes, ingressMs, clientS: $client}' <<<"$r" >>"$jsonl"
    log "uploaded $f: $(jq -r '"\(.bytes) bytes, R2 put \(.ingressMs) ms"' <<<"$r")"
  done
fi

# A fixture's kind, which the bench checks the server's answer against (never the answer's own Kopje-Kind).
expect_of() { case $1 in *.m4a | *.flac | *.ogg | *.mp3 | *.wav | *.opus) echo audio ;; *) echo video ;; esac; }

run() { # <op> <fixture> <instance> <threads> [<encode ms> <endpoint> <expected verdict>]
  local r expect query
  expect="$(expect_of "$2")"
  query="op=$1&key=fixtures/$2&expect=$expect&instance=$3&threads=$4"
  [ -z "${5:-}" ] || query="$query&encode_ms=$5"
  r="$(api -X POST "$BENCH_URL/run?$query" || true)"
  jq -e 'type == "object"' <<<"$r" >/dev/null 2>&1 || r='{"error":"request failed"}'
  # The driver's own fields: a run that failed before the bench answered still counts in its group, as a failure.
  jq -c --arg op "$1" --arg f "$2" --arg e "$expect" --arg i "$3" --arg t "$4" --arg ms "${5:-}" --arg ep "${6:-}" \
    --arg v "${7:-}" '. + {kind: "run", op: $op, fixture: $f, expect: $e, instance: $i, threads: $t}
      + (if $ep == "" then {} else {matrix: {endpoint: $ep, encodeMs: ($ms | tonumber), expectVerdict: $v}} end)' \
    <<<"$r" >>"$jsonl"
  log "$(jq -r '"\(.op) \(.fixture) \(.instance) \(.threads): ok \(.ok // false) status \(.status) wall \(.wallMs) ms ready \(.startToReadyMs) encode \(.server.encode // "-") cpu \(.server["encode-cpu"] // "-") \(.error // "")"' <<<"$(tail -1 "$jsonl")")"
}

if [ -n "${MATRIX:-}" ]; then
  while IFS=$'\t' read -r f endpoint encode verdict; do
    for _ in $(seq 1 "$RUNS"); do run normalize "$f" standard-4 all:4 "$encode" "$endpoint" "$verdict"; done
  done < <(matrix_rows)
  DISPATCH_RUNS=0 HOLD=""
else
  for f in $FIXTURES; do
    for inst in $INSTANCES; do
      for th in $THREADS; do
        for _ in $(seq 1 "$RUNS"); do run normalize "$f" "$inst" "$th"; done
      done
    done
    if [ "$(expect_of "$f")" = video ]; then
      for _ in $(seq 1 "$STILL_RUNS"); do run still "$f" standard-1 default; done
    fi
  done
fi

for _ in $(seq 1 "$DISPATCH_RUNS"); do
  [ "$DISPATCH_RUNS" -gt 0 ] || break
  api -X POST "$BENCH_URL/dispatch" | jq -c '{kind: "dispatch"} + .' >>"$jsonl"
done

# F1: whether a response whose headers wait past 100 s still reaches the client (Cloudflare's 524 would end it).
for s in $HOLD; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time $((s + 60)) "${auth[@]}" "$BENCH_URL/hold?seconds=$s" || true)"
  jq -nc --argjson s "$s" --arg code "$code" '{kind: "hold", seconds: $s, status: $code}' >>"$jsonl"
  log "held headers $s s: HTTP $code"
done
end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

{
  echo "# Media processor bench ($start to $end)"
  echo
  echo "Target $BENCH_URL. Times in seconds; p95 by nearest rank, over the runs that succeeded end to end (ok/runs)."
  echo "Utilisation is ffmpeg's CPU time over the encode's wall time inside the container (2.0 is two busy vCPUs)."
  echo "Raw: results.jsonl."
  echo
  node "$(dirname "$0")/report.mjs" "$jsonl"
  echo
  echo "Not measured here: the Store's completion and the v1 reply (PR4's upload path)."
} >"$out/results.md"
cat "$out/results.md"
echo
echo "Billed usage of this run, per fixture, instance type and threading (Account Analytics: Read):"
echo "  CF_ACCOUNT_ID=... CF_API_TOKEN=... START=$start END=$end RESULTS=$jsonl bash $(dirname "$0")/billing.sh"
