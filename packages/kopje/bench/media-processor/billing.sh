#!/usr/bin/env bash
# The bench's billed container usage between START and END, per fixture, operation, instance type and threading,
# priced at list rates before the Workers Paid allowance (report.mjs). Read-only. The usage is grouped by each
# container's `run` label and joined to the run of that id in RESULTS (measure.sh's results.jsonl), so each fixture is
# priced on its own runs; usage of a run not in RESULTS is listed apart. The usage groups are written beside RESULTS
# as usage.json.
#
#   CF_ACCOUNT_ID=... CF_API_TOKEN=... START=<RFC 3339> END=<RFC 3339> RESULTS=<results.jsonl> bash billing.sh
#
# The token needs Account, Account Analytics, Read. Billed utilisation is vCPU-s over the runs' wall time
# (results.jsonl); the measure script prints the window. Needs curl, jq and node.
set -euo pipefail
: "${CF_ACCOUNT_ID:?}" "${CF_API_TOKEN:?}" "${START:?}" "${END:?}" "${RESULTS:?}"
query='query Usage($accountTag: String, $start: Time, $end: Time) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    usage: containersUsageAdaptiveGroups(limit: 1000,
      filter: { datetime_geq: $start, datetime_leq: $end, labels_has: "app=kopje-media-bench" }) {
      dimensions { run: label(name: "run") }
      sum { cpuTimeSec allocatedMemory allocatedDisk }
    }
  } }
}'
usage="$(dirname "$RESULTS")/usage.json"
jq -n --arg q "$query" --arg a "$CF_ACCOUNT_ID" --arg s "$START" --arg e "$END" \
  '{query: $q, variables: {accountTag: $a, start: $s, end: $e}}' |
  curl -sS https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $CF_API_TOKEN" \
    -H 'Content-Type: application/json' --data @- |
  jq '
    if .errors != null then (.errors | tostring | halt_error(1)) else . end
    | [.data.viewer.accounts[0].usage[] | {run: .dimensions.run} + .sum]
    | if length >= 1000 then ("1000 usage groups: narrow the window\n" | halt_error(1)) else . end' >"$usage"
node "$(dirname "$0")/report.mjs" "$RESULTS" "$usage"
