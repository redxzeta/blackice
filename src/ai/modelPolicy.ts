const DEFAULT_OBSERVABILITY_MODEL = 'qwen2.5:14b';

function normalizedModel(input: string | undefined, fallback: string): string {
  const value = typeof input === 'string' ? input.trim() : '';
  return value.length > 0 ? value : fallback;
}

export function isCodexModel(modelId: string): boolean {
  return /codex/i.test(modelId);
}

export function getObservabilityModel(preferredModel: string): string {
  const configured = normalizedModel(process.env.BLACKICE_OBSERVABILITY_MODEL, DEFAULT_OBSERVABILITY_MODEL);
  if (!isCodexModel(preferredModel)) {
    return preferredModel;
  }
  return configured;
}

export function getPolicyFallbackModel(primaryModel: string): string {
  const configured = normalizedModel(process.env.BLACKICE_POLICY_FALLBACK_MODEL, '');
  if (configured && configured !== primaryModel) {
    return configured;
  }

  if (isCodexModel(primaryModel)) {
    const observabilityModel = getObservabilityModel(primaryModel);
    if (observabilityModel !== primaryModel) {
      return observabilityModel;
    }
  }

  return DEFAULT_OBSERVABILITY_MODEL === primaryModel ? 'llama3.1:8b' : DEFAULT_OBSERVABILITY_MODEL;
}

