import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AsyncBoundedQueue } from "../src/async-bounded-queue.js";

describe("AsyncBoundedQueue", () => {
  it("delivers items in FIFO order and ends after the queue is drained", async () => {
    const queue = new AsyncBoundedQueue<number>(2);

    await queue.enqueue(1);
    await queue.enqueue(2);
    queue.close();

    assert.equal(await queue.dequeue(), 1);
    assert.equal(await queue.dequeue(), 2);
    assert.equal(await queue.dequeue(), undefined);
  });

  it("applies backpressure when its capacity is reached", async () => {
    const queue = new AsyncBoundedQueue<number>(2);
    await queue.enqueue(1);
    await queue.enqueue(2);

    let admitted = false;
    const enqueueThird = queue.enqueue(3).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    assert.equal(admitted, false);

    assert.equal(await queue.dequeue(), 1);
    await enqueueThird;
    assert.equal(admitted, true);
    assert.equal(await queue.dequeue(), 2);
    assert.equal(await queue.dequeue(), 3);
  });

  it("rejects blocked and subsequent producers when closed", async () => {
    const queue = new AsyncBoundedQueue<number>(1);
    await queue.enqueue(1);
    const blocked = queue.enqueue(2);

    queue.close();

    await assert.rejects(blocked, /closed queue/u);
    await assert.rejects(queue.enqueue(3), /closed queue/u);
    assert.equal(await queue.dequeue(), 1);
    assert.equal(await queue.dequeue(), undefined);
  });

  it("validates capacity", () => {
    assert.throws(() => new AsyncBoundedQueue(0), /positive integer/u);
    assert.throws(() => new AsyncBoundedQueue(1.5), /positive integer/u);
  });
});
