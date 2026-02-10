# OpenClaw Integration: Log Explainer

Use the Log Explainer as an HTTP endpoint from OpenClaw.

## Endpoint

- Method: `POST`
- URL: `http://192.168.1.130:3000/analyze/logs`
- Headers: `Content-Type: application/json`

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

## Notes

- For `source: "file"`, target must be listed in `ALLOWED_LOG_FILES`.
- The service enforces read-only safety; remediation-style output is blocked.
- This endpoint is separate from `/v1/chat/completions`; call it as a direct HTTP integration.
