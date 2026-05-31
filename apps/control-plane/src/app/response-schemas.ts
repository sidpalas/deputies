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
      hideSetupPage: 'boolean',
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
  group: {
    description: 'Single group envelope.',
    fields: { group: 'object' },
  },
  groups: {
    description: 'Group list envelope.',
    fields: { groups: 'array' },
  },
  groupMembers: {
    description: 'Group member list envelope.',
    fields: { members: 'array' },
  },
  groupMember: {
    description: 'Single group member envelope.',
    fields: { member: 'object' },
  },
  users: {
    description: 'Auth user list envelope.',
    fields: { users: 'array' },
  },
  user: {
    description: 'Single auth user envelope.',
    fields: { user: 'object' },
  },
  repositories: {
    description: 'Configured repository picker options.',
    fields: { repositories: 'array' },
  },
  branches: {
    description: 'Repository branch picker options.',
    fields: { branches: 'array' },
  },
  models: {
    description: 'Configured model picker options.',
    fields: { models: 'array', modelOptions: 'array', defaultModel: 'optional:string' },
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
  services: {
    description: 'Published sandbox service list envelope.',
    fields: { services: 'array' },
  },
  sandbox: {
    description: 'Sandbox lifecycle status envelope.',
    fields: { sandbox: 'object' },
  },
  workspaceToolOpen: {
    description: 'Opened workspace tool service envelope.',
    fields: { tool: 'object', service: 'object', session: 'object' },
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
