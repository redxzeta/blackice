# Log Explainer Service (Unified)

The Log Explainer endpoint is part of the main server process (`src/server.ts`).

## Run

```bash
PORT=3000 \
BLACKICE_CONFIG_FILE=./config/blackice.local.yaml \
npm start
```

## Endpoint

`POST /analyze/logs`
`POST /analyze/logs/batch`
`GET /analyze/logs/targets`
`GET /analyze/logs/status`
`GET /analyze/logs/metadata`

Request body:

```json
{
  "source": "journalctl",
  "target": "sshd.service",
  "hours": 6,
  "maxLines": 300
}
```

## Example curl request

```bash
curl -sS http://127.0.0.1:3000/analyze/logs \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "journalctl",
    "target": "sshd.service",
    "hours": 6,
    "maxLines": 300
  }'
```

```bash
curl -sS http://127.0.0.1:3000/analyze/logs/targets
```

```bash
curl -sS http://127.0.0.1:3000/analyze/logs/status
```

```bash
curl -sS http://127.0.0.1:3000/analyze/logs/metadata
```

```bash
curl -sS http://127.0.0.1:3000/analyze/logs/batch \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "loki",
    "filters": {
      "job": "journald",
      "host": "owonto",
      "unit": "blackice-router.service"
    },
    "mode": "both",
    "contains": "request_id=...",
    "regex": "status=(5..|4..)",
    "sinceSeconds": 900,
    "limit": 2000,
    "evidenceLines": 10
  }'
```

## Example JSON response

```json
{
  "analysis": "## Summary\nRepeated failed SSH authentication attempts were detected...\n\n## Key Findings\n- ..."
}
```

## Safety controls

- Uses only read-only collectors: `journalctl`, `docker logs`, and Loki query_range.
- Loki source is read-only via `/loki/api/v1/query_range`.
- Loki selectors are constructed internally from validated `filters` (raw `query` and selector strings are rejected).
- Loki/Ollama runtime config is loaded from `BLACKICE_CONFIG_FILE` YAML.
- No shell mode execution (`spawn` with `shell: false`).
- Command output byte caps are enforced.
- Loki guards: default 15-minute window, max window (default 60 minutes), max line cap, max response bytes, and scoped-label requirement (`host` or `unit`) unless `allowUnscoped: true`.
- LLM output is policy-checked; unsafe command-like content is redacted with a safety note.
- Batch `mode` supports `analyze` (analysis only), `raw` (evidence only, no model call), and `both` (analysis + evidence).
- Evidence excerpts are bounded via `evidenceLines` (max `50`; default `10` for `raw`/`both`).
- No file writes, no delete operations, no remediation commands.
- Ollama call has a request timeout.

## Loki Error Cases

- `400`: missing scope labels, invalid/reversed time range, or time window over max.
- `504`: Loki query timeout.
- `502`: Loki upstream error or malformed payload.

## OpenClaw

See `/Users/nsuarez/projects/blackice/OPENCLAW_LOG_EXPLAINER.md` for direct OpenClaw HTTP integration details.
See `/Users/nsuarez/projects/blackice/PHASE2_LXC_LOG_EXPOSURE_HANDOFF.md` for the multi-LXC rollout handoff plan.
