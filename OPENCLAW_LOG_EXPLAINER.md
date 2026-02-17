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

## Notes

- For `source: "file"`, target must be listed in `ALLOWED_LOG_FILES`.
- The service enforces read-only safety; unsafe command-like output is redacted before response.
- This endpoint is separate from `/v1/chat/completions`; call it as a direct HTTP integration.
