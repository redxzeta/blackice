# Production Deployment And Rollback Runbook

This runbook is for a single operator-controlled BlackIce deployment. It assumes Node.js and pnpm are installed on the target host and that the deployment runs from a clean git checkout.

## Pre-Deploy Checks

1. Confirm the target commit:
   ```bash
   git fetch origin main --tags
   git checkout origin/main
   git rev-parse HEAD
   ```

2. Install dependencies and build:
   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   ```

3. Select the production config file:
   ```bash
   export BLACKICE_RUNTIME_ENV=production
   export BLACKICE_CONFIG_FILE=./config/blackice.prod.yaml
   ```

4. Verify the selected YAML has explicit durable execution storage:
   ```yaml
   execution:
     accountId: prod-account
     defaultVenue: paper
     allowedVenues: [paper]
     storageKind: file
     storagePath: /var/lib/blackice/execution-state.json
     geofenceAllowed: true
     complianceAllowed: true
   ```

5. Ensure the storage parent exists and is writable by the service user:
   ```bash
   sudo mkdir -p /var/lib/blackice
   sudo chown "$USER":"$USER" /var/lib/blackice
   ```

## Required Secrets And Env

Production startup intentionally fails without these settings:

```bash
export BLACKICE_RUNTIME_ENV=production
export BLACKICE_CONFIG_FILE=./config/blackice.prod.yaml
export API_TOKEN='<set-a-strong-token>'
export AUTH_EXEMPT_PATHS=/healthz,/readyz,/version
export METRICS_ENABLED=1
export METRICS_EXPOSE_PATH=/metrics
export MODEL_PREFLIGHT_ON_START=1
export MODEL_PREFLIGHT_TIMEOUT_MS=2000
export BLACKICE_EXECUTION_SIGNER_REF='<set-signer-ref>'
export BLACKICE_EXECUTION_SIGNING_SECRET='<set-signing-secret>'
```

Do not put secret values in logs, shell history, PRs, or runbook examples. Use the host secret manager or service manager environment file where available.

## Deploy

Run a foreground deployment smoke first when possible:

```bash
pnpm start
```

Expected startup behavior:
- Invalid production config fails fast before the server accepts traffic.
- `/readyz` returns `503` when strict readiness is enabled and Ollama or durable execution storage is unavailable.
- `/healthz` and `/version` stay available without auth when `AUTH_EXEMPT_PATHS=/healthz,/readyz,/version`.

If the service is managed by systemd, supervisor, Docker, or another process manager, use the equivalent restart command after the same environment variables and config file are installed.

## Smoke Test

Run the production smoke harness against the deployed URL:

```bash
BLACKICE_BASE_URL='https://<deployment-host>' \
BLACKICE_API_TOKEN="$API_TOKEN" \
BLACKICE_SMOKE_VENUE=paper \
pnpm run smoke:prod
```

The smoke harness checks `/healthz`, `/readyz`, `/version`, `/metrics`, `/v1/models/check`, `/v1/execution-readiness`, and the paper-mode intent create, preflight, confirm, execute, refresh, and history flow. It exits non-zero and prints the failed step name when a check fails.

Non-paper smoke tests are blocked by default. Only override this for an intentionally prepared environment:

```bash
BLACKICE_SMOKE_ALLOW_NON_PAPER=1 BLACKICE_SMOKE_VENUE='<venue>' pnpm run smoke:prod
```

## Readiness And Metrics

Readiness:
- `GET /healthz` proves the HTTP process is alive.
- `GET /version` returns build/version metadata.
- `GET /readyz` verifies Ollama model access and execution storage access; with strict readiness, failures return `503`.
- `GET /v1/execution-readiness` verifies account, venue, signer, credential, geofence, and compliance readiness for execution callers; failures return `503` with `blockReasons`.

Prometheus metrics:
- `blackice_http_requests_total`
- `blackice_http_request_duration_ms`
- `blackice_inflight_requests`
- `llm_request_total`
- `llm_request_latency_seconds`
- `blackice_preflight_total`
- `blackice_execution_lifecycle_total`
- `blackice_repository_errors_total`

Metric labels are intentionally bounded. Do not add request IDs, user text, intent IDs, market IDs, or other high-cardinality values to alert rules.

## Rollback

1. Select the previous known-good tag or commit:
   ```bash
   git fetch origin main --tags
   git checkout <previous-good-tag-or-sha>
   ```

2. Reinstall and rebuild:
   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   ```

3. Restart with the same production env and config:
   ```bash
   BLACKICE_RUNTIME_ENV=production \
   BLACKICE_CONFIG_FILE=./config/blackice.prod.yaml \
   API_TOKEN="$API_TOKEN" \
   AUTH_EXEMPT_PATHS=/healthz,/readyz,/version \
   pnpm start
   ```

4. Rerun the smoke harness:
   ```bash
   BLACKICE_BASE_URL='https://<deployment-host>' \
   BLACKICE_API_TOKEN="$API_TOKEN" \
   BLACKICE_SMOKE_VENUE=paper \
   pnpm run smoke:prod
   ```

## Incident Checklist

1. Check process health with `/healthz` and version drift with `/version`.
2. Check `/readyz` for Ollama or execution storage degradation.
3. Check `blackice_repository_errors_total` for storage read/write/readiness failures.
4. Check `blackice_preflight_total` and `blackice_execution_lifecycle_total` for blocked execution spikes.
5. Check `llm_request_total` and `llm_request_latency_seconds` for model failures or latency regressions.
6. If smoke fails, use the failed step name to isolate the route or lifecycle stage.
7. If rollback is needed, use the rollback procedure above and keep the durable storage file intact unless corruption is confirmed.
