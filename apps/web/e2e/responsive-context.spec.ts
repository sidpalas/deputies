import { expect, test, type Page } from '@playwright/test';

const sessionId = '00000000-0000-4000-8000-000000000001';

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('keeps context collapsed by default on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.getByRole('log', { name: 'Session messages' })).toBeVisible();
  await expect(page.getByPlaceholder('Ask your deputy to investigate, change code, or follow up...')).toBeVisible();

  const contextDisclosure = page.locator('details').filter({ has: page.getByText('Context', { exact: true }) });
  await expect(contextDisclosure).toBeVisible();
  await expect(contextDisclosure).not.toHaveAttribute('open', '');
  await expect(contextDisclosure.getByText('Completion reply')).not.toBeVisible();

  const messageLogBox = await page.getByRole('log', { name: 'Session messages' }).boundingBox();
  expect(messageLogBox?.height).toBeGreaterThan(300);
});

test('keeps context collapsed around tablet and small desktop widths', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/');

  const contextDisclosure = page.locator('details').filter({ has: page.getByText('Context', { exact: true }) });
  await expect(contextDisclosure).toBeVisible();
  await expect(contextDisclosure).not.toHaveAttribute('open', '');
  await expect(page.getByRole('heading', { name: 'Context' })).not.toBeVisible();
});

test('keeps the mobile sessions navigation dock reachable on short screens', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await page.goto('/');

  await page.getByRole('button', { name: 'Open sessions' }).click();
  const pageSwitcher = page.getByRole('button', { name: 'Switch page, current page Sessions' });
  const themeAction = page.getByRole('button', { name: 'Theme: System. Change theme' });
  await expect(pageSwitcher).toBeVisible();
  await expect(themeAction).toBeVisible();

  for (const control of [pageSwitcher, themeAction]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(480);
  }

  await pageSwitcher.click();
  await expect(page.getByRole('menuitem', { name: /Setup/ })).toBeVisible();
});

test('shows context as a sidebar on wide screens', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Context' })).toBeVisible();
  await page
    .locator('aside')
    .getByText(/http ·/)
    .click();
  await expect(page.locator('aside').getByText('Type: Completion reply')).toBeVisible();
  await expect(page.locator('details').filter({ has: page.getByText('Context', { exact: true }) })).not.toBeVisible();
});

async function mockApi(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const apiPath = normalizeApiPath(url.pathname);

    if (apiPath === '/health') {
      await route.fulfill({
        json: { status: 'ok', runMode: 'combined', apiAuthMode: 'none', hideSetupPage: true },
      });
      return;
    }

    if (apiPath === '/models') {
      await route.fulfill({ json: { models: [], modelChoices: [], defaultModel: null } });
      return;
    }

    if (apiPath === '/repositories') {
      await route.fulfill({ json: { repositories: [] } });
      return;
    }

    if (apiPath === '/groups') {
      await route.fulfill({ json: { groups: [] } });
      return;
    }

    if (apiPath === '/automations') {
      await route.fulfill({ json: { automations: [] } });
      return;
    }

    if (apiPath === '/sessions') {
      await route.fulfill({ json: { sessions: [session] } });
      return;
    }

    if (apiPath === `/sessions/${sessionId}/messages`) {
      await route.fulfill({ json: { messages } });
      return;
    }

    if (apiPath === `/sessions/${sessionId}/events`) {
      await route.fulfill({ json: { events } });
      return;
    }

    if (apiPath === `/sessions/${sessionId}/artifacts`) {
      await route.fulfill({ json: { artifacts: [] } });
      return;
    }

    if (apiPath === `/sessions/${sessionId}/services`) {
      await route.fulfill({ json: { services: [] } });
      return;
    }

    if (apiPath === `/sessions/${sessionId}/callbacks`) {
      await route.fulfill({ json: { callbacks } });
      return;
    }

    if (apiPath === `/sessions/${sessionId}/external-resources`) {
      await route.fulfill({ json: { externalResources: [] } });
      return;
    }

    if (apiPath === '/events/stream') {
      await route.fulfill({
        body: '',
        headers: { 'content-type': 'text/event-stream' },
      });
      return;
    }

    if (isApiPath(apiPath)) {
      await route.fulfill({ status: 404, json: { error: 'not_found', message: 'Not found' } });
      return;
    }

    await route.continue();
  });
}

function normalizeApiPath(pathname: string): string {
  return pathname.startsWith('/api/') ? pathname.slice('/api'.length) : pathname;
}

function isApiPath(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname === '/models' ||
    pathname === '/repositories' ||
    pathname === '/groups' ||
    pathname === '/automations' ||
    pathname === '/sessions' ||
    pathname.startsWith('/sessions/') ||
    pathname === '/events/stream' ||
    pathname.startsWith('/auth/')
  );
}

const session = {
  id: sessionId,
  status: 'idle',
  title: 'Existing session',
  createdAt: '2026-05-05T12:00:00.000Z',
  updatedAt: '2026-05-05T12:00:00.000Z',
  context: { repository: { provider: 'github', owner: 'example', repo: 'repo' } },
};

const messages = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    sessionId,
    sequence: 1,
    status: 'completed',
    prompt: 'Check the responsive context panel behavior.',
    createdAt: '2026-05-05T12:01:00.000Z',
  },
];

const events = [
  {
    sessionId,
    sequence: 1,
    type: 'agent_response_final',
    messageId: '00000000-0000-4000-8000-000000000101',
    payload: { text: 'Responsive context check complete.' },
    createdAt: '2026-05-05T12:02:00.000Z',
  },
];

const callbacks = [
  {
    id: '00000000-0000-4000-8000-000000000301',
    sessionId,
    targetType: 'http',
    target: { url: 'https://example.com/callback' },
    status: 'delivered',
    eventType: 'message_completed',
    payload: { text: 'done' },
    attempts: 1,
    maxAttempts: 5,
    createdAt: '2026-05-05T12:03:00.000Z',
    updatedAt: '2026-05-05T12:03:00.000Z',
  },
];
