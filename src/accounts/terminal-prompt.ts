import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

import type { AccountPrompt } from "./commands.js";

export interface TerminalPromptStreams {
  readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly output: NodeJS.WritableStream & {
    readonly columns?: number;
    readonly isTTY?: boolean;
  };
}

const defaultStreams: TerminalPromptStreams = {
  input: process.stdin,
  output: process.stdout,
};

function mutedTerminalOutput(output: TerminalPromptStreams["output"]): NodeJS.WritableStream {
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as Writable & { columns?: number; isTTY?: boolean };
  muted.isTTY = output.isTTY ?? false;
  muted.columns = output.columns ?? 80;
  return muted;
}

/**
 * Interactive account prompt. Secret answers are processed by readline with a
 * muted output stream, preventing both the answer and readline's redraws from
 * reaching stdout. The visible label and trailing newline contain no secret.
 */
export class TerminalAccountPrompt implements AccountPrompt {
  constructor(private readonly streams: TerminalPromptStreams = defaultStreams) {}

  async input(label: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const answer = await this.question(`${label}${suffix}: `, false);
    return answer.length === 0 && defaultValue !== undefined ? defaultValue : answer;
  }

  async secret(label: string): Promise<string> {
    return this.question(`${label}: `, true);
  }

  private async question(prompt: string, hidden: boolean): Promise<string> {
    if (hidden) this.streams.output.write(prompt);
    const readline = createInterface({
      input: this.streams.input,
      output: hidden ? mutedTerminalOutput(this.streams.output) : this.streams.output,
      terminal: this.streams.input.isTTY === true,
    });
    try {
      return await readline.question(hidden ? "" : prompt);
    } finally {
      readline.close();
      if (hidden) this.streams.output.write("\n");
    }
  }
}
