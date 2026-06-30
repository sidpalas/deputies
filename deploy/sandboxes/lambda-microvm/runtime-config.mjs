export function parseRunConfig(body) {
  const payload =
    typeof body.runHookPayload === 'string' && body.runHookPayload ? JSON.parse(body.runHookPayload) : body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('runHookPayload must be an object');
  }
  return payload;
}
