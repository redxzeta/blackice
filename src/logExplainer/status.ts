import {
  ANALYZE_MAX_LINES_REQUEST,
  AnalyzeLogsStatusResponseSchema,
  BATCH_CONCURRENCY_MAX,
  BATCH_CONCURRENCY_MIN
} from './schema.js';
import { getAllowedLogFileTargets, getLogCollectorLimits, getLokiSyntheticTargets } from './logCollector.js';
import { getOllamaRuntimeMetadata } from './ollamaClient.js';

export const LOG_EXPLAINER_ENDPOINTS = [
  'GET /analyze/logs/targets',
  'GET /analyze/logs/status',
  'GET /analyze/logs/metadata',
  'GET /health/loki',
  'POST /analyze/logs',
  'POST /analyze/logs/incremental',
  'POST /analyze/logs/batch'
] as const;

export function buildLogExplainerStatus() {
  const targets = [...getAllowedLogFileTargets(), ...getLokiSyntheticTargets()];
  const collectorLimits = getLogCollectorLimits();

  return AnalyzeLogsStatusResponseSchema.parse({
    endpoints: LOG_EXPLAINER_ENDPOINTS,
    limits: {
      maxHours: collectorLimits.maxHours,
      maxLinesRequest: ANALYZE_MAX_LINES_REQUEST,
      maxLinesEffectiveCap: collectorLimits.maxLinesCap,
      batchConcurrencyMin: BATCH_CONCURRENCY_MIN,
      batchConcurrencyMax: BATCH_CONCURRENCY_MAX
    },
    targets: {
      count: targets.length,
      items: targets
    },
    llm: getOllamaRuntimeMetadata()
  });
}
