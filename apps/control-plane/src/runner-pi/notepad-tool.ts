import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  executeNotepadTool,
  notepadToolDescription,
  notepadToolParameters,
  type NotepadToolServices,
} from '../notepads/tool.js';

export function createPiNotepadToolDefinition(services: NotepadToolServices): ToolDefinition {
  return {
    name: 'notepad',
    label: 'notepad',
    description: notepadToolDescription,
    promptSnippet: 'Use durable Notepad memory for multi-step and resumed work',
    promptGuidelines: [
      'Notepad is durable external memory. Consult and update it for nontrivial multi-step or resumed work.',
      'Keep notes concise: objectives, findings, blockers, and next actions.',
      'Omit notepadId for read, replace, patch, append, history, read_revision, and restore_revision to target your own Session Notepad. Search and read any Explicit Notepad available through a readable Session association; writes require your Session to be associated.',
      'Use read_session, replace_session, patch_session, or append_session with sessionId to coordinate another Session Notepad available to this session.',
      'When creating an Explicit Notepad, provide content to initialize it atomically when you already know the starting notes.',
      'If an Explicit Notepad write is denied for lack of association, ask an associated Session to grant access, then retry against the latest revision.',
      'Explicit Notepads may be shared with and modified by other Sessions, agents, or humans. Re-read before replacing shared content, preserve others’ notes, and prefer targeted patch or append operations.',
      'Never record hidden chain-of-thought or a command transcript in Notepad.',
      'Notepad updates do not send Messages or wake Sessions.',
    ],
    parameters: notepadToolParameters,
    executionMode: 'sequential',
    async execute(_id, params) {
      const result = await executeNotepadTool(services, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
