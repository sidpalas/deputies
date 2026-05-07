import type { MessageRecord } from '../store/types.js';

export const ARCHIVED_SESSION_RECOVERY_PHRASE = 'unarchive and proceed';

export function archivedSessionNotice(): string {
  return `This Deputies session is archived, so I did not queue your message. Reply \`${ARCHIVED_SESSION_RECOVERY_PHRASE}\` to restore the session and queue your reply.`;
}

export function archivedSessionRecoveredNotice(): string {
  return 'Unarchived and ready. Send the next instruction when you want me to do work.';
}

export function includesArchivedSessionRecoveryPhrase(text: string | undefined): boolean {
  return Boolean(text?.toLowerCase().replace(/\s+/g, ' ').includes(ARCHIVED_SESSION_RECOVERY_PHRASE));
}

export function isArchivedSessionRecoveryOnly(text: string | undefined): boolean {
  const normalized = text
    ?.toLowerCase()
    .replace(/<@[a-z0-9]+>/gi, ' ')
    .replace(/@[a-z0-9][a-z0-9_-]*/gi, ' ')
    .replace(/[`*_~]/g, ' ')
    .replace(/[\s.!?"'(),:;\[\]{}-]+/g, ' ')
    .trim();
  return normalized === ARCHIVED_SESSION_RECOVERY_PHRASE;
}

export function archivedIgnoredTranscriptPrompt(text: string): string {
  return `${text}\n\n[Not queued: this Deputies session was archived.]`;
}

export function archivedRecoveryTranscriptPrompt(text: string): string {
  return `${text}\n\n[Session restored. No agent run was started because this message only contained the recovery phrase.]`;
}

export function unprocessedArchivedTranscriptMessages(messages: MessageRecord[], source: 'github' | 'slack'): MessageRecord[] {
  const alreadyIncluded = new Set(messages.flatMap(includedArchivedMessageIds));
  return messages.filter((message) => {
    if (message.source !== source || message.status !== 'cancelled' || !message.context?.transcriptOnly) return false;
    if (alreadyIncluded.has(message.id)) return false;
    return message.prompt.includes('[Not queued: this Deputies session was archived.]');
  });
}

export function archivedRecoveryWorkPrompt(input: { sourceLabel: string; archivedMessages: MessageRecord[]; recoveryText: string }): string {
  const lines = [`${input.sourceLabel} archived-session recovery:`, '---'];
  lines.push('The session was archived when these messages arrived. The user has now replied with the recovery phrase, so process the archived messages below.');
  lines.push('', 'Archived messages:', '---');
  for (const message of input.archivedMessages) {
    lines.push('', `Message ${message.sequence}:`, stripArchivedMarker(message.prompt));
  }
  lines.push('---', '', 'Recovery message:', input.recoveryText);
  return lines.join('\n');
}

function includedArchivedMessageIds(message: MessageRecord): string[] {
  const value = message.context?.includedArchivedMessageIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function stripArchivedMarker(prompt: string): string {
  return prompt.replace(/\n\n\[Not queued: this Deputies session was archived\.\]$/, '');
}
