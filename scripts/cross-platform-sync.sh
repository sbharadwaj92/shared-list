#!/usr/bin/env bash
# Phase 9 cross-platform sync convergence harness.
#
# Drives the iOS CrossPlatformConvergenceTests suite and the Android
# CrossPlatformConvergenceTest suite against ONE running backend, in
# coordinated A/B pairs across all four PLAN.md L386 scenarios:
#
#   (a) A creates → B sees after ?since=
#   (b) A offline-mutates → reconnects → B sees result
#   (c) Concurrent edits resolve LWW consistently
#   (d) Tombstones flow correctly during 90-day window
#
# Each scenario is run in BOTH directions (iOS-A/Android-B AND
# Android-A/iOS-B) so any iOS↔Android wire-encoding asymmetry surfaces
# regardless of which platform encoded the change first.
#
# Why a shell harness instead of in-process pairing on each platform:
# PLAN.md L386's "two devices' sync engines provably converge" really
# is two processes, two ApiClient/TokenStore instances, two local
# stores. Same-process A+B could cheat with shared state. Different-
# platform pairs are what catch the wire-encoding bugs that bit Phase 7
# slice D (Foundation .iso8601 second-precision) and Phase 8
# (kotlinx.serialization Instant.toString zero-truncation). See each
# platform's CrossPlatformConvergence test file header for more.
#
# How to run:
#
#   1. Start the backend in a separate terminal:
#        cd backend && bun run dev
#      The harness will probe http://localhost:3000/health to confirm
#      it's reachable. Override with BACKEND_URL=... if needed.
#
#   2. From the repo root:
#        ./scripts/cross-platform-sync.sh
#
#   3. Or with overrides:
#        BACKEND_URL=http://localhost:3000 \
#        IOS_SIMULATOR='platform=iOS Simulator,name=iPhone 17 Pro Max' \
#        ./scripts/cross-platform-sync.sh
#
# What this script DOES NOT do:
#   - Boot the backend itself. The dev server lifecycle is owned by
#     `bun run dev`. Same convention as the per-platform integration
#     tests (see ios/SharedListTests/DrainerIntegrationTests.swift +
#     android/.../DrainerIntegrationTest.kt).
#   - Run as part of CI. PLAN.md L19 punted CI integration to Phase 19
#     polish; harness invocation is a "manual pre-merge" step until
#     then. Adds the same constraint Phase 7 slice D landed with.
#
# Exit codes:
#   0 — all scenarios passed in both directions
#   1 — backend unreachable (precondition failure)
#   2 — at least one scenario failed
#   3 — signup or login precondition failed (rate-limit, schema, etc.)
#   4 — internal harness logic error (missing env var, parse failure)

set -euo pipefail

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
# iOS uses URLSession which doesn't trust mkcert by default; HTTP
# loopback bypasses TLS for the local test process.
IOS_SIMULATOR="${IOS_SIMULATOR:-platform=iOS Simulator,name=iPhone 17 Pro Max}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$REPO_ROOT/ios"
ANDROID_DIR="$REPO_ROOT/android"

# Per-run unique user. Avoids cross-run collisions on the backend's
# users.email unique index without needing to TRUNCATE between runs.
RUN_ID="$(date +%s)-$$"
TEST_USER_EMAIL="cross-platform-${RUN_ID}@example.test"
TEST_USER_PASSWORD="harness-password-1234"

# Counters surfaced in the summary. Bumped per scenario.
SCENARIOS_RUN=0
SCENARIOS_PASSED=0
SCENARIOS_FAILED=0
FAILED_DETAIL=()

# ----------------------------------------------------------------------------
# Logging helpers
# ----------------------------------------------------------------------------

log()       { printf '[harness] %s\n' "$*" >&2; }
log_step()  { printf '\n========== %s ==========\n' "$*" >&2; }
log_error() { printf '[harness] ERROR: %s\n' "$*" >&2; }

# ----------------------------------------------------------------------------
# Preconditions
# ----------------------------------------------------------------------------

probe_backend() {
    log "probing backend at $BACKEND_URL/health"
    if ! curl -sSf "$BACKEND_URL/health" -o /dev/null; then
        log_error "backend not reachable at $BACKEND_URL"
        log_error "start the dev server with: cd backend && bun run dev"
        exit 1
    fi
    log "backend healthy"
}

signup_test_user() {
    log "signing up test user $TEST_USER_EMAIL"
    local body status
    body=$(curl -sS -o /tmp/signup-response.json -w '%{http_code}' \
        -X POST "$BACKEND_URL/auth/signup" \
        -H 'content-type: application/json' \
        -d "$(cat <<JSON
{"email":"$TEST_USER_EMAIL","password":"$TEST_USER_PASSWORD","displayName":"Cross-Platform Harness"}
JSON
)") || true
    status="$body"
    if [[ "$status" != "201" ]]; then
        log_error "signup failed with status $status — body:"
        cat /tmp/signup-response.json >&2
        log_error "(if 429: signup rate limit hit — wait an hour or restart bun run dev)"
        exit 3
    fi
    log "signup ok"
}

# ----------------------------------------------------------------------------
# Platform invocation primitives
#
# Each `run_<platform>` function takes a test method name + extra env
# vars, invokes the test runner, captures stdout to a temp file, and
# echoes parsed RESULT key=value pairs. The functions DO NOT exit on
# test failure — they let the caller decide how to interpret a failed
# pair (the observer's failure is the only one that matters; if A
# crashed mid-act, B will fail to find the row and we surface that).
# ----------------------------------------------------------------------------

# Run an iOS test method with the given env vars.
# Args: test_method role [extra_env_var=value ...]
# Output: parsed RESULT lines on stdout, full log on stderr.
# Returns: test runner's exit code.
run_ios() {
    local method="$1"; shift
    local role="$1"; shift
    local logfile="/tmp/cross-platform-ios-${method}-${role}.log"

    log "iOS  | role=$role | $method"

    # Build env vars to pass via xcodebuild's `-test-iterations` / test
    # plan mechanism. xcodebuild itself doesn't pass arbitrary env vars
    # to the test process directly; we use simctl to set them on the
    # booted simulator before running.
    local env_args=(
        "BACKEND_URL=$BACKEND_URL"
        "CROSS_PLATFORM_USER_EMAIL=$TEST_USER_EMAIL"
        "CROSS_PLATFORM_USER_PASSWORD=$TEST_USER_PASSWORD"
        "CROSS_PLATFORM_ROLE=$role"
    )
    # Append any extra vars the caller passed (e.g. CROSS_PLATFORM_LIST_ID).
    while (( $# > 0 )); do
        env_args+=("$1")
        shift
    done

    # Set the env vars on the booted simulator. Each invocation
    # overwrites the previous value (simctl spawn launchctl setenv).
    for kv in "${env_args[@]}"; do
        local key="${kv%%=*}"
        local value="${kv#*=}"
        xcrun simctl spawn booted launchctl setenv "$key" "$value" >/dev/null
    done

    # Run the specific test method. Don't fail-fast on test errors; the
    # caller parses stdout to decide what to do.
    #
    # Note: Swift Testing requires `()` trailing parens in the
    # -only-testing identifier (XCTest does not). Without them xcodebuild
    # silently runs zero tests and reports the suite as passed.
    local rc=0
    (
        cd "$IOS_DIR"
        xcodebuild test \
            -scheme SharedList \
            -destination "$IOS_SIMULATOR" \
            -only-testing "SharedListTests/CrossPlatformConvergenceTests/${method}()" \
            2>&1 | tee "$logfile" >/dev/null
    ) || rc=$?

    parse_results "$logfile"

    # Clean up sim env vars so a stale value doesn't bleed into the
    # next pair.
    for kv in "${env_args[@]}"; do
        local key="${kv%%=*}"
        xcrun simctl spawn booted launchctl unsetenv "$key" >/dev/null || true
    done

    return $rc
}

# Run an Android test method with the given env vars.
# Args: test_method role [extra_env_var=value ...]
run_android() {
    local method="$1"; shift
    local role="$1"; shift
    local logfile="/tmp/cross-platform-android-${method}-${role}.log"

    log "AND  | role=$role | $method"

    # Build the env-var prefix for the gradle invocation. Android
    # tests read `System.getenv(...)` directly so passing the env
    # through the shell environment is sufficient.
    local env_prefix=(
        "BACKEND_URL=$BACKEND_URL"
        "CROSS_PLATFORM_USER_EMAIL=$TEST_USER_EMAIL"
        "CROSS_PLATFORM_USER_PASSWORD=$TEST_USER_PASSWORD"
        "CROSS_PLATFORM_ROLE=$role"
    )
    while (( $# > 0 )); do
        env_prefix+=("$1")
        shift
    done

    local rc=0
    (
        cd "$ANDROID_DIR"
        env "${env_prefix[@]}" ./gradlew testDebugUnitTest \
            --tests "*CrossPlatformConvergenceTest.$method" \
            --rerun-tasks \
            2>&1 | tee "$logfile" >/dev/null
    ) || rc=$?

    # Gradle's default stdout swallows println from test code; the
    # actual stdout lives in the per-class JUnit XML at
    # <ANDROID_DIR>/app/build/test-results/testDebugUnitTest/TEST-*.xml
    # under the <system-out> CDATA. We extract from there instead of the
    # tee'd gradle log, then write the parsed RESULT lines into the log
    # file alongside it so parse_results sees them.
    local junit_xml="$ANDROID_DIR/app/build/test-results/testDebugUnitTest/TEST-in.santosh_bharadwaj.sharedlist.core.sync.CrossPlatformConvergenceTest.xml"
    if [[ -f "$junit_xml" ]]; then
        # Extract everything inside <system-out> CDATA — the awk pattern
        # walks state from the opening tag to the closing tag without
        # depending on a real XML parser (we only need RESULT lines).
        awk '/<system-out><!\[CDATA\[/{cap=1; sub(/.*<system-out><!\[CDATA\[/,""); print; next}
             /\]\]><\/system-out>/{cap=0; sub(/\]\]><\/system-out>.*/,""); print; next}
             cap{print}' "$junit_xml" >> "$logfile"
    fi

    parse_results "$logfile"
    return $rc
}

# Parse RESULT lines from a test log and emit them on stdout in
# `key=value` form so the caller can `eval` or grep.
parse_results() {
    local logfile="$1"
    grep -oE 'CROSS_PLATFORM_RESULT\[[A-Z_]+\]=[^[:space:]]*' "$logfile" \
        | sed -E 's/^CROSS_PLATFORM_RESULT\[([A-Z_]+)\]=(.*)$/\1=\2/'
}

# Pick a single result key from the most recent invocation's parse
# output. Caller passes the full parse_results output as the first
# arg, the key as the second.
get_result() {
    local raw="$1"
    local key="$2"
    echo "$raw" | grep -E "^${key}=" | tail -n1 | sed -E "s/^${key}=//"
}

# ----------------------------------------------------------------------------
# Scenario harness
# ----------------------------------------------------------------------------

# Scenario (a): A creates → B sees.
# act_platform: ios|android
# observe_platform: ios|android
scenario_a() {
    local act_platform="$1"
    local observe_platform="$2"
    SCENARIOS_RUN=$((SCENARIOS_RUN + 1))
    local label="(a) ${act_platform} creates → ${observe_platform} sees"
    log_step "scenario $label"

    local act_results observe_results
    act_results=$("run_${act_platform}" scenarioA_creatorCreatesList A)
    local list_id
    list_id=$(get_result "$act_results" LIST_ID)
    if [[ -z "$list_id" ]]; then
        log_error "scenario (a) creator did not emit LIST_ID"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — creator missing LIST_ID")
        return
    fi
    log "scenario (a) creator emitted LIST_ID=$list_id"

    observe_results=$("run_${observe_platform}" scenarioA_observerSeesList B \
        "CROSS_PLATFORM_LIST_ID=$list_id")
    local observed_present
    observed_present=$(get_result "$observe_results" OBSERVED_PRESENT)
    if [[ "$observed_present" == "true" ]]; then
        log "scenario $label PASS"
        SCENARIOS_PASSED=$((SCENARIOS_PASSED + 1))
    else
        log_error "scenario $label FAIL (OBSERVED_PRESENT=$observed_present)"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — observer did not see list")
    fi
}

# Scenario (b): A offline-mutates → reconnects → B sees the rename.
# Uses the seed step to get a fresh list, then invokes the creator on
# `act_platform` with offline-mutate semantics, then the observer on
# `observe_platform`.
scenario_b() {
    local act_platform="$1"
    local observe_platform="$2"
    SCENARIOS_RUN=$((SCENARIOS_RUN + 1))
    local label="(b) ${act_platform} offline-mutates → ${observe_platform} sees"
    log_step "scenario $label"

    # Seed a fresh list from the act_platform.
    local seed_results
    seed_results=$("run_${act_platform}" setup_seedFreshList A)
    local list_id
    list_id=$(get_result "$seed_results" LIST_ID)
    if [[ -z "$list_id" ]]; then
        log_error "scenario (b) seed did not emit LIST_ID"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — seed missing LIST_ID")
        return
    fi

    # Act: offline mutate + reconnect + drain.
    local act_results
    act_results=$("run_${act_platform}" scenarioB_creatorMutatesOfflineThenReconnects A \
        "CROSS_PLATFORM_LIST_ID=$list_id")
    local renamed_to
    renamed_to=$(get_result "$act_results" RENAMED_TO)
    if [[ -z "$renamed_to" ]]; then
        log_error "scenario (b) creator did not emit RENAMED_TO"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — creator missing RENAMED_TO")
        return
    fi

    # Observe: reconcile and assert the rename is visible.
    local observe_results
    observe_results=$("run_${observe_platform}" scenarioB_observerSeesRename B \
        "CROSS_PLATFORM_LIST_ID=$list_id" \
        "CROSS_PLATFORM_EXPECTED_NAME=$renamed_to")
    local observed_name
    observed_name=$(get_result "$observe_results" OBSERVED_NAME)
    if [[ "$observed_name" == "$renamed_to" ]]; then
        log "scenario $label PASS"
        SCENARIOS_PASSED=$((SCENARIOS_PASSED + 1))
    else
        log_error "scenario $label FAIL (expected '$renamed_to', got '$observed_name')"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — expected '$renamed_to', got '$observed_name'")
    fi
}

# Scenario (c): concurrent edits resolve LWW consistently.
# Both platforms rename the SAME list with their own name; the harness
# then reconciles both and asserts FINAL_NAME matches across the pair.
scenario_c() {
    local act_platform="$1"
    local observe_platform="$2"
    SCENARIOS_RUN=$((SCENARIOS_RUN + 1))
    local label="(c) ${act_platform} + ${observe_platform} concurrent edits"
    log_step "scenario $label"

    # Seed a fresh list from the act_platform.
    local seed_results
    seed_results=$("run_${act_platform}" setup_seedFreshList A)
    local list_id
    list_id=$(get_result "$seed_results" LIST_ID)
    if [[ -z "$list_id" ]]; then
        log_error "scenario (c) seed did not emit LIST_ID"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — seed missing LIST_ID")
        return
    fi

    # Three steps:
    #   1. act_platform renames + drains + reconciles (snapshots
    #      FINAL_NAME after its own write hits the server).
    #   2. observe_platform renames + drains + reconciles (its rename
    #      either lands clean OR hits 409 → reconcile → retry-once).
    #   3. act_platform does a reconcile-only pass to refresh its
    #      stale-after-step-2 local row.
    #
    # Convergence assertion: step 3's FINAL_NAME == step 2's FINAL_NAME.
    # Both platforms now see the same canonical row from the server.
    local act_results
    act_results=$("run_${act_platform}" scenarioC_creatorEditsThenDrains A \
        "CROSS_PLATFORM_LIST_ID=$list_id")
    local _act_initial_final
    _act_initial_final=$(get_result "$act_results" FINAL_NAME)

    local observe_results
    observe_results=$("run_${observe_platform}" scenarioC_observerEditsThenDrains B \
        "CROSS_PLATFORM_LIST_ID=$list_id")
    local observe_final
    observe_final=$(get_result "$observe_results" FINAL_NAME)

    # Step 3 — refresh the act platform's view.
    local act_refresh_results
    act_refresh_results=$("run_${act_platform}" scenarioC_reconcileOnly A \
        "CROSS_PLATFORM_LIST_ID=$list_id")
    local act_final
    act_final=$(get_result "$act_refresh_results" FINAL_NAME)

    if [[ -n "$observe_final" && "$observe_final" == "$act_final" ]]; then
        log "scenario $label PASS (both platforms converged on '$observe_final')"
        SCENARIOS_PASSED=$((SCENARIOS_PASSED + 1))
    else
        log_error "scenario $label FAIL (act_post_refresh='$act_final', observe='$observe_final')"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — act_post_refresh='$act_final', observe='$observe_final'")
    fi
}

# Scenario (d): tombstones flow during 90-day window.
scenario_d() {
    local act_platform="$1"
    local observe_platform="$2"
    SCENARIOS_RUN=$((SCENARIOS_RUN + 1))
    local label="(d) ${act_platform} deletes item → ${observe_platform} sees tombstone"
    log_step "scenario $label"

    local seed_results
    seed_results=$("run_${act_platform}" setup_seedFreshList A)
    local list_id
    list_id=$(get_result "$seed_results" LIST_ID)
    if [[ -z "$list_id" ]]; then
        log_error "scenario (d) seed did not emit LIST_ID"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — seed missing LIST_ID")
        return
    fi

    local act_results
    act_results=$("run_${act_platform}" scenarioD_creatorAddsThenDeletesItem A \
        "CROSS_PLATFORM_LIST_ID=$list_id")
    local item_id
    item_id=$(get_result "$act_results" ITEM_ID)
    if [[ -z "$item_id" ]]; then
        log_error "scenario (d) creator did not emit ITEM_ID"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — creator missing ITEM_ID")
        return
    fi

    local observe_results
    observe_results=$("run_${observe_platform}" scenarioD_observerSeesTombstone B \
        "CROSS_PLATFORM_LIST_ID=$list_id" \
        "CROSS_PLATFORM_ITEM_ID=$item_id")
    local observed_deleted
    observed_deleted=$(get_result "$observe_results" OBSERVED_DELETED)
    if [[ "$observed_deleted" == "true" ]]; then
        log "scenario $label PASS"
        SCENARIOS_PASSED=$((SCENARIOS_PASSED + 1))
    else
        log_error "scenario $label FAIL (OBSERVED_DELETED=$observed_deleted)"
        SCENARIOS_FAILED=$((SCENARIOS_FAILED + 1))
        FAILED_DETAIL+=("$label — observer didn't see tombstone")
    fi
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

main() {
    log_step "Phase 9 cross-platform sync convergence harness"
    log "BACKEND_URL=$BACKEND_URL"
    log "RUN_ID=$RUN_ID"
    log "TEST_USER_EMAIL=$TEST_USER_EMAIL"

    probe_backend
    signup_test_user

    # Each scenario in BOTH directions to fence in iOS↔Android encoding
    # asymmetry. 4 scenarios × 2 directions = 8 pairs, each pair does
    # one or two test invocations per platform.
    scenario_a ios     android
    scenario_a android ios

    scenario_b ios     android
    scenario_b android ios

    scenario_c ios     android
    scenario_c android ios

    scenario_d ios     android
    scenario_d android ios

    # Summary
    log_step "summary"
    log "scenarios run: $SCENARIOS_RUN"
    log "scenarios passed: $SCENARIOS_PASSED"
    log "scenarios failed: $SCENARIOS_FAILED"
    if (( SCENARIOS_FAILED > 0 )); then
        log_error "failures:"
        for entry in "${FAILED_DETAIL[@]}"; do
            log_error "  - $entry"
        done
        exit 2
    fi
    log "ALL CROSS-PLATFORM SCENARIOS PASSED"
    exit 0
}

main "$@"
