import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkSandboxBridgeHealth } from '../src/healthcheck.js';

describe('checkSandboxBridgeHealth', () => {
  it('accepts only an authorized ready bridge response', async () => {
    const server = createServer((request, response) => {
      response.statusCode = request.headers.authorization === 'Bearer bridge-token' ? 200 : 401;
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const url = `http://127.0.0.1:${address.port}/health`;

    try {
      await expect(checkSandboxBridgeHealth(url, 'bridge-token')).resolves.toBeUndefined();
      await expect(checkSandboxBridgeHealth(url, 'wrong-token')).rejects.toThrow('401');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
