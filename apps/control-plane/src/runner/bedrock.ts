export const AMAZON_BEDROCK_PROVIDER = 'amazon-bedrock';
export const BEDROCK_CONVERSE_STREAM_API = 'bedrock-converse-stream';

export type AmazonBedrockInferenceProfileModel = {
  id: string;
  baseModelId: string;
  contextWindow: number;
  maxTokens: number;
};

// Add entries here only when a useful Bedrock inference-profile ID is missing from pi-ai's catalog.
export const AMAZON_BEDROCK_INFERENCE_PROFILE_MODELS: readonly AmazonBedrockInferenceProfileModel[] = [];

const BEDROCK_DEFAULT_REGION = 'us-east-1';

export const AMAZON_BEDROCK_INFERENCE_PROFILE_MODEL_IDS = AMAZON_BEDROCK_INFERENCE_PROFILE_MODELS.map(
  (model) => model.id,
);

export function resolveBedrockRuntimeBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const region = env.BEDROCK_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || BEDROCK_DEFAULT_REGION;
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}
