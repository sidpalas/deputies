import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { LambdaMicrovmSandboxProvider, type LambdaMicrovmClientLike } from '../../src/sandbox/lambda-microvm.js';

describe('LambdaMicrovmSandboxProvider', () => {
  it('creates handles that use the MicroVM endpoint as a bridge transport', async () => {
    const bridgeRequests: IncomingMessage[] = [];
    const server = createServer((request, response) => {
      bridgeRequests.push(request);
      handleBridgeRequest(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local server address');

    let state = 'RUNNING';
    const runCalls: unknown[] = [];
    const authTokenPorts: number[] = [];
    const client: LambdaMicrovmClientLike = {
      async checkImage() {},
      async run(input) {
        runCalls.push(input);
        return {
          microvmId: 'mvm-1',
          endpoint: `http://127.0.0.1:${address.port}`,
          state,
          imageArn: 'arn:aws:lambda:us-east-2:123456789012:microvm-image:deputies',
          imageVersion: '1.0',
        };
      },
      async get(microvmId) {
        return { microvmId, endpoint: `http://127.0.0.1:${address.port}`, state };
      },
      async createAuthToken(input) {
        authTokenPorts.push(input.port);
        return `proxy-token-${input.port}`;
      },
      async suspend() {
        state = 'SUSPENDED';
      },
      async resume() {
        state = 'RUNNING';
      },
      async terminate() {
        state = 'TERMINATED';
      },
    };
    const provider = new LambdaMicrovmSandboxProvider({
      client,
      imageIdentifier: 'deputies-sandbox',
      imageVersion: '1.0',
      executionRoleArn: 'arn:aws:iam::123456789012:role/deputies-microvm-runtime',
      ingressNetworkConnectors: ['all-ingress'],
      egressNetworkConnectors: ['internet-egress'],
      idleTimeoutMs: 900_000,
      suspendedDurationMs: 3600_000,
      maximumDurationSeconds: 28_800,
      authTokenTtlMinutes: 30,
      workspacePath: '/workspace/custom',
      bridgePort: 3584,
      logGroup: '/aws/lambda/microvms/deputies',
    });

    try {
      const handle = await provider.create({ sessionId: 'session-1', metadata: { owner: 'test' } });

      expect(runCalls[0]).toMatchObject({
        imageIdentifier: 'deputies-sandbox',
        imageVersion: '1.0',
        executionRoleArn: 'arn:aws:iam::123456789012:role/deputies-microvm-runtime',
        ingressNetworkConnectors: ['all-ingress'],
        egressNetworkConnectors: ['internet-egress'],
        maximumDurationSeconds: 28_800,
        logGroup: '/aws/lambda/microvms/deputies',
      });
      expect(JSON.parse((runCalls[0] as { runHookPayload: string }).runHookPayload)).toMatchObject({
        sessionId: 'session-1',
        workspacePath: '/workspace/custom',
        bridgePort: 3584,
      });
      expect(handle).toMatchObject({
        provider: 'lambda-microvm',
        providerSandboxId: 'mvm-1',
        sessionId: 'session-1',
        workspacePath: '/workspace/custom',
        metadata: { owner: 'test', microvmId: 'mvm-1', imageVersion: '1.0' },
      });

      await expect(handle.exec({ command: 'echo ok', cwd: '/workspace/custom' })).resolves.toMatchObject({
        exitCode: 0,
        stdout: 'ran: echo ok',
        stderr: '',
      });
      const execRequest = bridgeRequests.find((request) => request.url === '/exec');
      expect(execRequest?.headers.authorization).toMatch(/^Bearer /);
      expect(execRequest?.headers['x-aws-proxy-auth']).toBe('proxy-token-3584');
      expect(execRequest?.headers['x-aws-proxy-port']).toBe('3584');

      const endpoint = await provider.getServiceEndpoint({
        providerSandboxId: 'mvm-1',
        sessionId: 'session-1',
        port: 3000,
      });
      expect(endpoint).toMatchObject({
        port: 3000,
        targetUrl: `http://127.0.0.1:${address.port}/preview/3000`,
        targetHeaders: {
          authorization: expect.stringMatching(/^Bearer /),
          'x-aws-proxy-auth': 'proxy-token-3584',
          'x-aws-proxy-port': '3584',
        },
        preserveTargetHost: true,
        forwardPreviewHost: true,
      });
      await expect(
        provider.getServiceEndpoint({ providerSandboxId: 'mvm-1', sessionId: 'session-1', port: 3584 }),
      ).resolves.toBeNull();
      await expect(
        provider.getServiceEndpoint({ providerSandboxId: 'mvm-1', sessionId: 'session-1', port: 9000 }),
      ).resolves.toBeNull();

      await provider.stop({ providerSandboxId: 'mvm-1', sessionId: 'session-1' });
      await expect(provider.health({ providerSandboxId: 'mvm-1', sessionId: 'session-1' })).resolves.toMatchObject({
        status: 'stopped',
        message: 'Lambda MicroVM is suspended with auto-resume',
      });
      await provider.start({ providerSandboxId: 'mvm-1', sessionId: 'session-1' });
      await expect(provider.health({ providerSandboxId: 'mvm-1', sessionId: 'session-1' })).resolves.toMatchObject({
        status: 'ready',
      });
      await provider.destroy({ providerSandboxId: 'mvm-1', sessionId: 'session-1' });
      expect(authTokenPorts).toEqual(expect.arrayContaining([3584]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

function handleBridgeRequest(request: IncomingMessage, response: ServerResponse): void {
  void (async () => {
    if (request.url === '/health') return json(response, 200, { status: 'ok' });
    if (request.url === '/exec') {
      const body = JSON.parse(await readBody(request)) as { command: string };
      return json(response, 200, {
        exitCode: 0,
        stdout: `ran: ${body.command}`,
        stderr: '',
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(1).toISOString(),
      });
    }
    json(response, 404, { error: 'not_found' });
  })().catch((error: unknown) => {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? error.message : 'Unknown error');
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
