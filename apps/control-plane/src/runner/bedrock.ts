export const AMAZON_BEDROCK_PROVIDER = 'amazon-bedrock';
export const BEDROCK_CONVERSE_STREAM_API = 'bedrock-converse-stream';

export const AMAZON_BEDROCK_INFERENCE_PROFILE_MODELS = [
  {
    id: 'us.amazon.nova-micro-v1:0',
    baseModelId: 'amazon.nova-micro-v1:0',
    contextWindow: 128_000,
    maxTokens: 8192,
  },
  {
    id: 'us.amazon.nova-lite-v1:0',
    baseModelId: 'amazon.nova-lite-v1:0',
    contextWindow: 300_000,
    maxTokens: 8192,
  },
] as const;

const BEDROCK_DEFAULT_REGION = 'us-east-1';

export const AMAZON_BEDROCK_INFERENCE_PROFILE_MODEL_IDS = AMAZON_BEDROCK_INFERENCE_PROFILE_MODELS.map(
  (model) => model.id,
);

export function resolveBedrockRuntimeBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const region = env.BEDROCK_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || BEDROCK_DEFAULT_REGION;
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}
