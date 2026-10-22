/** Runs async jobs one at a time, in order. Each web chat tab can only answer one prompt at once. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  /** True while a job is running or queued. */
  get locked(): boolean {
    return this.pending > 0;
  }

  get queued(): number {
    return Math.max(0, this.pending - 1);
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      this.pending--;
    });
    return result;
  }
}
