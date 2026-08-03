export type PiOAuthCredentialV1 = {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};
export const openAICodexCredentialCodec = {
  schema: 'pi.oauth',
  version: 1,
  encode(value: PiOAuthCredentialV1): Uint8Array {
    validate(value);
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    if (bytes.length > 16_384) throw new Error('Credential payload pi.oauth/v1 exceeds the size limit');
    return bytes;
  },
  decode(value: Uint8Array): PiOAuthCredentialV1 {
    if (!value.byteLength || value.byteLength > 16_384)
      throw new Error('Credential payload pi.oauth/v1 has an invalid size');
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(value).toString('utf8'));
    } catch {
      throw new Error('Credential payload pi.oauth/v1 is invalid JSON');
    }
    validate(parsed);
    return parsed;
  },
};

function validate(value: unknown): asserts value is PiOAuthCredentialV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Credential payload pi.oauth/v1 has an invalid shape');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'access,accountId,expires,refresh,type' ||
    v.type !== 'oauth' ||
    typeof v.access !== 'string' ||
    !v.access ||
    typeof v.refresh !== 'string' ||
    !v.refresh ||
    typeof v.accountId !== 'string' ||
    !v.accountId ||
    typeof v.expires !== 'number' ||
    !Number.isFinite(v.expires)
  )
    throw new Error('Credential payload pi.oauth/v1 is invalid; a fresh Codex login with accountId may be required');
}

export function parseOpenAICodexSeed(base64: string): PiOAuthCredentialV1 {
  if (
    !base64 ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw new Error('OPENAI_CODEX_AUTH_BASE64 is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    throw new Error('OPENAI_CODEX_AUTH_BASE64 is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('OPENAI_CODEX_AUTH_BASE64 is invalid');
  const value = (parsed as Record<string, unknown>)['openai-codex'];
  return openAICodexCredentialCodec.decode(openAICodexCredentialCodec.encode(value as PiOAuthCredentialV1));
}
