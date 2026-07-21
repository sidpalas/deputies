import type { RunnerArtifact, RunnerResult } from '../runner/types.js';

export function serializeRunnerResult(result: RunnerResult): Record<string, unknown> {
  return {
    text: result.text,
    ...(result.model ? { model: result.model } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.artifacts
      ? {
          artifacts: result.artifacts.map(({ content, ...artifact }) => ({
            ...artifact,
            ...(content instanceof Uint8Array
              ? { contentBase64: Buffer.from(content).toString('base64') }
              : content !== undefined
                ? { content }
                : {}),
          })),
        }
      : {}),
  };
}

export function parseRunnerResult(value: unknown): RunnerResult {
  if (!isObject(value) || typeof value.text !== 'string') throw new Error('Persisted runner result is invalid');
  if (value.model !== undefined && typeof value.model !== 'string')
    throw new Error('Persisted runner result model is invalid');
  if (value.artifacts !== undefined && !Array.isArray(value.artifacts))
    throw new Error('Persisted runner result artifacts are invalid');
  const artifacts = value.artifacts?.map(parseArtifact);
  return {
    text: value.text,
    ...(value.model ? { model: value.model } : {}),
    ...(isObject(value.usage) ? { usage: value.usage as NonNullable<RunnerResult['usage']> } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

function parseArtifact(value: unknown): RunnerArtifact {
  if (!isObject(value) || typeof value.type !== 'string') throw new Error('Persisted runner artifact is invalid');
  for (const key of ['title', 'url', 'content', 'contentBase64', 'contentType', 'fileName'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string')
      throw new Error(`Persisted runner artifact ${key} is invalid`);
  }
  if (value.payload !== undefined && !isObject(value.payload))
    throw new Error('Persisted runner artifact payload is invalid');
  return value as RunnerArtifact;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
