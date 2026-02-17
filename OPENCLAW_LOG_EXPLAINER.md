# OpenClaw Integration: Log Explainer

Use the Log Explainer as an HTTP endpoint from OpenClaw.

## Endpoint

- Method: `POST`
- URL: `http://192.168.1.130:3000/analyze/logs`
- Headers: `Content-Type: application/json`

Target discovery endpoint:
- Method: `GET`
- URL: `http://192.168.1.130:3000/analyze/logs/targets`
- Purpose: Returns currently approved file targets from `ALLOWED_LOG_FILES`.

Capability/status endpoint:
- Method: `GET`
- URL: `http://192.168.1.130:3000/analyze/logs/status`
- Purpose: Returns available endpoints, limits, approved targets count/list, and LLM runtime metadata.

Bootstrap metadata endpoint:
- Method: `GET`
- URL: `http://192.168.1.130:3000/analyze/logs/metadata`
- Purpose: Machine-readable endpoint docs and JSON response schemas for OpenClaw self-discovery.

Incremental analysis endpoint:
- Method: `POST`
- URL: `http://192.168.1.130:3000/analyze/logs/incremental`
- Purpose: Analyze only newly appended log data since a previous `cursor` and return `nextCursor`.

Batch analysis endpoint:
- Method: `POST`
- URL: `http://192.168.1.130:3000/analyze/logs/batch`
- Purpose: Analyze all approved targets (or a provided subset) in one request.

## Request Schema

```json
{
  "source": "journalctl | docker | file",
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

Example target discovery response:
```json
{
  "targets": [
    "/var/log/remote/paperless-ngx.log",
    "/var/log/remote/jellyfin.log"
  ]
}
```

Example batch request:
```json
{
  "source": "file",
  "hours": 6,
  "maxLines": 300,
  "concurrency": 2
}
```

Example incremental request:
```json
{
  "source": "file",
  "target": "/var/log/remote/paperless-ngx.log",
  "cursor": 0,
  "hours": 6,
  "maxLines": 300
}
```

Example incremental response shape:
```json
{
  "source": "file",
  "target": "/var/log/remote/paperless-ngx.log",
  "cursor": 0,
  "fromCursor": 0,
  "nextCursor": 8342,
  "rotated": false,
  "truncatedByBytes": false,
  "noNewLogs": false,
  "analysis": "## Summary\n..."
}
```

Example batch response shape:
```json
{
  "source": "file",
  "requestedTargets": 8,
  "analyzedTargets": 8,
  "ok": 7,
  "failed": 1,
  "results": [
    {
      "target": "/var/log/remote/paperless-ngx.log",
      "ok": true,
      "analysis": "## Summary\n..."
    },
    {
      "target": "/var/log/remote/docker.log",
      "ok": false,
      "error": "No logs were collected for the given query",
      "status": 422
    }
  ]
}
```

## Notes

- For `source: "file"`, target must be listed in `ALLOWED_LOG_FILES`.
- The service enforces read-only safety; unsafe command-like output is redacted before response.
- This endpoint is separate from `/v1/chat/completions`; call it as a direct HTTP integration.
