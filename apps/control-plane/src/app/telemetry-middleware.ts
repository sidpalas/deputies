import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { AppConfig } from '../config/index.js';
import { runWithExtractedTraceContext, traceAsync } from '../telemetry/index.js';
import type { AppVariables } from './server.js';

export function routeTelemetryMiddleware(config: AppConfig): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const route = telemetryRoute(c);
    const spanName = `${method} ${route}`;
    await runWithExtractedTraceContext(c.req.raw.headers, () =>
      traceAsync(
        spanName,
        {
          'http.request.method': method,
          'http.route': route,
          'deputies.route_kind': route.endsWith('/stream')
            ? 'stream'
            : route === '/preview-service'
              ? 'proxy'
              : 'request',
          'deputies.request_id': c.get('requestId'),
          'deputies.api_auth_mode': config.apiAuthMode,
        },
        async (span) => {
          await next();
          span.setAttribute('http.response.status_code', c.res.status);
        },
      ),
    );
  };
}

function telemetryRoute(c: Context<{ Variables: AppVariables }>): string {
  if (new URL(c.req.url).host.startsWith('s-')) return '/preview-service';
  const matchedPath = routePath(c, -1);
  return matchedPath && matchedPath !== '*' ? matchedPath : scrubDynamicPath(c.req.path);
}

function scrubDynamicPath(path: string): string {
  return path
    .split('/')
    .map((part) => (isUuid(part) ? ':id' : part))
    .join('/');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
