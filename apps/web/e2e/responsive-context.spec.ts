import { expect, test, type Page } from '@playwright/test';

const sessionId = '00000000-0000-4000-8000-000000000001';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('keeps context collapsed by default on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const messageLog = page.getByRole('log', { name: 'Session messages' });
  await expect(messageLog).toBeVisible();
  await expect(page.getByPlaceholder('Ask your deputy to investigate, change code, or follow up...')).toBeVisible();

  const contextDisclosure = page.locator('details').filter({ has: page.getByText('Context', { exact: true }) });
  await expect(contextDisclosure).toBeVisible();
  await expect(contextDisclosure).not.toHaveAttribute('open', '');
  await expect(contextDisclosure.getByText('Completion reply')).not.toBeVisible();

  const messageLogHeight = await messageLog.evaluate((element) => element.getBoundingClientRect().height);
  expect(messageLogHeight).toBeGreaterThan(300);
});

test('keeps mobile session controls in a left-aligned row above the session header', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const openSessions = page.getByRole('button', { name: 'Open sessions' });
  const newSession = page.getByRole('button', { name: 'New session' });
  const title = page.getByRole('heading', { name: 'Existing session' });

  await expect(openSessions).toBeVisible();
  await expect(newSession).toBeVisible();
  await expect(title).toBeVisible();

  const controls = openSessions.locator('..');
  await expect(controls).toHaveCSS('position', 'static');
  const controlsBox = await controls.evaluate((element) => element.getBoundingClientRect().toJSON());
  const titleBox = await title.evaluate((element) => element.getBoundingClientRect().toJSON());
  expect(rectsOverlap(controlsBox, titleBox)).toBe(false);
  expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual(titleBox.y);
  expect(controlsBox.x).toBeLessThanOrEqual(titleBox.x);
});

test('shows context as a sidebar on wide screens', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Context' })).toBeVisible();
  await page.locator('aside').getByText(/http ·/).click();
  await expect(page.locator('aside').getByText('Type: Completion reply')).toBeVisible();
  await expect(page.locator('details').filter({ has: page.getByText('Context', { exact: true }) })).not.toBeVisible();
});

async function mockApi(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === '/health') {
      await route.fulfill({ json: { status: 'ok', runMode: 'all', apiAuthMode: 'none' } });
      return;
    }

    if (url.pathname === '/sessions') {
      await route.fulfill({ json: { sessions: [session] } });
      return;
    }

    if (url.pathname === `/sessions/${sessionId}/messages`) {
      await route.fulfill({ json: { messages } });
      return;
    }

    if (url.pathname === `/sessions/${sessionId}/events`) {
      await route.fulfill({ json: { events } });
      return;
    }

    if (url.pathname === `/sessions/${sessionId}/artifacts`) {
      await route.fulfill({ json: { artifacts: [] } });
      return;
    }

    if (url.pathname === `/sessions/${sessionId}/callbacks`) {
      await route.fulfill({ json: { callbacks } });
      return;
    }

    if (url.pathname === '/events/stream') {
      await route.fulfill({
        body: '',
        headers: { 'content-type': 'text/event-stream' },
      });
      return;
    }

    await route.fallback();
  });
}

const session = {
  id: sessionId,
  status: 'idle',
  title: 'Existing session',
  createdAt: '2026-05-05T12:00:00.000Z',
  updatedAt: '2026-05-05T12:00:00.000Z',
  context: { repository: { provider: 'github', owner: 'example', repo: 'repo' } },
};

const messages = [{
  id: '00000000-0000-4000-8000-000000000101',
  sessionId,
  sequence: 1,
  status: 'completed',
  prompt: 'Check the responsive context panel behavior.',
  createdAt: '2026-05-05T12:01:00.000Z',
}];

const events = [{
  sessionId,
  sequence: 1,
  type: 'agent_response_final',
  messageId: '00000000-0000-4000-8000-000000000101',
  payload: { text: 'Responsive context check complete.' },
  createdAt: '2026-05-05T12:02:00.000Z',
}];

type Rect = { x: number; y: number; width: number; height: number };

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

const callbacks = [{
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
}];
