import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRunConfig } from './runtime-config.mjs';

describe('parseRunConfig', () => {
  it('accepts AWS direct run hook payload objects', () => {
    assert.deepEqual(
      parseRunConfig({
        sessionId: 'session-1',
        bridgeToken: 'token',
        workspacePath: '/workspace',
        bridgePort: 3584,
      }),
      {
        sessionId: 'session-1',
        bridgeToken: 'token',
        workspacePath: '/workspace',
        bridgePort: 3584,
      },
    );
  });

  it('accepts the wrapped runHookPayload shape used by local fixtures', () => {
    assert.deepEqual(
      parseRunConfig({
        runHookPayload: JSON.stringify({ bridgeToken: 'token', workspacePath: '/workspace' }),
      }),
      { bridgeToken: 'token', workspacePath: '/workspace' },
    );
  });

  it('rejects non-object payloads', () => {
    assert.throws(() => parseRunConfig({ runHookPayload: '[]' }), /runHookPayload must be an object/);
  });
});
