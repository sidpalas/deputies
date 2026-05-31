import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';

const localStorageItems = new Map<string, string>();
const sessionStorageItems = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    clear: vi.fn(() => localStorageItems.clear()),
    getItem: vi.fn((key: string) => localStorageItems.get(key) ?? null),
    removeItem: vi.fn((key: string) => localStorageItems.delete(key)),
    setItem: vi.fn((key: string, value: string) => localStorageItems.set(key, value)),
  },
});

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    clear: vi.fn(() => sessionStorageItems.clear()),
    getItem: vi.fn((key: string) => sessionStorageItems.get(key) ?? null),
    removeItem: vi.fn((key: string) => sessionStorageItems.delete(key)),
    setItem: vi.fn((key: string, value: string) => sessionStorageItems.set(key, value)),
  },
});

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
