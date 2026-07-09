# Runbook: text-index collation corruption

**Symptom.** Message ingestion starts logging bursts of:

```
[collector] message handler error (web server continues)
  table tid from new index tuple (X,Y) overlaps with invalid duplicate tuple
  at offset N of block B in index "participants_tenant_idx"
```

(SQLSTATE **`XX002`**, `ERRCODE_INDEX_CORRUPTED`.) It can hit any btree over a
text column; `participants_tenant_idx` — `btree (tenant_id, display_name)` — is
the usual victim because every inbound message upserts a participant by
`(tenant_id, display_name)` (`src/db/repositories/participants.ts`), so a corrupt
index there breaks ingestion immediately.

## Root cause

The index isn't really "broken" — the **collation drifted under it**. Postgres
sorts `text` using the OS C library (glibc / ICU). When the Postgres container
image is rebuilt against a newer Debian/glibc/ICU, the collation order of some
strings changes. A btree built under the *old* order then looks internally
inconsistent to the *new* library, and amcheck/inserts report it as corrupt.

The trigger here was the **floating `pgvector/pgvector:pg16` tag** — it's rebuilt
in place, so a `docker compose pull` / image refresh could swap glibc under our
existing `pgdata` volume.

## Prevention (already in place)

`docker-compose.yml` pins the image **by digest**, not the floating tag:

```yaml
image: pgvector/pgvector:pg16@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc
```

A digest is immutable, so the OS libraries — and therefore the collation — can't
drift under our indexes between pulls.

## Detection

`sumbox doctor` runs an **amcheck** over every valid public btree index
(`checkIndexIntegrity` in `src/doctor/checks.ts`) and hard-fails with a REINDEX
hint if any index reports `XX002`. Run it whenever ingestion errors appear:

```bash
npm run dev -- doctor      # or: sumbox doctor
```

Manual equivalent:

```sql
CREATE EXTENSION IF NOT EXISTS amcheck;
SELECT bt_index_check('participants_tenant_idx'::regclass, true);
-- repeat for any text btree, or loop pg_index where amname='btree'
```

## Recovery

REINDEX rebuilds the index under the *current* collation. It does **not** lose
data — no wipe needed.

```sql
REINDEX INDEX participants_tenant_idx;   -- the specific corrupt index
-- or, if several text indexes drifted:
REINDEX DATABASE whatsapp_sum;
```

If duplicate rows were inserted *through* the corrupt window (the unique index
stopped enforcing), de-duplicate before/after the REINDEX — see the prior
`lid`/`pn` duplicate-merge incident for the pattern.

## Deliberately bumping the image later

1. Resolve the new digest: `docker manifest inspect pgvector/pgvector:pg16`.
2. Update the `@sha256:…` pin in `docker-compose.yml`.
3. `docker compose up -d postgres`, then `REINDEX DATABASE whatsapp_sum` (or run
   `sumbox doctor` and REINDEX whatever it flags).
