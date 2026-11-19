#!/usr/bin/env bash
# Runs the vitest suites a change can affect: Kopje's code suites (workerd and streaming), its Node suite, the checks
# of its TLA+ specification, or none.
#
#   scripts/test-affected.sh suites < paths   prints kopje=, kopje_code= and kopje_spec=<bool> for the changed paths
#   scripts/test-affected.sh [vitest args]     runs the affected suites
#
# The second form takes KOPJE, KOPJE_CODE and KOPJE_SPEC from the environment when CI has already decided, and
# otherwise compares the working tree with its merge base on origin/main. Paths outside the package (the lockfile, root
# config, workflows) affect every suite, and so does an empty list; of them, only the dependencies and the test
# configuration affect the specification's checks (below). The Kopje instance template (deploy/) counts as Kopje.
# Callers list paths with --no-renames, so a move names both its source and its destination.
#
# Markdown counts as what reads it. Kopje's is read only by its Node suite (test-node/), so a Kopje change that is
# all Markdown sets kopje_code=false and runs only that suite, except the OAuth scope table that test/vectors.test.ts
# imports. Markdown outside the package affects no suite.
#
# The specification's checks (kopje-spec, vitest.spec.config.ts, about 5 minutes) read only the specification, its
# fixtures and drift record, the files that run and compare them, the dependencies and the test configuration, so only
# a change to one of those sets kopje_spec=true.
set -euo pipefail

suites() {
	local kopje=false kopje_code=false kopje_spec=false seen=false path
	while IFS= read -r path || [ -n "$path" ]; do
		[ -n "$path" ] || continue
		seen=true
		case $path in
			packages/kopje/docs/mastodon-api-spec/client-api/auth-oauth.md) kopje=true kopje_code=true ;;
			packages/kopje/*.md | deploy/*.md) kopje=true ;;
			*.md) ;;
			*) kopje=true kopje_code=true ;;
		esac
		case $path in
			packages/kopje/spec/* | packages/kopje/test/fixtures/collection-consent/* | \
				packages/kopje/test-node/collection-consent-spec.test.ts | \
				packages/kopje/test-node/collection-consent-fixtures.ts | packages/kopje/scripts/collection-consent-plan.mjs | \
				packages/kopje/test/collection-consent-observe.ts | packages/kopje/test/collection-consent-replay.test.ts | \
				package.json | packages/kopje/package.json | pnpm-lock.yaml | pnpm-workspace.yaml | mise.toml | mise.lock | \
				vitest.config.ts | packages/kopje/vitest.spec.config.ts | scripts/test-affected.sh | .github/workflows/ci.yml)
				kopje_spec=true
				;;
		esac
	done
	if [ "$seen" = false ]; then
		kopje=true kopje_code=true kopje_spec=true
	fi
	printf 'kopje=%s\nkopje_code=%s\nkopje_spec=%s\n' "$kopje" "$kopje_code" "$kopje_spec"
}

if [ "${1:-}" = suites ]; then
	suites
	exit 0
fi

if [ -z "${KOPJE:-}" ]; then
	if base=$(git merge-base origin/main HEAD 2>/dev/null); then
		result=$(git diff --no-renames --name-only "$base" | suites)
	else
		result=$(suites < /dev/null)
	fi
	KOPJE=$(sed -n 's/^kopje=//p' <<< "$result")
	KOPJE_CODE=$(sed -n 's/^kopje_code=//p' <<< "$result")
	KOPJE_SPEC=$(sed -n 's/^kopje_spec=//p' <<< "$result")
fi
# A caller that decides only KOPJE (the release workflow) runs all of Kopje's suites.
KOPJE_CODE=${KOPJE_CODE:-$KOPJE}
KOPJE_SPEC=${KOPJE_SPEC:-$KOPJE}

projects=()
if [ "$KOPJE" = true ]; then
	if [ "$KOPJE_CODE" = true ]; then
		projects+=(--project kopje --project kopje-streaming --project kopje-main-runtime)
	fi
	projects+=(--project kopje-cli)
	if [ "$KOPJE_SPEC" = true ]; then
		projects+=(--project kopje-spec)
	fi
fi
echo "test-affected: kopje=$KOPJE kopje_code=$KOPJE_CODE kopje_spec=$KOPJE_SPEC" >&2
if [ ${#projects[@]} -eq 0 ]; then
	echo 'test-affected: no suite reads the changed paths' >&2
	exit 0
fi

exec pnpm run test "${projects[@]}" "$@"
