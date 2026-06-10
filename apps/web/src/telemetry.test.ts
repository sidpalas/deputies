import { startSessionMilestoneInteraction } from './telemetry.js';

type SendBrowserMilestoneInput = {
  token: string;
  traceparent: string;
  milestone: Record<string, unknown>;
};

const { sendBrowserMilestoneMock } = vi.hoisted(() => ({
  sendBrowserMilestoneMock: vi.fn((_: SendBrowserMilestoneInput) => Promise.resolve()),
}));

vi.mock('./browser-milestones.js', () => ({
  sendBrowserMilestone: sendBrowserMilestoneMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  sendBrowserMilestoneMock.mockClear();
});

it('emits session detail ready without raw session identifiers and with trace context', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

  const interaction = startSessionMilestoneInteraction({ token: 'token', trigger: 'selection' });
  const requestTraceparent = interaction.detail.traceparent();

  interaction.detail.success({ messageCount: 1, eventCount: 2, inlineArtifactCount: 0, artifactCount: 3 });
  await Promise.resolve();

  expect(sendBrowserMilestoneMock).toHaveBeenCalledTimes(1);
  const call = sendBrowserMilestoneMock.mock.calls[0]![0];
  expect(call.token).toBe('token');
  expect(call.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(call.traceparent.split('-')[1]).toBe(requestTraceparent.split('-')[1]);
  expect(call.milestone).toMatchObject({
    name: 'session_detail_ready',
    result: 'success',
    trigger: 'selection',
    pageVisibility: 'visible',
    messageCount: 1,
    eventCount: 2,
    inlineArtifactCount: 0,
    artifactCount: 3,
  });
  expect(call.milestone.durationMs).toEqual(expect.any(Number));
  expect(call.milestone).not.toHaveProperty('sessionId');
  expect(call.milestone).not.toHaveProperty('traceId');
});
