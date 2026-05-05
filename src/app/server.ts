import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppConfig } from '../config/index.js';

export function createServer(config: AppConfig) {
  return createHttpServer((request, response) => {
    handleRequest(request, response, config);
  });
}

function handleRequest(request: IncomingMessage, response: ServerResponse, config: AppConfig) {
  if (request.method === 'GET' && request.url === '/health') {
    writeJson(response, 200, {
      status: 'ok',
      runMode: config.runMode,
    });
    return;
  }

  writeJson(response, 404, {
    error: 'not_found',
    message: 'Route not found',
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
