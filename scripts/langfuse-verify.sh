#!/usr/bin/env bash
#
# langfuse-verify.sh — static, config-level proof that the self-hosted Langfuse
# stack stays on this machine. It reads the RESOLVED compose config (defaults +
# any .env overrides applied) and asserts:
#
#   1. TELEMETRY_ENABLED is not "true"  (Langfuse's one documented phone-home).
#   2. No configured endpoint points off-machine — every scheme://host resolves
#      to localhost / 127.0.0.1 or an in-stack service name.
#   3. No SMTP relay is configured (email would leave the machine).
#   4. The worker + datastores sit on an `internal: true` network (no route out).
#
# This is HYGIENE, not a packet capture: it proves nothing egress-worthy is
# CONFIGURED, and that the sensitive services are structurally boxed in. To
# observe zero outbound at runtime, see ops/runbooks/langfuse-observability.md.
#
# Usage: make langfuse-verify   (or: bash scripts/langfuse-verify.sh)
set -euo pipefail

COMPOSE_FILE="docker-compose.langfuse.yml"
# Hosts that are, by definition, on this machine or inside the compose network.
ALLOWED_HOSTS="localhost 127.0.0.1 postgres clickhouse redis minio langfuse-web langfuse-worker"

fail=0
note() { printf '  %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fail=1; }
ok()   { printf '  ✓ %s\n' "$1"; }

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — cannot resolve the compose config." >&2
  exit 2
fi

resolved="$(docker compose -f "$COMPOSE_FILE" config)"

echo "Langfuse local-only verification ($COMPOSE_FILE)"
echo

# 1. Product telemetry must be off.
echo "[1/4] product telemetry"
tele="$(printf '%s\n' "$resolved" | grep -iE 'TELEMETRY_ENABLED:' | head -1 | sed 's/.*: *//; s/"//g' || true)"
if printf '%s' "$tele" | grep -qi 'true'; then
  bad "TELEMETRY_ENABLED is '$tele' — set it to false to stay local."
else
  ok "TELEMETRY_ENABLED=${tele:-unset} (no phone-home)."
fi

# 2. Every configured endpoint host must be local / in-stack.
echo "[2/4] endpoint hosts"
hosts="$(printf '%s\n' "$resolved" \
  | grep -oE '[a-zA-Z][a-zA-Z0-9+.-]*://[a-zA-Z0-9._-]+' \
  | sed -E 's#^[a-z0-9+.-]+://##' \
  | sort -u)"
if [ -z "$hosts" ]; then
  note "no scheme://host endpoints found."
else
  while IFS= read -r h; do
    [ -z "$h" ] && continue
    if printf '%s ' $ALLOWED_HOSTS | grep -qw "$h"; then
      ok "$h (local / in-stack)"
    else
      bad "$h — endpoint points off-machine."
    fi
  done <<< "$hosts"
fi

# 3. No SMTP relay (email leaves the box).
echo "[3/4] mail relay"
smtp="$(printf '%s\n' "$resolved" | grep -iE 'SMTP_CONNECTION_URL:' | head -1 | sed 's/.*: *//; s/"//g' || true)"
if [ -n "${smtp//null/}" ] && [ "$smtp" != "''" ]; then
  bad "SMTP_CONNECTION_URL is set ('$smtp') — mail would leave the machine."
else
  ok "no SMTP relay configured."
fi

# 4. Sensitive services must be on an internal (no-egress) network.
echo "[4/4] internal network isolation"
if printf '%s\n' "$resolved" | grep -qE 'internal: true'; then
  ok "an internal: true network is defined (worker + datastores have no route out)."
  for svc in langfuse-worker postgres clickhouse redis; do
    # Flag if a sensitive service is attached to the host-reachable edge network.
    if printf '%s\n' "$resolved" | awk -v s="  $svc:" '
        $0==s {inb=1; next}
        /^  [a-z]/ {inb=0}
        inb && /lf_edge/ {found=1}
        END {exit !found}'; then
      bad "$svc is attached to the edge (host-reachable) network — it should be internal-only."
    fi
  done
else
  bad "no internal: true network found — the worker/datastores are not boxed in."
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — nothing egress-worthy is configured; sensitive services are internal-only."
  echo "Note: this is a config audit. For a live-traffic check, see ops/runbooks/langfuse-observability.md."
else
  echo "FAIL — see the ✗ lines above."
fi
exit "$fail"
