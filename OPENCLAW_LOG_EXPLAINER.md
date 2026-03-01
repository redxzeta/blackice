# OpenClaw Integration: Log Explainer

Use the Log Explainer as an HTTP endpoint from OpenClaw.

## Endpoint

- Method: `POST`
- URL: `http://192.168.1.130:3000/analyze/logs`
- Headers: `Content-Type: application/json`

Target discovery endpoint:
- Method: `GET`
- URL: `http://192.168.1.130:3000/analyze/logs/targets`
- Purpose: Returns an empty placeholder list in Loki-only mode (structured discovery metadata tracked in issue #48).

Capability/status endpoint:
- Method: `GET`
- URL: `http://192.168.1.130:3000/analyze/logs/status`
- Purpose: Returns available endpoints, limits, approved targets count/list, and LLM runtime metadata.

Bootstrap metadata endpoint:
- Method: `GET`
- URL: `http://192.168.1.130:3000/analyze/logs/metadata`
- Purpose: Machine-readable endpoint docs and JSON response schemas for OpenClaw self-discovery.

Batch analysis endpoint:
- Method: `POST`
- URL: `http://192.168.1.130:3000/analyze/logs/batch`
- Purpose: Analyze Loki or journald logs in one request.

## Request Schema

```json
{
  "source": "journalctl | docker",
  "target": "string",
  "hours": 6,
  "maxLines": 300
}
```

## Example OpenClaw HTTP action body

```json
{
  "source": "journalctl",
  "target": "sshd.service",
  "hours": 6,
  "maxLines": 300
}
```

## Example Response

```json
{
  "analysis": "## Summary\n..."
}
```

Example Loki batch request (structured filters):
```json
{
  "source": "loki",
  "filters": {
    "host": "owonto",
    "unit": "blackice-router.service",
    "job": "journald"
  },
  "contains": "request_id=...",
  "start": "2026-03-01T04:00:00Z",
  "end": "2026-03-01T04:15:00Z",
  "limit": 2000
}
```

Example batch response shape:
```json
{
  "source": "loki",
  "requestedTargets": 1,
  "analyzedTargets": 1,
  "ok": 1,
  "failed": 0,
  "results": [
    {
      "target": "{host=\"owonto\",job=\"journald\",unit=\"blackice-router.service\"} |= \"request_id=...\"",
      "ok": true,
      "analysis": "## Summary\n..."
    }
  ]
}
```

## Notes

- For `source: "loki"`, at least one scoping label (`host` or `unit`) is required unless `allowUnscoped: true`.
- For `source: "loki"`, provide `filters`; raw LogQL `query` and selector strings are rejected.
- For `source: "loki"`, allowlist rules are loaded from `LOKI_RULES_FILE` YAML.
- For `source: "loki"`, default time window is last 15 minutes if `start`/`end` are omitted.
- For `source: "loki"`, max time window is controlled by `LOKI_MAX_WINDOW_MINUTES` (default 60).
- The service enforces read-only safety; unsafe command-like output is redacted before response.
- This endpoint is separate from `/v1/chat/completions`; call it as a direct HTTP integration.

Loki-specific error behaviors:
- `400` invalid scope/time-window/query guardrails
- `504` Loki timeout
- `502` Loki upstream query error
