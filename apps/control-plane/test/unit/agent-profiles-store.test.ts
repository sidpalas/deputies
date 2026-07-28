import { beforeEach, describe } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { defineAgentProfilesStoreContract } from '../support/agent-profiles-store-contract.js';

describe('MemoryStore agent profiles', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });
  defineAgentProfilesStoreContract(() => store);
});
