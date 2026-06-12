import type { Hono } from 'hono';
import type { AppConfig } from '../config/index.js';
import { buildSetupStatus } from './setup-status.js';
import type { AppServices, AppVariables } from './server.js';

export function registerSetupRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: AppConfig,
  services: AppServices,
): void {
  app.get('/setup/status', async (c) => c.json(await buildSetupStatus(config, services)));
}
