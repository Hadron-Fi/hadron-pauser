import { SEV_EMOJI, Verdict } from "./engine/types.js";

/**
 * Alert sink for detector verdicts: one structured line per verdict on
 * stdout, carrying the full evidence bundle.
 *
 * There is deliberately no notification transport here. Container platforms
 * already collect stdout (CloudWatch Logs on the ECS deploy), so routing is
 * the operator's choice — a metric filter on `[alert]`, or on a specific
 * `code=` / `severity=` field, turns these into whatever paging the operator
 * already runs, and this service holds no notification credential.
 *
 * Never throws, never blocks the engine. Dedup is handled upstream: the
 * engine only emits on episode edges and re-alert intervals.
 */
export class AlertSink {
  send(pool: string, v: Verdict, opts?: { prefix?: string }): void {
    const prefix = opts?.prefix ? `${opts.prefix} ` : "";
    const evidence = safeEvidence(v.evidence);
    console.log(
      `[alert] ${SEV_EMOJI[v.severity]} severity=${v.severity} pool=${pool} code=${v.code} ` +
        `${prefix}${v.message}${evidence ? ` evidence=${evidence}` : ""}`,
    );
  }

  info(message: string): void {
    console.log(`[alert] severity=info ${message}`);
  }
}

function safeEvidence(ev: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    return s.length > 1400 ? `${s.slice(0, 1400)}…` : s;
  } catch {
    return "";
  }
}
