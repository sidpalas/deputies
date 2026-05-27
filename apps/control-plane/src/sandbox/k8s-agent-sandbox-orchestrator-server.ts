import { createServer } from 'node:http';
import { InProcessAgentSandboxOrchestrator, createAgentSandboxOrchestratorHttpHandler } from './k8s-agent-sandbox.js';

const port = parsePort(process.env.AGENT_SANDBOX_ORCHESTRATOR_PORT, 3587);
const host = process.env.AGENT_SANDBOX_ORCHESTRATOR_HOST ?? '0.0.0.0';
const token = requireEnv('AGENT_SANDBOX_ORCHESTRATOR_TOKEN');
const handler = createAgentSandboxOrchestratorHttpHandler(
  new InProcessAgentSandboxOrchestrator(
    optional({
      namespace: process.env.AGENT_SANDBOX_NAMESPACE,
      image: process.env.AGENT_SANDBOX_IMAGE,
      workspacePath: process.env.SANDBOX_WORKSPACE_PATH,
      storageSize: process.env.AGENT_SANDBOX_STORAGE_SIZE,
      storageClassName: process.env.AGENT_SANDBOX_STORAGE_CLASS_NAME,
    }),
  ),
  token,
);

const server = createServer(async (request, response) => {
  const url = `http://${request.headers.host ?? `${host}:${port}`}${request.url ?? '/'}`;
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }
  const webResponse = await handler(
    new Request(url, {
      method: request.method,
      headers,
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
});

server.listen(port, host, () => {
  console.log(`agent sandbox orchestrator listening on ${host}:${port}`);
});

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`Invalid port: ${value}`);
  return parsed;
}

function optional<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
