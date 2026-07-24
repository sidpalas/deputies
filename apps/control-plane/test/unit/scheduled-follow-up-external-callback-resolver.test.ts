import { describe, expect, it } from 'vitest';
import {
  ExternalBindingInvalidError,
  resolveExternalCallback,
  type ExternalCallbackResolverConfig,
} from '../../src/scheduled-follow-ups/external-callback-resolver.js';
import type { ExternalThreadRecord } from '../../src/store/types.js';

const config: ExternalCallbackResolverConfig = {
  slackBotConfigured: true,
  slackAllowedTeamIds: ['T1'],
  slackAllowedChannelIds: ['C1'],
  githubAppConfigured: true,
  githubAllowedRepositories: ['Acme/Widgets'],
  githubReplyPhrase: '@deputies',
  webBaseUrl: 'https://deputies.example/app',
};

describe('scheduled follow-up external callback resolver', () => {
  it('reconstructs only trusted Slack fields', () => {
    const result = resolveExternalCallback(
      [
        thread('slack', {
          teamId: 'T1',
          channel: 'C1',
          threadTs: '123.4',
          url: 'https://evil.test',
          replyHint: 'evil',
        }),
      ],
      'session-1',
      config,
    );
    expect(result).toEqual({
      type: 'slack',
      target: {
        type: 'slack',
        channel: 'C1',
        threadTs: '123.4',
        replyHint: 'Tag `@deputies` in replies to continue here.',
        sessionUrl: 'https://deputies.example/app?session=session-1',
        includeSessionLink: true,
      },
    });
  });

  it('reconstructs GitHub case-insensitively and ignores persisted callback fields', () => {
    expect(
      resolveExternalCallback(
        [
          thread('github', {
            owner: 'ACME',
            repo: 'widgets',
            number: 42,
            issueNumber: 999,
            sessionUrl: 'https://evil.test',
          }),
        ],
        'session-2',
        config,
      ),
    ).toMatchObject({ type: 'github', target: { owner: 'ACME', repo: 'widgets', issueNumber: 42 } });
  });

  it.each([
    [[thread('slack', { teamId: 'other', channel: 'C1', threadTs: '1' })], config],
    [[thread('github', { owner: 'other', repo: 'repo', number: 1 })], config],
    [[thread('github', { owner: 'Acme', repo: 'Widgets', number: 0 })], config],
    [[thread('slack', { teamId: 'T1', channel: 'C1', threadTs: '1' })], { ...config, slackBotConfigured: false }],
    [[thread('github', { owner: 'Acme', repo: 'Widgets', number: 1 })], { ...config, githubAppConfigured: false }],
  ])('rejects invalid metadata, policy, and provider configuration', (threads, resolverConfig) => {
    expect(() => resolveExternalCallback(threads, 'session', resolverConfig)).toThrow(ExternalBindingInvalidError);
  });

  it('rejects multiple bindings rather than fanning out', () => {
    expect(() =>
      resolveExternalCallback(
        [
          thread('slack', { teamId: 'T1', channel: 'C1', threadTs: '1' }),
          thread('github', { owner: 'Acme', repo: 'Widgets', number: 1 }),
        ],
        'session',
        config,
      ),
    ).toThrow('multiple external thread bindings');
  });

  it('treats empty provider lists as allow-all and supports GitHub owner wildcards', () => {
    expect(
      resolveExternalCallback(
        [thread('slack', { teamId: 'any-team', channel: 'any-channel', threadTs: '1' })],
        'session',
        { ...config, slackAllowedTeamIds: [], slackAllowedChannelIds: [] },
      ),
    ).toBeDefined();
    expect(
      resolveExternalCallback([thread('github', { owner: 'Acme', repo: 'anything', number: 1 })], 'session', {
        ...config,
        githubAllowedRepositories: ['acme/*'],
      }),
    ).toBeDefined();
    expect(
      resolveExternalCallback([thread('github', { owner: 'Anyone', repo: 'anything', number: 1 })], 'session', {
        ...config,
        githubAllowedRepositories: [],
      }),
    ).toBeDefined();
  });
});

function thread(source: string, metadata: Record<string, unknown>): ExternalThreadRecord {
  return {
    id: `${source}-id`,
    source,
    externalId: `${source}-external`,
    sessionId: 'session',
    metadata,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
