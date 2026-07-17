export class SerialEmitter<T> {
  private tail: Promise<void> = Promise.resolve();
  private firstError: unknown;
  private failed = false;

  constructor(private readonly emit: (value: T) => Promise<void>) {}

  enqueue(value: T): void {
    this.tail = this.tail.then(async () => {
      try {
        await this.emit(value);
      } catch (error) {
        if (!this.failed) {
          this.failed = true;
          this.firstError = error;
        }
      }
    });
  }

  async drain(options: { primaryError?: unknown } = {}): Promise<void> {
    while (true) {
      const tail = this.tail;
      await tail;
      if (tail === this.tail) break;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'primaryError')) throw options.primaryError;
    if (this.failed) throw this.firstError;
  }
}
