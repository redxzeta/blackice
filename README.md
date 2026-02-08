# BlackIce OpenClaw Policy Router

OpenAI-compatible policy/router server for OpenClaw.

- OpenClaw calls this server as its only provider.
- This server routes to local Ollama models.
- Supports CHAT (streaming) and ACTION (non-streaming) envelopes.

## Requirements
- Node.js 18+
- Ollama reachable at `http://192.168.1.230:11434` (or set `OLLAMA_BASE_URL`)

## Install
```bash
npm install
npm run build
```

## Run
```bash
PORT=3000 \
OLLAMA_BASE_URL=http://192.168.1.230:11434 \
ACTIONS_ENABLED=true \
LOG_LEVEL=info \
npm start
```

Dev mode:
```bash
npm run dev
```

## Endpoints
- `POST /v1/chat/completions`
- `GET /healthz`

## Envelope Contract
Latest `user` message is interpreted as:

1. ACTION (single-line JSON object)
```json
{"action":"summarize|extract|transform|healthcheck|list_services|tail_log","input":"...","options":{...}}
```

2. CHAT (plain English text)

If ACTION parsing fails, request is treated as CHAT.

## Model Routing
- Code-related chat -> `qwen2.5-coder:14b`
- Long summary/rewrite chat -> `qwen2.5:14b`
- Default chat -> `llama3.1:8b`

## Actions
Read-only actions only:
- `healthcheck`
- `list_services`
- `tail_log` (allowlisted paths only)
- `summarize` / `extract` / `transform`

Security controls:
- no arbitrary shell execution
- fixed command allowlist
- child process timeouts
- path allowlist enforcement for logs

## Environment Variables
- `OLLAMA_BASE_URL` (default: `http://192.168.1.230:11434`)
- `PORT` (default: `3000`)
- `ACTIONS_ENABLED` (`true`/`false`, default `true`)
- `LOG_LEVEL` (`info`/`debug`, default `info`)
- `ALLOWLIST_LOG_PATHS` (comma-separated absolute files or directories)

## Quick Tests
Streaming CHAT:
```bash
curl -N -sS http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "router/default",
    "stream": true,
    "messages": [{"role":"user","content":"Explain swap memory in simple terms."}]
  }'
```

ACTION summarize:
```bash
curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "router/default",
    "messages": [{"role":"user","content":"{\"action\":\"summarize\",\"input\":\"Docker host runs services for media, backups, and ingress.\",\"options\":{\"length\":\"short\"}}"}]
  }'
```

ACTION healthcheck:
```bash
curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "router/default",
    "messages": [{"role":"user","content":"{\"action\":\"healthcheck\",\"input\":\"\",\"options\":{}}"}]
  }'
```

ACTION tail_log:
```bash
ALLOWLIST_LOG_PATHS=/var/log/syslog \
curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "router/default",
    "messages": [{"role":"user","content":"{\"action\":\"tail_log\",\"input\":\"\",\"options\":{\"path\":\"/var/log/syslog\",\"lines\":50}}"}]
  }'
```

## OpenClaw Provider Setup
- Base URL: `http://<router-host>:3000/v1`
- Provider type: OpenAI-compatible
- Model: `router/default`
- API key: placeholder if UI requires one

## Notes
- Full product document: `PRODUCT_READINESS.md`
