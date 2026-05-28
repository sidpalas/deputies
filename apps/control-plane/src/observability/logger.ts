import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';

const defaultLevel = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const sensitiveFieldNames = [
  'apiKey',
  'api_key',
  'authorization',
  'Authorization',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'botToken',
  'bearerToken',
  'password',
  'secret',
  'clientSecret',
  'client_secret',
  'signingSecret',
  'privateKey',
  'private_key',
  'authJson',
  'authBase64',
  'cookie',
  'Cookie',
  'setCookie',
  'set-cookie',
  'Set-Cookie',
  'x-api-key',
  'X-Api-Key',
  'x-honeycomb-team',
  'X-Honeycomb-Team',
];

const sensitivePrefixes = [
  '',
  '*',
  '*.*',
  '*.*.*',
  'err',
  'err.*',
  'err.*.*',
  'headers',
  'request.headers',
  'response.headers',
  'config.headers',
  'options.headers',
  'err.headers',
  'err.request.headers',
  'err.response.headers',
  'err.config.headers',
  'err.options.headers',
];

export const loggerRedactPaths = Array.from(
  new Set(sensitivePrefixes.flatMap((prefix) => sensitiveFieldNames.map((field) => redactPath(prefix, field)))),
);

export const logger = pino({
  level: defaultLevel,
  base: {
    service: 'deputies-control-plane',
  },
  redact: {
    paths: loggerRedactPaths,
  },
  mixin: () => {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const spanContext = span.spanContext();
    if (!isSpanContextValid(spanContext)) return {};
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    };
  },
});

export const getLogger = (bindings: Record<string, unknown>): ReturnType<typeof pino> => logger.child(bindings);

function redactPath(prefix: string, field: string): string {
  const property = /^[A-Za-z_$][\w$]*$/.test(field) ? field : `["${field}"]`;
  if (!prefix) return property;
  return property.startsWith('[') ? `${prefix}${property}` : `${prefix}.${property}`;
}
