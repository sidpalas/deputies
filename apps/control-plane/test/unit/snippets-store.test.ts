import { beforeEach, describe } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { defineSnippetsStoreContract } from '../support/snippets-store-contract.js';

describe('MemoryStore snippets', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });
  defineSnippetsStoreContract(() => store);
});
