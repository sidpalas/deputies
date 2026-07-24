import { expect, test, type Page } from '@playwright/test';
import { browserMilestoneNames, parseBrowserMilestone, type BrowserMilestone } from '@deputies/browser-milestones';
import type {
  AgentEvent,
  Artifact,
  CallbackDelivery,
  ExternalResource,
  Message,
  SandboxService,
  Session,
} from '../src/api.js';

type SessionFixture = {
  session: Session;
  messages: Message[];
  events: AgentEvent[];
  artifacts: Artifact[];
  externalResources: ExternalResource[];
  callbacks: CallbackDelivery[];
  services: SandboxService[];
};

type CpuProfile = {
  nodes: Array<{
    id: number;
    callFrame: {
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    };
  }>;
  samples?: number[];
  timeDeltas?: number[];
};

const lightSessionId = '00000000-0000-4000-8000-000000000001';
const heavySessionId = '00000000-0000-4000-8000-000000000002';
const lightSessionTitle = 'Synthetic light session';
const heavySessionTitle = 'Synthetic heavy session';
const apiBaseUrl = process.env.VITE_API_BASE_URL ?? 'http://localhost:3583';
const apiOrigin = new URL(apiBaseUrl).origin;

test.describe('heavy session load', () => {
  test.skip(
    process.env.RUN_HEAVY_SESSION_E2E !== 'true',
    'Set RUN_HEAVY_SESSION_E2E=true to run the local heavy-session browser profile.',
  );

  test('reports browser milestone timings for a synthetic heavy session', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chrome DevTools Protocol profiling is Chromium-only.');
    test.setTimeout(120_000);

    const fixture = buildFixture();
    const milestonePosts: BrowserMilestone[] = [];
    await mockApi(page, fixture, milestonePosts);

    await page.goto(`/?session=${lightSessionId}`);
    await expect(page.getByRole('heading', { name: lightSessionTitle })).toBeVisible();
    await waitForMilestones(milestonePosts, 'startup_selection');
    await page.getByRole('button', { name: 'Load more sessions' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`^${escapeRegExp(heavySessionTitle)}`) })).toBeVisible();
    milestonePosts.length = 0;

    const client = await page.context().newCDPSession(page);
    await client.send('Profiler.enable');
    await client.send('Profiler.start');

    await page.evaluate(() => performance.mark('heavy-session-selection-start'));
    await page.getByRole('button', { name: new RegExp(`^${escapeRegExp(heavySessionTitle)}`) }).click();
    await expect(page.getByRole('heading', { name: heavySessionTitle })).toBeVisible();
    const selectionMilestones = await waitForMilestones(milestonePosts, 'selection');
    const selectionMeasureMs = await page.evaluate(() => {
      performance.mark('heavy-session-selection-end');
      performance.measure('heavy-session-selection', 'heavy-session-selection-start', 'heavy-session-selection-end');
      return performance.getEntriesByName('heavy-session-selection').at(-1)?.duration ?? 0;
    });
    const profile = ((await client.send('Profiler.stop')) as { profile: CpuProfile }).profile;
    await client.detach();

    const summary = {
      fixture: {
        messages: fixture.heavy.messages.length,
        events: fixture.heavy.events.length,
        artifacts: fixture.heavy.artifacts.length,
        externalResources: fixture.heavy.externalResources.length,
        callbacks: fixture.heavy.callbacks.length,
        services: fixture.heavy.services.length,
      },
      selectionMeasureMs: round(selectionMeasureMs),
      milestones: Object.fromEntries(
        selectionMilestones.map((milestone) => [milestone.name, round(milestone.durationMs)]),
      ),
      topCpuSelfMs: summarizeCpuProfile(profile),
    };
    console.info(`[heavy-session-load] ${JSON.stringify(summary, null, 2)}`);

    const maxAllowedMs = readOptionalPositiveNumberEnv('HEAVY_SESSION_MAX_MILESTONE_MS');
    if (maxAllowedMs !== null) {
      expect(Math.max(...selectionMilestones.map((milestone) => milestone.durationMs))).toBeLessThan(maxAllowedMs);
    }
  });
});

function buildFixture(): { sessions: Session[]; light: SessionFixture; heavy: SessionFixture } {
  const light = buildSessionFixture({
    sessionId: lightSessionId,
    title: lightSessionTitle,
    messageCount: 1,
    eventsPerMessage: 2,
    artifactCount: 0,
    externalResourceCount: 0,
    callbackCount: 0,
    serviceCount: 0,
  });
  const heavy = buildSessionFixture({
    sessionId: heavySessionId,
    title: heavySessionTitle,
    messageCount: readPositiveIntegerEnv('HEAVY_SESSION_MESSAGE_COUNT', 8),
    eventsPerMessage: readPositiveIntegerEnv('HEAVY_SESSION_EVENTS_PER_MESSAGE', 180),
    artifactCount: readNonNegativeIntegerEnv('HEAVY_SESSION_ARTIFACT_COUNT', 80),
    externalResourceCount: readNonNegativeIntegerEnv('HEAVY_SESSION_EXTERNAL_RESOURCE_COUNT', 20),
    callbackCount: readNonNegativeIntegerEnv('HEAVY_SESSION_CALLBACK_COUNT', 40),
    serviceCount: readNonNegativeIntegerEnv('HEAVY_SESSION_SERVICE_COUNT', 2),
  });
  return { sessions: [heavy.session, light.session], light, heavy };
}

function buildSessionFixture(input: {
  sessionId: string;
  title: string;
  messageCount: number;
  eventsPerMessage: number;
  artifactCount: number;
  externalResourceCount: number;
  callbackCount: number;
  serviceCount: number;
}): SessionFixture {
  const createdAt = timestamp(0);
  const session: Session = {
    id: input.sessionId,
    status: 'idle',
    displayStatus: 'idle',
    spawnDepth: 0,
    createdAt,
    updatedAt: timestamp(input.messageCount * 120_000),
    lastActivityAt: timestamp(input.messageCount * 120_000),
    tags: [],
    title: input.title,
    context: { repository: { provider: 'github', owner: 'synthetic', repo: 'large-session' } },
  };

  const messages = Array.from({ length: input.messageCount }, (_, index): Message => {
    const sequence = index + 1;
    return {
      id: uuid(2_000 + sequence),
      sessionId: input.sessionId,
      sequence,
      status: 'completed',
      steering: false,
      prompt: `Investigate synthetic load case ${sequence} with a detailed event history.`,
      createdAt: timestamp(sequence * 60_000),
      ...(sequence % 2 === 0 ? { context: { branch: `perf-fixture-${sequence}` } } : {}),
    };
  });

  const events: AgentEvent[] = [];
  for (const message of messages) appendMessageEvents(events, input.sessionId, message, input.eventsPerMessage);

  const artifacts = Array.from({ length: input.artifactCount }, (_, index): Artifact => {
    const message = messages[index % Math.max(messages.length, 1)]!;
    return {
      id: uuid(3_000 + index),
      sessionId: input.sessionId,
      runId: runId(message.sequence),
      messageId: message.id,
      type: 'report',
      title: `Synthetic report ${index + 1}`,
      storageKey: `synthetic/reports/${index + 1}.md`,
      payload: {
        fileName: `synthetic-report-${index + 1}.md`,
        contentType: 'text/markdown',
        sizeBytes: 4096 + index,
      },
      createdAt: timestamp(90_000 + index * 1_000),
    };
  });

  const externalResources = Array.from({ length: input.externalResourceCount }, (_, index): ExternalResource => {
    const message = messages[index % Math.max(messages.length, 1)]!;
    return {
      id: uuid(4_000 + index),
      sessionId: input.sessionId,
      runId: runId(message.sequence),
      messageId: message.id,
      type: 'link',
      title: `Synthetic external resource ${index + 1}`,
      url: `https://example.test/resources/${index + 1}`,
      metadata: { source: 'heavy-session-load' },
      createdAt: timestamp(95_000 + index * 1_000),
    };
  });

  const callbacks = Array.from({ length: input.callbackCount }, (_, index): CallbackDelivery => {
    const message = messages[index % Math.max(messages.length, 1)]!;
    return {
      id: uuid(5_000 + index),
      sessionId: input.sessionId,
      runId: runId(message.sequence),
      messageId: message.id,
      targetType: 'http',
      target: { url: `https://example.test/callbacks/${index + 1}` },
      status: index % 7 === 0 ? 'failed' : 'delivered',
      eventType: 'message_completed',
      payload: { fixture: true, index },
      attempts: index % 7 === 0 ? 5 : 1,
      maxAttempts: 5,
      createdAt: timestamp(100_000 + index * 1_000),
      updatedAt: timestamp(101_000 + index * 1_000),
      ...(index % 7 === 0 ? { lastError: 'Synthetic callback failure for rendering load.' } : {}),
    };
  });

  const services = Array.from(
    { length: input.serviceCount },
    (_, index): SandboxService => ({
      port: 3_000 + index,
      url: `https://service-${index + 1}.example.test`,
      status: 'available',
      label: `Synthetic service ${index + 1}`,
      path: '/',
      shutdownAt: timestamp(3_600_000),
    }),
  );

  return { session, messages, events, artifacts, externalResources, callbacks, services };
}

function appendMessageEvents(
  events: AgentEvent[],
  sessionId: string,
  message: Message,
  eventsPerMessage: number,
): void {
  const run = runId(message.sequence);
  const append = (type: string, payload: Record<string, unknown>, offsetMs: number) => {
    events.push({
      id: events.length + 1,
      sessionId,
      sequence: events.length + 1,
      type,
      payload,
      runId: run,
      messageId: message.id,
      createdAt: timestamp(message.sequence * 60_000 + offsetMs),
    });
  };

  append('message_created', { prompt: message.prompt, sequence: message.sequence }, 0);
  append('message_started', { sequence: message.sequence, sequences: [message.sequence], batchSize: 1 }, 500);
  append('sandbox_starting', { provider: 'synthetic' }, 1_000);
  append('sandbox_ready', { provider: 'synthetic', created: message.sequence === 1 }, 1_500);

  for (let index = 0; index < eventsPerMessage; index += 1) {
    const toolCallId = `${run}-tool-${index + 1}`;
    const command = `synthetic-command --message=${message.sequence} --step=${index + 1}`;
    append('tool_started', { toolName: 'bash', toolCallId, args: { command } }, 2_000 + index * 20);
    append(
      'agent_text_delta',
      {
        sequence: message.sequence,
        text: `Observation ${index + 1}: synthetic render work for message ${message.sequence}. `,
      },
      2_005 + index * 20,
    );
    append(
      'tool_finished',
      {
        toolName: 'bash',
        toolCallId,
        isError: index % 23 === 0,
        result: {
          command,
          exitCode: index % 23 === 0 ? 1 : 0,
          stdout: `Synthetic output ${index + 1} `.repeat(16),
        },
      },
      2_010 + index * 20,
    );
  }

  append('agent_response_final', { sequence: message.sequence, text: finalResponseText(message.sequence) }, 8_000);
  append('run_completed', { model: 'synthetic-model', usage: { totalTokens: 12_000 + message.sequence } }, 8_500);
  append('message_completed', { sequence: message.sequence }, 9_000);
}

async function mockApi(
  page: Page,
  fixture: { sessions: Session[]; light: SessionFixture; heavy: SessionFixture },
  milestonePosts: BrowserMilestone[],
): Promise<void> {
  await page.route(`${apiOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (method === 'GET' && path === '/health') {
      await route.fulfill({ json: { status: 'ok', runMode: 'combined', apiAuthMode: 'none', hideSetupPage: true } });
      return;
    }
    if (method === 'GET' && path === '/models') {
      await route.fulfill({ json: { models: [], modelChoices: [], defaultModel: null } });
      return;
    }
    if (method === 'GET' && path === '/repositories') {
      await route.fulfill({ json: { repositories: [] } });
      return;
    }
    if (method === 'GET' && path === '/repositories/synthetic/large-session/branches') {
      await route.fulfill({ json: { branches: [{ name: 'main' }, { name: 'perf-fixture-2' }] } });
      return;
    }
    if (method === 'GET' && path === '/groups') {
      await route.fulfill({ json: { groups: [] } });
      return;
    }
    if (method === 'GET' && path === '/automations') {
      await route.fulfill({ json: { automations: [] } });
      return;
    }
    if (method === 'GET' && path === '/environments') {
      await route.fulfill({ json: { environments: [] } });
      return;
    }
    if (method === 'GET' && path === '/sessions/tags') {
      await route.fulfill({ json: { tags: [] } });
      return;
    }
    if (method === 'GET' && path === '/skills' && url.search === '?scope=personal') {
      await route.fulfill({ json: { skills: [] } });
      return;
    }
    if (
      method === 'GET' &&
      (path === `/sessions/${lightSessionId}/skills` || path === `/sessions/${heavySessionId}/skills`)
    ) {
      await route.fulfill({ json: { skills: [] } });
      return;
    }
    if (method === 'GET' && path === '/events/stream') {
      await route.fulfill({ body: '', headers: { 'content-type': 'text/event-stream' } });
      return;
    }
    if (method === 'POST' && path === '/telemetry/browser-milestones') {
      const milestone = parseBrowserMilestone(route.request().postDataJSON());
      if (typeof milestone === 'string') throw new Error(`Invalid browser milestone: ${milestone}`);
      milestonePosts.push(milestone);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (method === 'GET' && path === '/sessions') {
      const secondPage = url.searchParams.has('cursor');
      await route.fulfill({
        json: secondPage
          ? { sessions: [fixture.heavy.session], nextCursor: null }
          : { sessions: [fixture.light.session], nextCursor: 'heavy-session-page' },
      });
      return;
    }

    const sessionDetail = method === 'GET' ? detailForPath(url, fixture) : null;
    if (sessionDetail) {
      await route.fulfill({ json: sessionDetail });
      return;
    }

    throw new Error(`Unhandled heavy-session API request: ${method} ${path}`);
  });
}

function detailForPath(
  url: URL,
  fixture: { light: SessionFixture; heavy: SessionFixture },
): Record<string, unknown> | null {
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const session = match[1] === lightSessionId ? fixture.light : match[1] === heavySessionId ? fixture.heavy : null;
  if (!session) return null;

  switch (match[2]) {
    case 'messages':
      return { messages: session.messages };
    case 'events':
      return eventPage(session.events, url);
    case 'artifacts':
      return { artifacts: session.artifacts };
    case 'external-resources':
      return { externalResources: session.externalResources };
    case 'callbacks':
      return { callbacks: session.callbacks };
    case 'services':
      return { services: session.services };
    default:
      return null;
  }
}

function eventPage(events: AgentEvent[], url: URL): Record<string, unknown> {
  const after = readNonNegativeIntegerParam(url.searchParams.get('after'), 0);
  const limit = Math.min(readPositiveIntegerParam(url.searchParams.get('limit'), 1000), 2000);
  const page = events.filter((event) => event.sequence > after).slice(0, limit);
  return {
    events: page,
    cursor: page.at(-1)?.sequence ?? after,
    hasMore: page.length === limit,
  };
}

function readPositiveIntegerParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeIntegerParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

async function waitForMilestones(
  posts: BrowserMilestone[],
  trigger: 'startup_selection' | 'selection',
): Promise<BrowserMilestone[]> {
  await expect
    .poll(
      () =>
        new Set(posts.filter((post) => post.trigger === trigger && post.result === 'success').map((post) => post.name))
          .size,
      { timeout: 60_000 },
    )
    .toBe(browserMilestoneNames.length);

  return browserMilestoneNames.map((name) => {
    const post = posts.find((candidate) => candidate.trigger === trigger && candidate.name === name);
    if (!post) throw new Error(`Missing milestone: ${name}`);
    return post;
  });
}

function summarizeCpuProfile(profile: CpuProfile): Array<{ function: string; source: string; selfMs: number }> {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, { function: string; source: string; selfUs: number }>();

  for (const [index, nodeId] of (profile.samples ?? []).entries()) {
    const node = nodes.get(nodeId);
    if (!node || isBrowserInternalFrame(node.callFrame.functionName)) continue;
    const source = shortSource(node.callFrame.url);
    const functionName = node.callFrame.functionName || '(anonymous)';
    const key = `${functionName}\n${source}`;
    const current = totals.get(key) ?? { function: functionName, source, selfUs: 0 };
    current.selfUs += profile.timeDeltas?.[index] ?? 0;
    totals.set(key, current);
  }

  return Array.from(totals.values())
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, 12)
    .map((item) => ({ function: item.function, source: item.source, selfMs: round(item.selfUs / 1000) }));
}

function isBrowserInternalFrame(functionName: string): boolean {
  return ['(idle)', '(program)', '(garbage collector)', '(root)'].includes(functionName);
}

function shortSource(url: string): string {
  if (!url) return '(unknown)';
  try {
    const parsed = new URL(url);
    const srcIndex = parsed.pathname.indexOf('/src/');
    if (srcIndex !== -1) return parsed.pathname.slice(srcIndex + 1);
    const modulesIndex = parsed.pathname.indexOf('/node_modules/');
    if (modulesIndex !== -1) return parsed.pathname.slice(modulesIndex + 1);
    return parsed.pathname || url;
  } catch {
    return url;
  }
}

function finalResponseText(sequence: number): string {
  return [
    `Synthetic answer for message ${sequence}.`,
    'This response intentionally has enough markdown-like text to exercise the message renderer.',
    Array.from(
      { length: 16 },
      (_, index) => `- Finding ${index + 1}: repeated detail text with value ${sequence}-${index}.`,
    ).join('\n'),
  ].join('\n\n');
}

function runId(sequence: number): string {
  return `synthetic-run-${sequence}`;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0').slice(-12)}`;
}

function timestamp(offsetMs: number): string {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + offsetMs).toISOString();
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readOptionalPositiveNumberEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
