# Langfuse observability for @Aida (fully local)

A self-hosted [Langfuse](https://langfuse.com) stack that gives the agentic
@Aida loop a visual trace UI — every step, tool call, `search_chat` argument and
result, token count, and latency — so you can *watch* the agent reason instead of
reading logs. It is **opt-in** and **runs entirely on this machine**: message
content never leaves the device, which is the project's hard privacy constraint.

- **Stack:** `docker-compose.langfuse.yml` (a separate `sumbox-langfuse` compose
  project — `make up` never touches it).
- **App wiring:** `src/observability/langfuse.ts` starts an OpenTelemetry
  exporter at collector startup, behind `LANGFUSE_ENABLED`. The Vercel AI SDK
  emits spans from `answerAgentic`; Langfuse renders them.

Only the **agentic** path is traced, so it also requires `ASK_AGENTIC=true`.

## Quickstart

```bash
make langfuse-up                     # boots the stack (first run pulls images, ~1-2 min)
# UI: http://localhost:3000   login: admin@sumbox.local / sumbox-local
```

Then in `.env` (values already match the stack's turnkey keys — see `.env.example`):

```bash
ASK_AGENTIC=true
LANGFUSE_ENABLED=true
LANGFUSE_BASEURL=http://localhost:3000
LANGFUSE_PUBLIC_KEY=pk-lf-sumbox-local
LANGFUSE_SECRET_KEY=sk-lf-sumbox-local
```

Restart the collector (`make dev-collect`), tag @Aida with a question in an
allowlisted group, and the trace shows up under the **aida** project.

Teardown: `make langfuse-down` (add `ARGS=-v` to also wipe the trace volumes).

## Why this is local, and how it's enforced

| Guarantee | Mechanism |
|---|---|
| No product phone-home | `TELEMETRY_ENABLED=false` on web + worker |
| Worker + datastores can't reach the internet | They sit **only** on the `lf_backend` network, declared `internal: true` (Docker gives it no route off the host) |
| App→Langfuse traffic stays on the box | Exporter points at `http://localhost:3000` |
| No mail relay | `SMTP_CONNECTION_URL` unset |

Only `langfuse-web` (:3000) and `minio` (:9090) also join the host-reachable
`lf_edge` bridge — a published port is unreachable on an internal-only network
(verified on Docker Desktop 29.x). Those two carry no telemetry.

### Config-level proof (static)

```bash
make langfuse-verify
```

Reads the **resolved** compose config and asserts telemetry is off, no endpoint
points off-machine, no SMTP relay is set, and the sensitive services are
internal-only. This is hygiene — it proves nothing egress-worthy is *configured*.

### Runtime proof (live — do this once after first boot)

The static check can't see actual packets. To confirm the boxed-in services
really have no route out, after `make langfuse-up`:

```bash
# 1. The backend network is internal (no gateway to the host/internet):
docker network inspect sumbox-langfuse_lf_backend -f '{{.Internal}}'      # → true

# 2. The worker + datastores are attached to ONLY that network:
for c in langfuse-worker postgres clickhouse redis; do
  printf '%s: ' "$c"
  docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
    "sumbox-langfuse-$c-1"
done
# each line should list only ...lf_backend

# 3. Prove egress is refused from inside the worker:
docker exec sumbox-langfuse-langfuse-worker-1 \
  sh -c 'wget -q -T 5 -O- http://1.1.1.1/ 2>&1 | head -c 40 || echo BLOCKED'
# → "can't connect" / BLOCKED
```

For the two edge services (`langfuse-web`, `minio`), which need a published port
and therefore a routable network, telemetry is disabled; if you want packet-level
assurance you can watch their traffic with a sidecar sharing their netns, e.g.
`docker run --rm --net container:sumbox-langfuse-langfuse-web-1 nicolaka/netshoot
tcpdump -n 'tcp and not (dst net 127.0.0.0/8 or dst net 172.16.0.0/12)'` while
using the UI (expect no external destinations).

## Sandbox: bulk-sample @Aida over real data (no sends)

`ask-sandbox` runs @Aida's **real agentic loop** against a real group's history
with tracing on, **sending nothing to WhatsApp** — so you can generate many
inspectable traces on demand. Read-only (`search_chat` only SELECTs; this path
never calls send/react). Needs a live Ollama + the Langfuse stack up +
`LANGFUSE_ENABLED=true`.

```bash
npm run dev -- groups                          # find a group id
npm run dev -- ask-sandbox --group 70          # runs the red-team probes (guardrails)
npm run dev -- ask-sandbox --group 70 --questions ops/my-questions.txt   # your own questions
```

- `--questions <file>` — one question per line, `#` comments ignored (see
  `ops/aida-sandbox-questions.example.txt`). Without it, the committed red-team
  probes run. Everyday questions exercise **retrieval/answer quality**; the
  red-team probes exercise the **refusal guardrails** (they mostly abstain
  without searching).
- Each run traces under `environment=sandbox`, session `sandbox:group:<id>`, with
  the question id as the trace `user` — filter on any of those in the UI. Answers
  also stream to the terminal.

## Notes

- **Secrets are local dev values on purpose** — the stack binds to localhost and
  holds only your own traces. Don't expose these ports; don't reuse the keys.
- **Traces include chat content** (the question and retrieved messages) — that's
  the point of the trace view, and it's consistent with the privacy rule because
  it stays in the on-device Langfuse. Wipe it any time with `make langfuse-down
  ARGS=-v`.
- The stack pulls Postgres, ClickHouse, Redis, MinIO, and two Langfuse images —
  a few hundred MB and real RAM. It's meant to be brought up while you're
  actively watching @Aida, then taken down.
