import { SerialEmitter } from '../../src/runner-pi/serial-emitter.js';

describe('SerialEmitter', () => {
  it('continues in order after a failure and surfaces the first emission error', async () => {
    const seen: number[] = [];
    const firstError = new Error('first emit failed');
    const emitter = new SerialEmitter<number>(async (value) => {
      seen.push(value);
      if (value === 1) throw firstError;
      if (value === 2) throw new Error('later emit failed');
    });

    emitter.enqueue(1);
    emitter.enqueue(2);
    emitter.enqueue(3);

    await expect(emitter.drain()).rejects.toBe(firstError);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('preserves a primary operation error after draining failed emissions', async () => {
    const primaryError = new Error('prompt failed');
    const emitter = new SerialEmitter<number>(async () => {
      throw new Error('emit failed');
    });
    emitter.enqueue(1);

    await expect(emitter.drain({ primaryError })).rejects.toBe(primaryError);
  });

  it('waits for values enqueued while it is draining', async () => {
    const seen: number[] = [];
    let emitter: SerialEmitter<number>;
    emitter = new SerialEmitter<number>(async (value) => {
      seen.push(value);
      if (value === 1) emitter.enqueue(2);
    });
    emitter.enqueue(1);

    await emitter.drain();
    expect(seen).toEqual([1, 2]);
  });
});
