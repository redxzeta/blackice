# Log Explainer Service (Unified)

The Log Explainer endpoint is part of the main server process (`src/server.ts`).

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
`POST /analyze/logs/batch`
`GET /analyze/logs/targets`

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
curl -sS http://127.0.0.1:3000/analyze/logs/batch \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "file",
    "hours": 6,
    "maxLines": 300,
    "concurrency": 2
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
- LLM output is policy-checked; unsafe command-like content is redacted with a safety note.
- No file writes, no delete operations, no remediation commands.
- Ollama call has a request timeout.

## OpenClaw

See `/Users/nsuarez/projects/blackice/OPENCLAW_LOG_EXPLAINER.md` for direct OpenClaw HTTP integration details.
See `/Users/nsuarez/projects/blackice/PHASE2_LXC_LOG_EXPOSURE_HANDOFF.md` for the multi-LXC rollout handoff plan.
