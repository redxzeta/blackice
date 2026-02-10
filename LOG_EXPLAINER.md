# Log Explainer Service (Unified)

The Log Explainer endpoint is now part of the main server process (`src/server.ts`).

## Run

```bash
PORT=3000 \
OLLAMA_BASE_URL=http://192.168.1.230:11434 \
OLLAMA_MODEL=qwen2.5:14b \
ALLOWED_LOG_FILES=/var/log/syslog,/var/log/auth.log \
npm start
```

## Endpoint

`POST /analyze/logs`

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

## Example JSON response

```json
{
  "analysis": "## Summary\nRepeated failed SSH authentication attempts were detected...\n\n## Key Findings\n- ..."
}
```

## Safety controls

- Uses only read-only collectors: `journalctl`, `docker logs`, and explicit allowlisted files.
- No shell mode execution (`spawn` with `shell: false`).
- Command and file output byte caps are enforced.
- No file writes, no delete operations, no remediation commands.
- Ollama call has a request timeout.
