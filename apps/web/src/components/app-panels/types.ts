export type ThemePreference = 'light' | 'dark' | 'system';

export type ConnectionStatus = {
  state: 'ok' | 'delayed' | 'reconnecting';
  message: string;
};
