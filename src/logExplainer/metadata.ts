import { LogExplainerJsonSchemas } from './schema.js'
import { LOG_EXPLAINER_ENDPOINTS } from './status.js'

type LogExplainerMetadataEndpoint = {
  method: 'GET' | 'POST'
  path: string
  requestSchema?: Record<string, string>
  responseSchema?: unknown
}

export function buildMetadataEndpoints(): Record<string, LogExplainerMetadataEndpoint> {
  const endpointEntries: Array<[string, LogExplainerMetadataEndpoint]> =
    LOG_EXPLAINER_ENDPOINTS.map((endpoint) => {
      switch (endpoint) {
        case 'GET /analyze/logs/targets':
          return [
            'targets',
            {
              method: 'GET',
              path: '/analyze/logs/targets',
              responseSchema: LogExplainerJsonSchemas.analyzeLogsTargetsResponse,
            },
          ]
        case 'POST /analyze/logs':
          return [
            'analyze',
            {
              method: 'POST',
              path: '/analyze/logs',
              requestSchema: {
                source: 'journalctl | journald | docker',
                target: 'string',
                hours: 'number',
                maxLines: 'number',
              },
              responseSchema: LogExplainerJsonSchemas.analyzeLogsResponse,
            },
          ]
        case 'POST /analyze/logs/batch':
          return [
            'batch',
            {
              method: 'POST',
              path: '/analyze/logs/batch',
              requestSchema: {
                source: 'journald | loki',
                targets: 'string[] (optional; journald units)',
                filters: 'record<string,string> (required when source=loki; selector labels)',
                contains: 'string (optional; source=loki line filter)',
                regex: 'string (optional; source=loki regex line filter)',
                start: 'ISO-8601 datetime (optional; source=loki)',
                end: 'ISO-8601 datetime (optional; source=loki)',
                sinceSeconds: 'number (optional; source=loki relative time window)',
                limit: 'number (optional; source=loki)',
                allowUnscoped: 'boolean (optional; source=loki)',
                hours: 'number (optional)',
                sinceMinutes: 'number (optional; overrides hours for source=loki)',
                maxLines: 'number (optional)',
                mode: 'analyze | raw | both (optional; default analyze)',
                evidenceLines:
                  'number (optional; max 50; includes evidence excerpts per success result)',
                concurrency: 'number (optional)',
              },
              responseSchema: LogExplainerJsonSchemas.analyzeLogsBatchResponse,
            },
          ]
        case 'GET /analyze/logs/status':
          return [
            'status',
            {
              method: 'GET',
              path: '/analyze/logs/status',
            },
          ]
        case 'GET /analyze/logs/metadata':
          return [
            'metadata',
            {
              method: 'GET',
              path: '/analyze/logs/metadata',
            },
          ]
        case 'GET /health/loki':
          return [
            'healthLoki',
            {
              method: 'GET',
              path: '/health/loki',
            },
          ]
      }
    })

  return Object.fromEntries(endpointEntries)
}
