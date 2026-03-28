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
- LLM provider: `ollama-ai-provider-v2`, configured through the YAML selected by `BLACKICE_CONFIG_FILE`.
- Main endpoint: `POST /v1/chat/completions`.
- Policy simulation endpoint: `POST /v1/policy/dry-run` (classify + route explain, no execution).
- Debate endpoint: `POST /v1/debate`.
- Health endpoint: `GET /healthz`.

### Components
- `src/server.ts`: OpenAI-compatible endpoint, streaming/non-streaming response framing, request lifecycle logging.
- `src/debate.ts`: multi-round model-vs-model debate orchestration with retries and safety caps.
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
2. Select the target YAML config via `BLACKICE_CONFIG_FILE` and set the small set of direct env vars and allowlist paths needed by that host.
3. Smoke test `/healthz`, `/readyz`, and chat/action curls.
4. Configure OpenClaw provider to this router endpoint.
5. Enable streaming in OpenClaw and verify token flow.
6. Monitor logs for action usage, latency, and failures.
7. Tighten allowlists and disable unused actions.

## Configuration
Runtime configuration is primarily YAML-driven. `BLACKICE_CONFIG_FILE` selects the config file to load, and `./config/blackice.local.yaml` is the default when no override is provided.

YAML-backed settings:
- `server.port`
- `readiness.timeoutMs`
- `readiness.strict`
- `ops.enabled`
- `ops.logBufferMaxEntries`
- `debate.maxConcurrent`
- `debate.modelAllowlist`
- `ollama.baseUrl`
- `ollama.model`
- `ollama.timeoutMs`
- `ollama.retryAttempts`
- `ollama.retryBackoffMs`
- `loki.baseUrl`
- `loki.timeoutMs`
- `loki.maxWindowMinutes`
- `loki.defaultWindowMinutes`
- `loki.maxLinesCap`
- `loki.maxResponseBytes`
- `loki.requireScopeLabels`
- `loki.rulesFile`
- `limits.logCollectionTimeoutMs`
- `limits.maxCommandBytes`
- `limits.maxQueryHours`
- `limits.maxLinesCap`
- `limits.maxConcurrency`
- `limits.maxLogChars`

Direct environment variables read by the process:
- `BLACKICE_CONFIG_FILE` (selects the YAML config file)
- `API_TOKEN` (optional bearer token for non-exempt API routes)
- `AUTH_EXEMPT_PATHS` (optional CSV; defaults to `/healthz,/readyz,/version`)
- `ACTIONS_ENABLED` (`true`/`false`, default: `true`)
- `ALLOWLIST_LOG_PATHS` (comma-separated absolute files or directories)
- `LOG_LEVEL` (`info`/`debug`, default: `info`)
- `METRICS_ENABLED` (`1` or `0`, default `1`; controls the Prometheus metrics endpoint)
- `METRICS_EXPOSE_PATH` (default `/metrics`; HTTP path for Prometheus exposition)
- `STREAM_SUPPRESS_TOOLISH` (`1` to suppress tool-call-like SSE payloads; default preserves raw output)
- `MODEL_PREFLIGHT_ON_START` (`1` to fail startup when the configured Ollama model is missing; default `0`)
- `MODEL_PREFLIGHT_TIMEOUT_MS` (default `2000`; timeout in ms for `/v1/models/check` and startup preflight, clamped to `200..10000`)
- `BLACKICE_GENERAL_MODEL` (default `llama3.1:8b`)
- `BLACKICE_CODE_MODEL` (default `qwen2.5-coder:14b`)
- `BLACKICE_LONGFORM_MODEL` (default `qwen2.5:14b`)
- `BLACKICE_OBSERVABILITY_MODEL` (default `qwen2.5:14b`)
- `BLACKICE_POLICY_FALLBACK_MODEL` (optional explicit fallback model)
- `BUILD_GIT_SHA` (optional; exposed by `GET /version`)
- `BUILD_TIME` (optional ISO timestamp; exposed by `GET /version`)

If you need to change Ollama, debate concurrency, readiness, ops, or Loki connection details, update the selected YAML file rather than exporting a one-off env var.

## Run
```bash
npm install
npm run build
BLACKICE_CONFIG_FILE=./config/blackice.local.yaml \
ACTIONS_ENABLED=true \
LOG_LEVEL=info \
npm start
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

## Example curl: Debate (OpenClaw decides winner)
```bash
curl -sS http://127.0.0.1:3000/v1/debate \
  -H 'Content-Type: application/json' \
  -H 'x-request-id: demo-debate-001' \
  -d '{
    "topic": "Should homelabs prioritize reliability over experimentation?",
    "moderatorInstruction": "Keep arguments technical and concise.",
    "moderator_decision_mode": "openclaw_decides",
    "modelA": "llama3.1:8b",
    "modelB": "qwen2.5:14b",
    "rounds": 3,
    "turnsPerRound": 4,
    "maxTurnChars": 1200,
    "includeModeratorSummary": true
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
