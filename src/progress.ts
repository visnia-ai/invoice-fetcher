interface ProgressOutput {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

interface ProgressState {
  completed: number;
  total: number;
  startedAt: number;
  detail: string;
}

export interface ProgressDisplayOptions {
  now?: () => number;
}

export class ProgressDisplay {
  private readonly now: () => number;
  private readonly live: boolean;
  private readonly states = new Map<"mail", ProgressState>();
  private renderedLines = 0;
  private lastPlainPercent = new Map<"mail", number>();

  constructor(
    private readonly output: ProgressOutput,
    options: ProgressDisplayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.live = output.isTTY === true;
  }

  status(message: string): void {
    this.clearLive();
    this.safeWrite(`Progress: ${message}\n`);
    this.renderLive();
  }

  updateMail(completed: number, total: number | undefined, attachments: number): void {
    this.update("mail", completed, total ?? 0, `${attachments} attachments`);
  }

  refresh(): void {
    if (this.live) this.renderLive();
  }

  completeMail(completed: number, total: number, attachments: number): void {
    this.updateMail(completed, total, attachments);
    this.complete("mail");
  }

  close(): void {
    this.clearLive();
    this.states.clear();
  }

  private update(
    kind: "mail",
    completed: number,
    total: number,
    detail: string,
  ): void {
    const previous = this.states.get(kind);
    this.states.set(kind, {
      completed: Math.max(0, Math.min(completed, total > 0 ? total : completed)),
      total: Math.max(0, total),
      startedAt: previous?.startedAt ?? this.now(),
      detail,
    });
    if (this.live) {
      this.renderLive();
      return;
    }
    this.renderPlainMilestone(kind);
  }

  private complete(kind: "mail"): void {
    const state = this.states.get(kind);
    if (!state) return;
    if (this.live) {
      this.clearLive();
      this.safeWrite(`${this.formatLine(kind, state)}\n`);
      this.states.delete(kind);
      this.renderLive();
    } else {
      this.states.delete(kind);
    }
  }

  private renderPlainMilestone(kind: "mail"): void {
    const state = this.states.get(kind);
    if (!state || state.total <= 0) return;
    const percent = percentage(state);
    const milestone = Math.floor(percent / 10) * 10;
    if (this.lastPlainPercent.get(kind) === milestone) return;
    this.lastPlainPercent.set(kind, milestone);
    this.safeWrite(`${this.formatLine(kind, state)}\n`);
  }

  private renderLive(): void {
    if (!this.live) return;
    const lines = [...this.states].map(([kind, state]) => this.formatLine(kind, state));
    if (this.renderedLines > 0) this.safeWrite(`\u001B[${this.renderedLines}A`);
    for (const line of lines) this.safeWrite(`\r\u001B[2K${line}\n`);
    this.renderedLines = lines.length;
  }

  private clearLive(): void {
    if (!this.live || this.renderedLines === 0) return;
    this.safeWrite(`\u001B[${this.renderedLines}A`);
    for (let index = 0; index < this.renderedLines; index += 1) {
      this.safeWrite("\r\u001B[2K\n");
    }
    this.renderedLines = 0;
  }

  private formatLine(_kind: "mail", state: ProgressState): string {
    const label = "Mail ";
    const percent = percentage(state);
    const eta = formatEta(state, this.now());
    const barWidth = Math.max(10, Math.min(30, (this.output.columns ?? 100) - 64));
    const filled = state.total > 0 ? Math.round((percent / 100) * barWidth) : 0;
    const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
    const count = `${state.completed}/${state.total} messages`;
    const extra = ` • ${state.detail}`;
    return `${label} [${bar}] ${String(percent).padStart(3)}% • ${count}${extra} • ${eta}`;
  }

  private safeWrite(chunk: string): void {
    try {
      this.output.write(chunk);
    } catch {
      // Progress display problems must never interrupt invoice collection.
    }
  }
}

function percentage(state: ProgressState): number {
  if (state.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((state.completed / state.total) * 100)));
}

function formatEta(state: ProgressState, now: number): string {
  if (state.total <= 0 || state.completed <= 0 || state.completed >= state.total) {
    return state.completed >= state.total && state.total > 0 ? "done" : "ETA calculating…";
  }
  const elapsed = Math.max(1, now - state.startedAt);
  const remaining = (elapsed * (state.total - state.completed)) / state.completed;
  return `ETA ${formatDuration(remaining)}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
