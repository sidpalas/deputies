import type { Hono } from 'hono';
import type { AppConfig } from '../config/index.js';
import { configuredModels, modelChoices } from './model-availability.js';
import type { AppServices, AppVariables } from './server.js';

export function registerModelRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  app.get('/models', async (c) => {
    const models = configuredModels(config);
    return c.json({
      models,
      modelChoices: modelChoices(config, services.modelAvailability),
      defaultModel: config.runnerModelDefault ?? models[0] ?? null,
      defaultReasoningLevel: config.runnerReasoningLevelDefault ?? null,
    });
  });
}
