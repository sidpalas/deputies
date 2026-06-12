import type { Hono } from 'hono';
import { requireSlackSigningSecret, type AppConfig } from '../config/index.js';
import { GenericWebhookError } from '../integrations/generic-webhook/service.js';
import { verifyGitHubWebhookSignature } from '../integrations/github/webhook-auth.js';
import { GitHubWebhookService } from '../integrations/github/webhook-service.js';
import { verifySlackSignature } from '../integrations/slack/auth.js';
import { SlackClient } from '../integrations/slack/client.js';
import { SlackIntegrationError, SlackIntegrationService } from '../integrations/slack/service.js';
import type { SlackEventEnvelope } from '../integrations/slack/types.js';
import { writeError } from './http-error.js';
import { readJsonBody, readRawBody } from './request.js';
import type { AppServices, AppVariables } from './server.js';

export function registerWebhookRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  app.post('/webhooks/generic/:sourceKey', async (c) => {
    const body = await readJsonBody(c, config.maxJsonBodyBytes);

    try {
      const result = await services.genericWebhooks.handle({
        sourceKey: c.req.param('sourceKey'),
        authorization: c.req.header('authorization'),
        payload: body,
      });
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof GenericWebhookError) {
        const status = error.code === 'unauthorized' ? 401 : error.code === 'not_found' ? 404 : 400;
        return writeError(c, status, error.code, error.message);
      }
      throw error;
    }
  });

  app.post('/webhooks/slack/events', async (c) => {
    const body = await readRawBody(c, config.maxJsonBodyBytes, 'Slack body');
    const signingSecret = requireSlackSigningSecret(config);
    const signatureValid = verifySlackSignature({
      signature: c.req.header('x-slack-signature'),
      timestamp: c.req.header('x-slack-request-timestamp'),
      body,
      signingSecret,
    });
    if (!signatureValid) return writeError(c, 401, 'unauthorized', 'Invalid Slack signature');

    let payload: SlackEventEnvelope;
    try {
      payload = JSON.parse(body) as SlackEventEnvelope;
    } catch {
      return writeError(c, 400, 'invalid_json', 'Expected valid Slack JSON payload');
    }

    try {
      const slackClient = config.slackBotToken
        ? new SlackClient({ apiBaseUrl: config.slackApiBaseUrl, botToken: config.slackBotToken })
        : null;
      const slackOptions = config.slackBotToken
        ? {
            assistantThreadClient: slackClient!,
            replyClient: slackClient!,
            reactionClient: slackClient!,
            threadClient: slackClient!,
            infoClient: slackClient!,
            allowedTeamIds: config.slackAllowedTeamIds,
            allowedChannelIds: config.slackAllowedChannelIds,
            allowedUserIds: config.slackAllowedUserIds,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          }
        : {
            allowedTeamIds: config.slackAllowedTeamIds,
            allowedChannelIds: config.slackAllowedChannelIds,
            allowedUserIds: config.slackAllowedUserIds,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          };
      const result = await new SlackIntegrationService(
        services.store,
        services.sessions,
        services.messages,
        slackOptions,
      ).handle(payload);
      if (result.type === 'challenge') return c.json({ challenge: result.challenge });
      return c.json({ ok: true, type: result.type });
    } catch (error) {
      if (error instanceof SlackIntegrationError) return writeError(c, 400, error.code, error.message);
      throw error;
    }
  });

  app.post('/webhooks/github/events', async (c) => {
    const body = await readRawBody(c, config.maxJsonBodyBytes, 'GitHub body');
    if (!config.githubWebhookSecret)
      return writeError(c, 500, 'configuration_error', 'GITHUB_WEBHOOK_SECRET is required for GitHub webhooks');
    const signatureValid = verifyGitHubWebhookSignature({
      signature: c.req.header('x-hub-signature-256'),
      body,
      secret: config.githubWebhookSecret,
    });
    if (!signatureValid) return writeError(c, 401, 'unauthorized', 'Invalid GitHub signature');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return writeError(c, 400, 'invalid_json', 'Expected valid GitHub JSON payload');
    }

    const headers: { deliveryId?: string; event?: string } = {};
    const deliveryId = c.req.header('x-github-delivery');
    const event = c.req.header('x-github-event');
    if (deliveryId) headers.deliveryId = deliveryId;
    if (event) headers.event = event;

    const result = await new GitHubWebhookService(services.store, services.sessions, services.messages, {
      allowedUsers: config.githubWebhookAllowedUsers,
      allowedOrganizations: config.githubWebhookAllowedOrganizations,
      allowedRepositories: config.githubAllowedRepositories,
      triggerPhrases: config.githubWebhookTriggerPhrases,
      ...(services.githubReactionSender ? { reactionSender: services.githubReactionSender } : {}),
      ...(services.githubIssueContextFetcher ? { issueContextFetcher: services.githubIssueContextFetcher } : {}),
      ...(services.githubArchivedSessionNotifier
        ? { archivedSessionNotifier: services.githubArchivedSessionNotifier }
        : {}),
      ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
    }).handle({ headers, payload });
    return c.json(
      { ok: true, type: result.type, ...('reason' in result ? { reason: result.reason } : {}) },
      result.type === 'accepted' ? 202 : 200,
    );
  });
}
