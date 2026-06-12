// The instance that starts a sandbox owns which platform cookies the bridge
// strips from forwarded preview requests. Providers inject this env var into
// every bridge launch; the defaults mirror the bridge's built-in list.
export const sandboxBridgeSkipCookieNamesEnv = 'DEPUTIES_SANDBOX_SKIP_COOKIE_NAMES';

export function sandboxBridgeSkippedCookieNames(config: {
  previewCookieName?: string | undefined;
  sessionCookieName?: string | undefined;
}): string {
  return [config.previewCookieName || 'deputies_preview', config.sessionCookieName || 'dev_deputies_session'].join(',');
}
