import { resolveBedrockRuntimeBaseUrl } from '../../src/runner/bedrock.js';

describe('Bedrock runtime config', () => {
  it('uses Bedrock-specific region before AWS region fallbacks', () => {
    expect(
      resolveBedrockRuntimeBaseUrl({
        BEDROCK_REGION: 'us-west-2',
        AWS_REGION: 'us-east-2',
        AWS_DEFAULT_REGION: 'us-east-1',
      }),
    ).toBe('https://bedrock-runtime.us-west-2.amazonaws.com');
  });

  it('falls back through AWS region env and then us-east-1', () => {
    expect(resolveBedrockRuntimeBaseUrl({ AWS_REGION: 'us-east-2' })).toBe(
      'https://bedrock-runtime.us-east-2.amazonaws.com',
    );
    expect(resolveBedrockRuntimeBaseUrl({ AWS_DEFAULT_REGION: 'eu-west-1' })).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com',
    );
    expect(resolveBedrockRuntimeBaseUrl({})).toBe('https://bedrock-runtime.us-east-1.amazonaws.com');
  });
});
