import { expect, test, type Page } from '@playwright/test';

type SmokeArtifact = { id: string; title?: string; storageKey?: string };

test.describe('full-stack smoke', () => {
  test.skip(process.env.RUN_FULL_STACK_SMOKE !== 'true', 'Set RUN_FULL_STACK_SMOKE=true to run Docker smoke test');

  test('loads deployed-style web through Caddy and creates a session', async ({ page }) => {
    const repositoriesResponse = await page.request.get('/repositories');
    expect(repositoriesResponse.headers()['content-type']).toContain('application/json');

    await page.goto('/');

    await expect(page.getByText('Engineering agents for delegated work.')).toBeVisible();
    await expect(page.getByLabel('Model')).toContainText('smoke default');

    await page.getByPlaceholder('Ask Deputies to investigate, change code, or answer a question...').fill('smoke test');
    await page.getByRole('button', { name: 'Start session' }).click();

    await expect(page.getByPlaceholder('Ask your deputy to investigate, change code, or follow up...')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'smoke test' })).toBeVisible();
    await expect(page.getByText('Fake response for: smoke test')).toBeVisible();

    const sessionId = await latestSessionId(page);
    const artifact = await waitForSmokeArtifact(page, sessionId);

    const download = await page.request.get(`/sessions/${sessionId}/artifacts/${artifact.id}/download`);
    expect(download.headers()['content-type']).toContain('text/plain');
    await expect(download.text()).resolves.toBe('hello artifact storage');
  });
});

async function latestSessionId(page: Page) {
  const response = await page.request.get('/sessions');
  const body = (await response.json()) as { sessions: Array<{ id: string; title?: string; updatedAt: string }> };
  const [session] = body.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!session) throw new Error('Expected at least one session');
  return session.id;
}

async function waitForSmokeArtifact(page: Page, sessionId: string): Promise<SmokeArtifact> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await page.request.get(`/sessions/${sessionId}/artifacts`);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { artifacts: SmokeArtifact[] };
    const artifact = body.artifacts.find((candidate) => candidate.title === 'Smoke Artifact');
    if (artifact) return artifact;
    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for smoke artifact');
}
