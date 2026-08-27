interface PendingProducer<T> {
  item: T;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** A FIFO queue whose producers wait whenever the configured buffer is full. */
export class AsyncBoundedQueue<T> {
  private readonly items: T[] = [];
  private readonly consumers: Array<(item: T | undefined) => void> = [];
  private readonly producers: Array<PendingProducer<T>> = [];
  private closed = false;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Queue capacity must be a positive integer.");
    }
  }

  enqueue(item: T): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Cannot enqueue into a closed queue."));
    }

    const consumer = this.consumers.shift();
    if (consumer) {
      consumer(item);
      return Promise.resolve();
    }

    if (this.items.length < this.capacity) {
      this.items.push(item);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.producers.push({ item, resolve, reject });
    });
  }

  async dequeue(): Promise<T | undefined> {
    const item = this.items.shift();
    if (item !== undefined) {
      this.admitProducer();
      return item;
    }

    if (this.closed) return undefined;

    return await new Promise<T | undefined>((resolve) => {
      this.consumers.push(resolve);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    const error = new Error("Cannot enqueue into a closed queue.");
    for (const producer of this.producers.splice(0)) producer.reject(error);
    if (this.items.length === 0) {
      for (const consumer of this.consumers.splice(0)) consumer(undefined);
    }
  }

  private admitProducer(): void {
    const producer = this.producers.shift();
    if (producer) {
      this.items.push(producer.item);
      producer.resolve();
      return;
    }

    if (this.closed && this.items.length === 0) {
      for (const consumer of this.consumers.splice(0)) consumer(undefined);
    }
  }
}
