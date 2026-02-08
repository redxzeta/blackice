# Product Readiness: OpenClaw Policy Router (Node.js + TypeScript)

## Purpose
Build a single OpenAI-compatible policy/router endpoint for OpenClaw, so OpenClaw never calls local LLMs directly. The router enforces envelope parsing (CHAT vs ACTION), model routing, worker-contract prompting, output sanitization, and safe read-only home-server actions.

## Non-Goals
- No arbitrary shell/tool execution.
- No write or destructive admin actions.
- No direct exposure of Ollama endpoints to OpenClaw clients.
- No long-term job scheduling or async queueing.

## Architecture
- Runtime: Node.js 18+ in LXC.
- HTTP server: Express.
- Validation: zod schemas.
- LLM SDK: AI SDK v5.
- LLM provider: `ollama-ai-provider-v2` at `OLLAMA_BASE_URL`.
- Main endpoint: `POST /v1/chat/completions`.
- Health endpoint: `GET /healthz`.

### Components
- `src/server.ts`: OpenAI-compatible endpoint, streaming/non-streaming response framing, request lifecycle logging.
- `src/schema.ts`: zod request and envelope schemas.
- `src/envelope.ts`: reliable CHAT/ACTION detection with safe fallback to CHAT.
- `src/router.ts`: deterministic model selection logic.
- `src/ollama.ts`: AI SDK + Ollama wrapper with worker-contract prompt.
- `src/actions.ts`: safe read-only actions with strict allowlists and timeouts.
- `src/sanitize.ts`: output cleaning and tool-call payload rejection.
- `src/log.ts`: structured logs.

## OpenClaw Envelope Contract
OpenClaw sends user content in one of two forms in the latest `user` message:

1. ACTION form (single-line JSON object):
`{"action":"summarize|extract|transform|healthcheck|list_services|tail_log","input":"...","options":{...}}`

2. CHAT form (plain English text).

Detection behavior:
- Parse latest user message.
- If it looks like single-line JSON object, parse and validate as action envelope.
- If parse/validation fails, fallback to CHAT (safe fallback).

## API Design (OpenAI-Compatible)
### Endpoint
`POST /v1/chat/completions`

### Request
Compatible fields supported:
- `model` (optional)
- `messages` (required)
- `stream` (optional)
- `temperature` (optional)
- `max_tokens` (optional)

### Response
- Non-streamed: OpenAI `chat.completion` JSON shape.
- Streamed CHAT: SSE with OpenAI `chat.completion.chunk` events and terminal `[DONE]`.
- ACTION always returns one non-streamed completion response (even if `stream=true`).

## Streaming Behavior (SSE)
- CHAT + `stream=true` uses AI SDK `streamText`.
- Response headers:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache, no-transform`
  - `Connection: keep-alive`
- Emits role chunk, content delta chunks, stop chunk, then `[DONE]`.

## Model Routing
CHAT routing:
- Code-related prompts -> `qwen2.5-coder:14b`
- Long summarization/rewrites -> `qwen2.5:14b` (heuristic)
- Default general -> `llama3.1:8b`

ACTION routing:
- `summarize|extract|transform` -> `qwen2.5:14b`
- `healthcheck|list_services|tail_log` -> no LLM required (except text formatting if you add later)

## Worker Contract (All LLM Calls)
Applied in prompt wrapper for every local LLM invocation:
- Plain text only
- No markdown fences
- No JSON unless explicitly allowed by action
- No tool calls
- No meta commentary
- English only

## Output Sanitization
- Strip triple-backtick fences.
- Detect tool-call-shaped JSON blobs (for example object with `name` + `arguments` or `tool_calls`).
- Non-streamed: reject with server error.
- Streamed: suppress early detected tool-call-like payloads and replace with safe plain text.

## Security Model
- No arbitrary shell execution.
- `execFile` only on fixed allowlisted commands: `df`, `docker`, `systemctl`, `tail`.
- Command timeout on every process (`4s`).
- Tail log path enforcement via allowlist (`ALLOWLIST_LOG_PATHS`) + realpath checks.
- `tail_log` line count clamped (1..500).
- No environment variable dumping.
- Actions can be globally disabled via `ACTIONS_ENABLED=false`.

## Observability
Per request structured logs include:
- `request_id`
- `action` (if ACTION envelope)
- `model`
- `route_reason` (CHAT)
- `latency_ms`
- error details on failures

## Failure Modes and Retries
- Invalid request schema -> HTTP 400.
- Invalid action/options/path -> HTTP 500 with sanitized message.
- Ollama unavailable/timeout -> HTTP 500.
- Unsupported/malformed envelope -> handled as CHAT fallback.
- Suggested client retry policy:
  - retry on 5xx with exponential backoff
  - no retry on 4xx

## Rollout Plan
1. Deploy behind private network in LXC.
2. Set env vars and allowlist paths.
3. Smoke test `/healthz` and chat/action curls.
4. Configure OpenClaw provider to this router endpoint.
5. Enable streaming in OpenClaw and verify token flow.
6. Monitor logs for action usage, latency, and failures.
7. Tighten allowlists and disable unused actions.

## Environment Variables
- `OLLAMA_BASE_URL` (default: `http://192.168.1.230:11434`)
- `PORT` (default: `3000`)
- `ACTIONS_ENABLED` (`true`/`false`, default: `true`)
- `LOG_LEVEL` (`info`/`debug`, default: `info`)
- `ALLOWLIST_LOG_PATHS` (comma-separated absolute files or directories)

## Run
```bash
npm install
npm run build
PORT=3000 OLLAMA_BASE_URL=http://192.168.1.230:11434 npm start
```

## Example curl: Streaming CHAT
```bash
curl -N -sS http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-request-id: demo-chat-001' \
  -d '{
    "model": "router/default",
    "stream": true,
    "messages": [
      {"role":"user","content":"Explain what RAID1 is in plain terms."}
    ]
  }'
```

## Example curl: ACTION summarize
```bash
curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-request-id: demo-action-summarize-001' \
  -d '{
    "model": "router/default",
    "messages": [
      {"role":"user","content":"{\"action\":\"summarize\",\"input\":\"Ubuntu LXC host runs Docker and systemd services for media and backups.\",\"options\":{\"length\":\"short\"}}"}
    ]
  }'
```

## Example curl: ACTION healthcheck
```bash
curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "router/default",
    "messages": [
      {"role":"user","content":"{\"action\":\"healthcheck\",\"input\":\"\",\"options\":{}}"}
    ]
  }'
```

## Example curl: ACTION tail_log (allowlisted path)
```bash
ALLOWLIST_LOG_PATHS=/var/log/syslog \
curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "router/default",
    "messages": [
      {"role":"user","content":"{\"action\":\"tail_log\",\"input\":\"\",\"options\":{\"path\":\"/var/log/syslog\",\"lines\":50}}"}
    ]
  }'
```

## OpenClaw Provider Configuration
Set OpenClaw’s only provider to this router:
- Base URL: `http://<router-host>:3000/v1`
- Provider name/id: `openai` (or your OpenAI-compatible custom provider slot)
- API key: any placeholder value if required by OpenClaw UI (router ignores it unless you add auth)
- Model id to select in OpenClaw: `router/default`

Recommended controller instruction in OpenClaw:
- For bounded tasks, emit single-line ACTION JSON envelope.
- For normal conversation, emit plain English CHAT text.
