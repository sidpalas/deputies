import { githubCallbackTarget } from '../integrations/github/callback-target.js';
import { slackCallbackTarget } from '../integrations/slack/callback-target.js';
import type { ExternalThreadRecord } from '../store/types.js';
import { isRepositoryAllowed } from '../integrations/github/repository-access.js';

export type ExternalCallbackResolverConfig = {
  slackBotConfigured: boolean;
  slackAllowedTeamIds: string[];
  slackAllowedChannelIds: string[];
  githubAppConfigured: boolean;
  githubAllowedRepositories: string[];
  githubReplyPhrase?: string;
  webBaseUrl?: string;
};
export type TrustedExternalCallback = {
  type: 'slack' | 'github';
  target: Record<string, unknown>;
};

export class ExternalBindingInvalidError extends Error {
  readonly code = 'external_binding_invalid';
}

/** Reconstructs a callback exclusively from persisted identity fields and current server policy. */
export function resolveExternalCallback(
  threads: ExternalThreadRecord[],
  sessionId: string,
  config: ExternalCallbackResolverConfig,
): TrustedExternalCallback | undefined {
  if (threads.length === 0) return undefined;
  if (threads.length !== 1) throw invalid('Session has multiple external thread bindings');
  const thread = threads[0]!;
  const metadata = thread.metadata;
  if (!isPlainObject(metadata)) throw invalid('External thread metadata is invalid');
  const sessionUrl = callbackSessionUrl(sessionId, config.webBaseUrl);

  if (thread.source === 'slack') {
    const teamId = nonempty(metadata.teamId),
      channel = nonempty(metadata.channel),
      threadTs = nonempty(metadata.threadTs);
    if (!teamId || !channel || !threadTs) throw invalid('Slack external thread metadata is invalid');
    if (!config.slackBotConfigured) throw invalid('Slack bot is not configured');
    if (
      (config.slackAllowedTeamIds.length > 0 && !config.slackAllowedTeamIds.includes(teamId)) ||
      (config.slackAllowedChannelIds.length > 0 && !config.slackAllowedChannelIds.includes(channel))
    )
      throw invalid('Slack external thread is not allowed');
    return {
      type: 'slack',
      target: slackCallbackTarget({
        channel,
        threadTs,
        messageTs: '',
        ...(sessionUrl ? { sessionUrl, includeSessionLink: true } : {}),
      }),
    };
  }
  if (thread.source === 'github') {
    const owner = nonempty(metadata.owner),
      repo = nonempty(metadata.repo),
      issueNumber = positiveInteger(metadata.number);
    if (!owner || !repo || !issueNumber) throw invalid('GitHub external thread metadata is invalid');
    if (!config.githubAppConfigured) throw invalid('GitHub App is not configured');
    if (!isRepositoryAllowed({ owner, repo }, config.githubAllowedRepositories))
      throw invalid('GitHub repository is not allowed');
    const phrase = config.githubReplyPhrase;
    return {
      type: 'github',
      target: githubCallbackTarget({
        owner,
        repo,
        issueNumber,
        ...(phrase ? { replyHint: `Include the phrase \`${phrase}\` to continue here.` } : {}),
        ...(sessionUrl ? { sessionUrl, includeSessionLink: true } : {}),
      }),
    };
  }
  throw invalid('External thread provider is not supported');
}

function callbackSessionUrl(sessionId: string, base?: string): string | undefined {
  if (!base) return undefined;
  const url = new URL(base);
  url.searchParams.set('session', sessionId);
  return url.toString();
}
function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function invalid(message: string) {
  return new ExternalBindingInvalidError(message);
}
