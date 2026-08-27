export type OrderedTaskResult<TInput, TKey, TValue> =
  | OrderedTaskFulfilledResult<TInput, TKey, TValue>
  | OrderedTaskRejectedResult<TInput, TKey>;

export interface OrderedTaskFulfilledResult<TInput, TKey, TValue> {
  readonly status: "fulfilled";
  readonly index: number;
  readonly input: TInput;
  readonly key: TKey;
  readonly value: TValue;
}

export interface OrderedTaskRejectedResult<TInput, TKey> {
  readonly status: "rejected";
  readonly index: number;
  readonly input: TInput;
  readonly key: TKey;
  readonly reason: unknown;
}

export interface OrderedKeyedTaskContext<TInput, TKey, TValue> {
  readonly index: number;
  readonly key: TKey;
  /** The settled result of the immediately preceding task with the same key. */
  readonly previous: OrderedTaskResult<TInput, TKey, TValue> | undefined;
}

export interface OrderedKeyedTaskOptions<TInput, TKey, TValue> {
  /** Maximum number of task callbacks running at once. */
  readonly concurrency: number;
  /**
   * Maximum admitted tasks whose ordered callbacks have not completed. Use a
   * value larger than `concurrency` to bound buffering without fixed batches.
   */
  readonly maximumPendingResults?: number;
  readonly keyOf: (input: TInput, index: number) => TKey;
  readonly run: (
    input: TInput,
    context: OrderedKeyedTaskContext<TInput, TKey, TValue>,
  ) => TValue | PromiseLike<TValue>;
  /**
   * Publishes settled results in input order. The next result is not published
   * until this callback settles, while worker tasks continue in the background.
   */
  readonly onOrderedResult?: (
    result: OrderedTaskResult<TInput, TKey, TValue>,
  ) => void | PromiseLike<void>;
}

/**
 * Runs keyed tasks with bounded concurrency and returns settled results in input
 * order. Tasks sharing a key never overlap and can inspect their predecessor's
 * result to implement retry-after-failure or suppress-after-success behavior.
 */
export async function runOrderedKeyedTasks<TInput, TKey, TValue>(
  inputs: readonly TInput[],
  options: OrderedKeyedTaskOptions<TInput, TKey, TValue>,
): Promise<ReadonlyArray<OrderedTaskResult<TInput, TKey, TValue>>> {
  validateConcurrency(options.concurrency);
  const maximumPendingResults =
    options.maximumPendingResults ?? Math.max(1, inputs.length);
  validateMaximumPendingResults(maximumPendingResults);

  const semaphore = new Semaphore(options.concurrency);
  const admissionWindow = new AdmissionWindow(maximumPendingResults);
  const keyTails = new Map<
    TKey,
    Promise<OrderedTaskResult<TInput, TKey, TValue>>
  >();

  const pending = inputs.map((input, index) => {
    const key = options.keyOf(input, index);
    const previous = keyTails.get(key);
    const task = runAdmittedTask(
      input,
      index,
      key,
      previous,
      admissionWindow,
      semaphore,
      options.run,
    );
    keyTails.set(key, task.then((admitted) => admitted.result));
    return task;
  });

  const results: Array<OrderedTaskResult<TInput, TKey, TValue>> = [];
  try {
    for (const task of pending) {
      const admitted = await task;
      results.push(admitted.result);
      try {
        await options.onOrderedResult?.(admitted.result);
      } finally {
        admitted.release();
      }
    }
  } catch (error) {
    // Tasks already admitted by the bounded scheduler must settle before the
    // caller releases their external resources (mailbox locks, files, etc.).
    admissionWindow.openFully();
    await Promise.all(pending);
    throw error;
  }
  return results;
}

interface AdmittedTask<TInput, TKey, TValue> {
  result: OrderedTaskResult<TInput, TKey, TValue>;
  release: () => void;
}

async function runAdmittedTask<TInput, TKey, TValue>(
  input: TInput,
  index: number,
  key: TKey,
  previousPromise: Promise<OrderedTaskResult<TInput, TKey, TValue>> | undefined,
  admissionWindow: AdmissionWindow,
  semaphore: Semaphore,
  run: OrderedKeyedTaskOptions<TInput, TKey, TValue>["run"],
): Promise<AdmittedTask<TInput, TKey, TValue>> {
  // Acquire in input order before waiting on a same-key predecessor. This
  // prevents later inputs from occupying every pending slot and deadlocking
  // ordered publication behind an earlier keyed task.
  const release = await admissionWindow.acquire();
  const result = await runAfterPrevious(
    input,
    index,
    key,
    previousPromise,
    semaphore,
    run,
  );
  return { result, release };
}

async function runAfterPrevious<TInput, TKey, TValue>(
  input: TInput,
  index: number,
  key: TKey,
  previousPromise: Promise<OrderedTaskResult<TInput, TKey, TValue>> | undefined,
  semaphore: Semaphore,
  run: OrderedKeyedTaskOptions<TInput, TKey, TValue>["run"],
): Promise<OrderedTaskResult<TInput, TKey, TValue>> {
  const previous = await previousPromise;
  const release = await semaphore.acquire();

  try {
    const value = await run(input, { index, key, previous });
    return { status: "fulfilled", index, input, key, value };
  } catch (reason) {
    return { status: "rejected", index, input, key, reason };
  } finally {
    release();
  }
}

function validateConcurrency(concurrency: number): void {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Worker concurrency must be a positive safe integer");
  }
}

function validateMaximumPendingResults(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError("Maximum pending results must be a positive safe integer");
  }
}

class AdmissionWindow {
  private readonly semaphore: Semaphore;
  private fullyOpen = false;
  private readonly blocked = new Set<() => void>();

  constructor(limit: number) {
    this.semaphore = new Semaphore(limit);
  }

  async acquire(): Promise<() => void> {
    if (this.fullyOpen) return () => undefined;

    let unblock!: () => void;
    const opened = new Promise<void>((resolve) => {
      unblock = resolve;
      this.blocked.add(resolve);
    });
    const acquired = this.semaphore.acquire();
    const release = await Promise.race([
      acquired,
      opened.then(() => () => undefined),
    ]);
    this.blocked.delete(unblock);
    return this.fullyOpen ? () => undefined : release;
  }

  openFully(): void {
    if (this.fullyOpen) return;
    this.fullyOpen = true;
    for (const unblock of this.blocked) unblock();
    this.blocked.clear();
  }
}

class Semaphore {
  private available: number;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve) => this.waiters.push(resolve));
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) {
        this.available += 1;
      } else {
        next(this.createRelease());
      }
    };
  }
}
