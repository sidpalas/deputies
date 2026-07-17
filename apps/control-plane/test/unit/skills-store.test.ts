import { beforeEach } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { defineSkillsStoreContract } from '../support/skills-store-contract.js';

describe('MemoryStore skills', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  defineSkillsStoreContract(() => store);
});
