import type { AgentEvent, Message } from '../../../api.js';

export type MessageGroup = {
  key: string;
  messages: Message[];
  responseMessageId: string;
  runId?: string;
};

export function buildAssistantText(events: AgentEvent[]): Record<string, string> {
  const messageIdsBySequence: Record<number, string> = {};
  const outputByMessageId: Record<string, string> = {};
  let currentSequence = 0;
  let currentMessageId = '';

  for (const event of events) {
    const maybeSequence = event.payload.sequence;
    if (typeof maybeSequence === 'number') {
      currentSequence = maybeSequence;
      if (event.messageId) messageIdsBySequence[maybeSequence] = event.messageId;
    }
    if (event.messageId) currentMessageId = event.messageId;
    const messageId = event.messageId || currentMessageId || messageIdsBySequence[currentSequence];
    if (!messageId) continue;
    const text = event.payload.text;
    if (typeof text !== 'string') continue;
    if (event.type === 'agent_response_final') {
      outputByMessageId[messageId] = text;
    } else if (event.type === 'agent_text_delta') {
      outputByMessageId[messageId] = `${outputByMessageId[messageId] ?? ''}${text}`;
    }
  }

  return outputByMessageId;
}

export function formatAssistantDisplayText(text: string): string {
  return text.replace(/([.!?])(?=[A-Z])/g, '$1 ').replace(/:(?=[A-Z][a-z])/g, ': ');
}

export function groupMessagesByRun(messages: Message[], events: AgentEvent[]): MessageGroup[] {
  const batchBySequence = new Map<number, { runId: string; sequences: number[] }>();
  for (const event of events) {
    if (event.type !== 'message_started' || !event.runId) continue;
    const sequences = Array.isArray(event.payload.sequences)
      ? event.payload.sequences.filter((value): value is number => typeof value === 'number')
      : [];
    if (sequences.length <= 1) continue;
    for (const sequence of sequences) batchBySequence.set(sequence, { runId: event.runId, sequences });
  }

  const groups: MessageGroup[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (seen.has(message.id)) continue;
    const batch = batchBySequence.get(message.sequence);
    if (!batch) {
      groups.push({ key: message.id, messages: [message], responseMessageId: message.id });
      seen.add(message.id);
      continue;
    }

    const minSequence = Math.min(...batch.sequences);
    const maxSequence = Math.max(...batch.sequences);
    const batchSequenceSet = new Set(batch.sequences);
    const batchMessages = messages.filter((candidate) => {
      if (batchSequenceSet.has(candidate.sequence)) return true;
      return candidate.status === 'cancelled' && candidate.sequence > minSequence && candidate.sequence < maxSequence;
    });
    for (const item of batchMessages) seen.add(item.id);
    groups.push({
      key: batch.runId,
      messages: batchMessages,
      responseMessageId: batchMessages[0]?.id ?? message.id,
      runId: batch.runId,
    });
  }

  return groups;
}

export function isActiveRunGroup(messages: Message[]): boolean {
  return messages.some((message) => message.status === 'processing' || message.status === 'cancelling');
}

export function isCancellingRunGroup(messages: Message[]): boolean {
  return messages.some((message) => message.status === 'cancelling');
}

export function groupDiagnosticsByRun(events: AgentEvent[]): Record<string, AgentEvent[]> {
  const grouped: Record<string, AgentEvent[]> = {};
  for (const event of events) {
    if (event.type === 'message_created' || event.type === 'agent_text_delta' || event.type === 'agent_response_final')
      continue;
    for (const key of diagnosticGroupKeys(event)) {
      const group = grouped[key] ?? [];
      group.push(event);
      grouped[key] = group;
    }
  }
  return grouped;
}

function diagnosticGroupKeys(event: AgentEvent): string[] {
  const keys = [event.runId, event.messageId].filter((key): key is string => Boolean(key));
  return Array.from(new Set(keys));
}
