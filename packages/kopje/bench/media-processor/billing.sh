#!/usr/bin/env bash
# The bench's billed container usage between START and END, per instance type and threading label, priced at list
# rates before the Workers Paid allowance (https://developers.cloudflare.com/containers/platform/pricing/). Read-only.
#
#   CF_ACCOUNT_ID=... CF_API_TOKEN=... START=<RFC 3339> END=<RFC 3339> bash billing.sh
#
# The token needs Account, Account Analytics, Read. Billed utilisation is vCPU-s over the runs' wall time
# (results.jsonl); the measure script prints the window.
set -euo pipefail
: "${CF_ACCOUNT_ID:?}" "${CF_API_TOKEN:?}" "${START:?}" "${END:?}"
query='query Usage($accountTag: String, $start: Time, $end: Time) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    usage: containersUsageAdaptiveGroups(limit: 1000,
      filter: { datetime_geq: $start, datetime_leq: $end, labels_has: "app=kopje-media-bench" }) {
      dimensions { instance: label(name: "instance") threads: label(name: "threads") op: label(name: "op") }
      sum { cpuTimeSec allocatedMemory allocatedDisk }
    }
  } }
}'
jq -n --arg q "$query" --arg a "$CF_ACCOUNT_ID" --arg s "$START" --arg e "$END" \
  '{query: $q, variables: {accountTag: $a, start: $s, end: $e}}' |
  curl -sS https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $CF_API_TOKEN" \
    -H 'Content-Type: application/json' --data @- |
  jq -r '
    if .errors != null then (.errors | tostring | halt_error(1)) else . end
    | .data.viewer.accounts[0].usage[]
    | (.sum.cpuTimeSec) as $cpu | (.sum.allocatedMemory / 1073741824) as $gibs | (.sum.allocatedDisk / 1e9) as $gbs
    | "\(.dimensions.op) \(.dimensions.instance) \(.dimensions.threads): \($cpu * 10 | round / 10) vCPU-s, \($gibs | round) GiB-s, \($gbs | round) GB-s, $\(($cpu * 0.00002 + $gibs * 0.0000025 + $gbs * 0.00000007) * 10000 | round / 10000) at list price"'
