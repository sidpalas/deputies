import { AppLifecycle } from '../../src/app/lifecycle.js';

describe('AppLifecycle', () => {
  it('closes resources once during shutdown', async () => {
    const calls: string[] = [];
    const lifecycle = new AppLifecycle({
      resources: [
        {
          async close() {
            calls.push('store');
          },
        },
        {
          close() {
            calls.push('flue-store');
          },
        },
      ],
    });

    await lifecycle.shutdown('test');
    await lifecycle.shutdown('duplicate');

    expect(calls).toEqual(['store', 'flue-store']);
  });

  it('stops worker loop before closing resources', async () => {
    const calls: string[] = [];
    const lifecycle = new AppLifecycle({
      workerLoop: {
        async stop() {
          calls.push('worker');
        },
      },
      resources: [
        {
          async close() {
            calls.push('resource');
          },
        },
      ],
    });

    await lifecycle.shutdown('test');

    expect(calls).toEqual(['worker', 'resource']);
  });
});
