import assert from "node:assert/strict";
import test from "node:test";

import { ProgressDisplay } from "../src/progress.js";

test("TTY progress renders mail bars with percentages and ETAs", () => {
  const output: string[] = [];
  let now = 0;
  const display = new ProgressDisplay(
    {
      isTTY: true,
      columns: 110,
      write: (chunk) => output.push(chunk),
    },
    { now: () => now },
  );

  display.updateMail(0, 100, 0);
  now = 10_000;
  display.updateMail(25, 100, 7);

  const rendered = output.join("");
  assert.match(rendered, /Mail\s+\[[█░]+\]\s+25% • 25\/100 messages • 7 attachments • ETA 30s/u);
  assert.match(rendered, /\u001B\[/u);
});

test("non-TTY progress emits milestones instead of one line per update", () => {
  const output: string[] = [];
  const display = new ProgressDisplay({ write: (chunk) => output.push(chunk) });

  for (let completed = 1; completed <= 19; completed += 1) {
    display.updateMail(completed, 100, completed);
  }

  const lines = output.join("").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /1%/u);
  assert.match(lines[1] ?? "", /10%/u);
});
