import assert from "node:assert/strict";
import test from "node:test";

import {
  runOrderedKeyedTasks,
  type OrderedTaskResult,
} from "../src/imap/ordered-worker-pool.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("caps active tasks and returns results in input order", async () => {
  const gates = Array.from({ length: 5 }, () => deferred<string>());
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;

  const running = runOrderedKeyedTasks([0, 1, 2, 3, 4], {
    concurrency: 3,
    keyOf: (input) => input,
    async run(input) {
      started.push(input);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await gates[input]!.promise;
      } finally {
        active -= 1;
      }
    },
  });

  await nextTurn();
  assert.deepEqual(started, [0, 1, 2]);

  gates[2]!.resolve("two");
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3]);

  gates[1]!.resolve("one");
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);

  gates[4]!.resolve("four");
  gates[3]!.resolve("three");
  gates[0]!.resolve("zero");

  const results = await running;
  assert.equal(maximumActive, 3);
  assert.deepEqual(
    results.map((result) =>
      result.status === "fulfilled" ? result.value : "rejected",
    ),
    ["zero", "one", "two", "three", "four"],
  );
  assert.deepEqual(
    results.map((result) => result.index),
    [0, 1, 2, 3, 4],
  );
});

test("serializes matching keys and passes the previous settled result", async () => {
  const firstDuplicateGate = deferred<void>();
  const starts: string[] = [];
  const finishes: string[] = [];

  const running = runOrderedKeyedTasks(
    [
      { name: "first", messageId: "duplicate" },
      { name: "second", messageId: "duplicate" },
      { name: "independent", messageId: "unique" },
      { name: "third", messageId: "duplicate" },
    ],
    {
      concurrency: 3,
      keyOf: (input) => input.messageId,
      async run(input, { previous }) {
        starts.push(input.name);
        if (input.name === "first") {
          await firstDuplicateGate.promise;
          finishes.push(input.name);
          throw new Error("first download failed");
        }
        if (input.name === "second") {
          assert.equal(previous?.status, "rejected");
          finishes.push(input.name);
          return "downloaded";
        }
        if (input.name === "third") {
          assert.equal(previous?.status, "fulfilled");
          finishes.push(input.name);
          return "suppressed";
        }
        assert.equal(previous, undefined);
        finishes.push(input.name);
        return "downloaded";
      },
    },
  );

  await nextTurn();
  assert.deepEqual(starts, ["first", "independent"]);
  assert.deepEqual(finishes, ["independent"]);

  firstDuplicateGate.resolve();
  const results = await running;

  assert.deepEqual(starts, ["first", "independent", "second", "third"]);
  assert.deepEqual(finishes, ["independent", "first", "second", "third"]);
  assert.equal(results[0]?.status, "rejected");
  assert.deepEqual(fulfilledValues(results), [
    "downloaded",
    "downloaded",
    "suppressed",
  ]);
});

test("captures worker failures without stopping unrelated tasks", async () => {
  const failure = new Error("broken message");
  const results = await runOrderedKeyedTasks(["bad", "good"], {
    concurrency: 2,
    keyOf: (input) => input,
    run(input) {
      if (input === "bad") throw failure;
      return input.toUpperCase();
    },
  });

  assert.equal(results[0]?.status, "rejected");
  if (results[0]?.status === "rejected") {
    assert.equal(results[0].reason, failure);
  }
  assert.equal(results[1]?.status, "fulfilled");
  if (results[1]?.status === "fulfilled") {
    assert.equal(results[1].value, "GOOD");
  }
});

test("publishes completed results incrementally in stable input order", async () => {
  const middleGate = deferred<string>();
  const firstPublished = deferred<void>();
  const callbacks: number[] = [];
  const finishes: number[] = [];

  const running = runOrderedKeyedTasks([0, 1, 2], {
    concurrency: 3,
    keyOf: (input) => input,
    async run(input) {
      if (input === 1) await middleGate.promise;
      finishes.push(input);
      return input;
    },
    onOrderedResult(result) {
      callbacks.push(result.index);
      if (result.index === 0) firstPublished.resolve();
    },
  });

  await firstPublished.promise;
  assert.deepEqual(finishes, [0, 2]);
  assert.deepEqual(callbacks, [0]);

  middleGate.resolve("ready");
  const results = await running;

  assert.deepEqual(callbacks, [0, 1, 2]);
  assert.deepEqual(
    results.map((result) => result.index),
    [0, 1, 2],
  );
});

test("uses a sliding pending-result window without fixed batch barriers", async () => {
  const gates = Array.from({ length: 6 }, () => deferred<void>());
  const started: number[] = [];

  const running = runOrderedKeyedTasks([0, 1, 2, 3, 4, 5], {
    concurrency: 3,
    maximumPendingResults: 4,
    keyOf: (input) => input,
    async run(input) {
      started.push(input);
      await gates[input]!.promise;
      return input;
    },
  });

  await nextTurn();
  assert.deepEqual(started, [0, 1, 2]);

  gates[1]!.resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2]!.resolve();
  gates[3]!.resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3]);

  gates[0]!.resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  gates[4]!.resolve();
  gates[5]!.resolve();

  assert.deepEqual(
    (await running).map((result) => result.index),
    [0, 1, 2, 3, 4, 5],
  );
});

test("drains admitted tasks before propagating an ordered callback failure", async () => {
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
  let active = 0;
  let settled = false;
  const running = runOrderedKeyedTasks([0, 1, 2], {
    concurrency: 3,
    maximumPendingResults: 2,
    keyOf: (input) => input,
    async run(input) {
      active += 1;
      try {
        return await gates[input]!.promise;
      } finally {
        active -= 1;
      }
    },
    onOrderedResult() {
      throw new Error("publisher closed");
    },
  }).finally(() => { settled = true; });

  await nextTurn();
  gates[0]!.resolve("zero");
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(active, 2);
  gates[1]!.resolve("one");
  gates[2]!.resolve("two");
  await assert.rejects(running, /publisher closed/u);
  assert.equal(active, 0);
});

test("rejects invalid concurrency", async () => {
  await assert.rejects(
    runOrderedKeyedTasks([], {
      concurrency: 0,
      keyOf: (input: string) => input,
      run: (input) => input,
    }),
    { name: "RangeError", message: "Worker concurrency must be a positive safe integer" },
  );
});

test("rejects invalid pending-result limits", async () => {
  await assert.rejects(
    runOrderedKeyedTasks([], {
      concurrency: 1,
      maximumPendingResults: 0,
      keyOf: (input: string) => input,
      run: (input) => input,
    }),
    {
      name: "RangeError",
      message: "Maximum pending results must be a positive safe integer",
    },
  );
});

function fulfilledValues<TInput, TKey, TValue>(
  results: ReadonlyArray<OrderedTaskResult<TInput, TKey, TValue>>,
): TValue[] {
  return results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
}
