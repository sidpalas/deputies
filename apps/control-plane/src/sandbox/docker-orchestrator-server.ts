import { createServer } from 'node:http';
import { InProcessDockerOrchestrator, createDockerOrchestratorHttpHandler } from './docker.js';

const port = parsePort(process.env.DOCKER_ORCHESTRATOR_PORT, 3585);
const host = process.env.DOCKER_ORCHESTRATOR_HOST ?? '0.0.0.0';
const handler = createDockerOrchestratorHttpHandler(new InProcessDockerOrchestrator(optional({
  image: process.env.DOCKER_SANDBOX_IMAGE,
  workspacePath: process.env.DOCKER_SANDBOX_WORKSPACE_PATH,
  bridgeHost: process.env.DOCKER_SANDBOX_BRIDGE_HOST,
  network: process.env.DOCKER_SANDBOX_NETWORK,
  memory: process.env.DOCKER_SANDBOX_MEMORY,
  cpus: process.env.DOCKER_SANDBOX_CPUS,
})), process.env.DOCKER_ORCHESTRATOR_TOKEN);

const server = createServer(async (request, response) => {
  const url = `http://${request.headers.host ?? `${host}:${port}`}${request.url ?? '/'}`;
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }
  const webResponse = await handler(new Request(url, {
    method: request.method,
    headers,
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' }));
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
});

server.listen(port, host, () => {
  console.log(`docker sandbox orchestrator listening on ${host}:${port}`);
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
