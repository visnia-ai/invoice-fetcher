export type ExitCode = 0 | 1 | 2;

export interface CliOptions {
  /** Original, validated YYYY-MM-DD input. */
  startDate: string;
  /** Original, validated YYYY-MM-DD input. */
  endDate: string;
  /** Start of startDate in the machine's local time zone. */
  startInclusive: Date;
  /** Start of the day after endDate in the machine's local time zone. */
  endExclusive: Date;
  inboxEmail: string;
  /** Absolute destination path. */
  destination: string;
  spansMultipleMonths: boolean;
}

export interface RunSummary {
  exitCode: 0 | 2;
  scanned: number;
  copied: number;
  deduplicated: number;
  rejected: number;
  failed: number;
}
