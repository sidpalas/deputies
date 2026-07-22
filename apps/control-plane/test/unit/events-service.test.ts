import { describe, expect, it, vi } from 'vitest';

import { EventService } from '../../src/events/service.js';
import { MemoryStore } from '../../src/store/memory.js';

describe('EventService', () => {
  it('removes NUL bytes from nested event payload strings', async () => {
    const events = new EventService(new MemoryStore());

    const event = await events.append({
      sessionId: 'session-1',
      type: 'tool_finished',
      payload: {
        toolName: 'shell',
        result: {
          text: 'before\u0000after',
          nested: ['a\u0000b', { stderr: '\u0000error' }],
        },
      },
    });

    expect(event.payload).toMatchObject({
      result: {
        text: 'beforeafter',
        nested: ['ab', { stderr: 'error' }],
      },
    });
    expect(JSON.stringify(event.payload)).not.toContain('\u0000');
  });

  it('delivers Notepad association invalidations through the default global feed', async () => {
    const events = new EventService(new MemoryStore());
    const subscriber = vi.fn();
    events.subscribeAll(subscriber);

    const event = await events.append({
      sessionId: 'session-1',
      type: 'notepad_associations_changed',
      payload: {},
    });

    expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ id: event.id, payload: {} }));
    await expect(events.listAll()).resolves.toEqual([
      expect.objectContaining({ id: event.id, type: 'notepad_associations_changed', payload: {} }),
    ]);
  });
});
