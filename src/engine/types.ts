export type VerdictLevel = "alert" | "pause";
export type Severity = "critical" | "high" | "warning" | "info";

export interface Verdict {
  detector: string;
  /** stable code — alert dedup key + persistence key, e.g. "drawdown" */
  code: string;
  level: VerdictLevel;
  severity: Severity;
  message: string;
  evidence: Record<string, unknown>;
}

export const SEV_EMOJI: Record<Severity, string> = {
  critical: ":rotating_light:",
  high: ":warning:",
  warning: ":small_orange_diamond:",
  info: ":information_source:",
};
