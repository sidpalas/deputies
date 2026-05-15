export type PublicApiResponseField =
  | 'array'
  | 'boolean'
  | 'null'
  | 'number'
  | 'object'
  | 'optional:object'
  | 'record'
  | 'string'
  | 'optional:string';

export type PublicApiResponseSchema = {
  description: string;
  fields: Record<string, PublicApiResponseField>;
};

export const publicApiResponseSchemas = {
  health: {
    description: 'Service health and runtime configuration summary.',
    fields: {
      status: 'string',
      runMode: 'string',
      apiAuthMode: 'string',
      authProvider: 'optional:string',
      sandboxProvider: 'string',
    },
  },
  authConfig: {
    description: 'Browser authentication mode configuration.',
    fields: { apiAuthMode: 'string', provider: 'optional:string' },
  },
  authUser: {
    description: 'Current or newly authenticated user envelope.',
    fields: { user: 'object' },
  },
  ok: {
    description: 'Successful command acknowledgement.',
    fields: { ok: 'boolean' },
  },
  session: {
    description: 'Single session envelope.',
    fields: { session: 'object' },
  },
  sessions: {
    description: 'Session list envelope.',
    fields: { sessions: 'array' },
  },
  message: {
    description: 'Single message envelope.',
    fields: { message: 'object' },
  },
  messages: {
    description: 'Message list envelope.',
    fields: { messages: 'array' },
  },
  events: {
    description: 'Normalized event list envelope.',
    fields: { events: 'array' },
  },
  artifacts: {
    description: 'Artifact list envelope.',
    fields: { artifacts: 'array' },
  },
  externalResources: {
    description: 'External resource list envelope.',
    fields: { externalResources: 'array' },
  },
  previews: {
    description: 'Published sandbox preview list envelope.',
    fields: { previews: 'array' },
  },
  sandbox: {
    description: 'Sandbox lifecycle status envelope.',
    fields: { sandbox: 'object' },
  },
  artifactPreview: {
    description: 'Text preview for a stored artifact.',
    fields: {
      artifact: 'object',
      preview: 'object',
    },
  },
  callbacks: {
    description: 'Callback delivery list envelope.',
    fields: { callbacks: 'array' },
  },
  callback: {
    description: 'Single callback delivery envelope.',
    fields: { callback: 'object' },
  },
  genericWebhook: {
    description: 'Generic webhook acceptance result.',
    fields: { accepted: 'boolean', duplicate: 'boolean', session: 'optional:object', message: 'optional:object' },
  },
  slackChallenge: {
    description: 'Slack URL verification challenge response.',
    fields: { challenge: 'string' },
  },
  webhookResult: {
    description: 'Integration webhook handling result.',
    fields: { ok: 'boolean', type: 'string', reason: 'optional:string' },
  },
  error: {
    description: 'Error envelope.',
    fields: { error: 'string', message: 'string' },
  },
} as const satisfies Record<string, PublicApiResponseSchema>;

export type PublicApiResponseSchemaName = keyof typeof publicApiResponseSchemas;

export const publicApiResponseEnvelopeFields = new Set(
  Object.values(publicApiResponseSchemas).flatMap((schema) => Object.keys(schema.fields)),
);
