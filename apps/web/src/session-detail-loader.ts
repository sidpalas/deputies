import {
  listArtifacts,
  listCallbacks,
  listEvents,
  listExternalResources,
  listMessages,
  listServices,
  type AgentEvent,
  type Artifact,
  type CallbackDelivery,
  type ExternalResource,
  type Message,
  type SandboxService,
} from './api.js';

export type SessionDetailComponent =
  | 'messages'
  | 'events'
  | 'artifacts'
  | 'external_resources'
  | 'callbacks'
  | 'services'
  | 'render';

export type SessionDetailComponentError = Error & { component: SessionDetailComponent; cause: unknown };

export type SessionDetailPhaseTraceparents = {
  detail?: TraceparentSource;
  outputs?: TraceparentSource;
  services?: TraceparentSource;
};

type TraceparentSource = string | (() => string);

export type SessionDetailPhaseHandle = {
  detailReady: Promise<SessionDetailData>;
  outputsReady: Promise<SessionOutputsData>;
  servicesReady: Promise<SandboxService[]>;
  allReady: Promise<SessionLoadedData>;
};

export type SessionDetailData = {
  messages: Message[];
  events: AgentEvent[];
};

export type SessionOutputsData = {
  artifacts: Artifact[];
  externalResources: ExternalResource[];
  callbacks: CallbackDelivery[];
};

export type SessionLoadedData = SessionDetailData &
  SessionOutputsData & {
    services: SandboxService[];
  };

export function loadSessionDetailPhases(input: {
  sessionId: string;
  token: string;
  traceparents?: SessionDetailPhaseTraceparents;
}): SessionDetailPhaseHandle {
  const messagesPromise = withComponent(
    'messages',
    listMessages(input.sessionId, input.token, requestOptions(input.traceparents?.detail)),
  );
  const eventsPromise = withComponent(
    'events',
    listEvents(input.sessionId, input.token, undefined, requestOptions(input.traceparents?.detail)),
  );
  const artifactsPromise = withComponent(
    'artifacts',
    listArtifacts(input.sessionId, input.token, requestOptions(input.traceparents?.detail)),
  );
  const externalResourcesPromise = withComponent(
    'external_resources',
    listExternalResources(input.sessionId, input.token, requestOptions(input.traceparents?.outputs)),
  );
  const callbacksPromise = withComponent(
    'callbacks',
    listCallbacks(input.sessionId, input.token, requestOptions(input.traceparents?.outputs)),
  );
  const servicesReady = withComponent(
    'services',
    listServices(input.sessionId, input.token, requestOptions(input.traceparents?.services)),
  );

  const detailReady = Promise.all([messagesPromise, eventsPromise]).then(([messages, events]) => ({
    messages,
    events,
  }));
  const outputsReady = Promise.all([artifactsPromise, externalResourcesPromise, callbacksPromise]).then(
    ([artifacts, externalResources, callbacks]) => ({ artifacts, externalResources, callbacks }),
  );
  const allReady = Promise.all([detailReady, outputsReady, servicesReady]).then(([detail, outputs, services]) => ({
    messages: detail.messages,
    events: detail.events,
    artifacts: outputs.artifacts,
    services,
    externalResources: outputs.externalResources,
    callbacks: outputs.callbacks,
  }));

  return { detailReady, outputsReady, servicesReady, allReady };
}

export function componentName(error: unknown, fallback: SessionDetailComponent): SessionDetailComponent {
  return isComponentError(error) ? error.component : fallback;
}

export function componentCause(error: unknown): unknown {
  return isComponentError(error) ? error.cause : error;
}

function withComponent<T>(component: SessionDetailComponent, promise: Promise<T>): Promise<T> {
  return promise.catch((cause: unknown) => {
    throw Object.assign(new Error(`${component} failed`, { cause }), {
      component,
      cause,
    }) satisfies SessionDetailComponentError;
  });
}

function isComponentError(value: unknown): value is SessionDetailComponentError {
  return Boolean(value && typeof value === 'object' && 'component' in value && 'cause' in value);
}

function requestOptions(source: TraceparentSource | undefined): { traceparent: string } | undefined {
  if (!source) return undefined;
  return { traceparent: typeof source === 'function' ? source() : source };
}
