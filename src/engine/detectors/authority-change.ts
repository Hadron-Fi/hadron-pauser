import { shortKey } from "../../util.js";
import { Severity, Verdict } from "../types.js";

/**
 * D-auth — authority / protection-field change detector (v1 headline:
 * "new quoting authority"). The engine diffs Config + MidpriceOracle
 * snapshots; each meaningful field change is classified here.
 *
 * Program facts encoded:
 *  - the quoting authority lives in MidpriceOracle@0 (rotated via disc 35,
 *    admin-signed) — an unexpected rotation is pause-tier;
 *  - UpdateDeltaStaleness (disc 15) is QUOTING-authority-signed: setting it
 *    to 0 kills the StaleOracle gate — the classic compromise opening move;
 *  - RotatePauseAuthority (disc 37) moving the pause authority off our key
 *    means the watchdog is being disarmed.
 */

export interface FieldChange {
  field: string;
  oldValue: string;
  newValue: string;
  slot: number;
}

export interface AuthorityCtx {
  poolName: string;
  pauserPubkey: string;
  /** detectors.quoteAuthority.pauseOnChange */
  pauseOnChange: boolean;
  /** legitimate quoting authorities (config override, else boot-observed) */
  expectedQuotingAuthorities: ReadonlySet<string>;
}

const STATE_NAMES: Record<string, string> = {
  "0": "Uninitialized",
  "1": "Initialized",
  "2": "Paused",
  "3": "RejectSwaps",
  "4": "Closed",
};

export function classifyFieldChange(change: FieldChange, ctx: AuthorityCtx): Verdict | null {
  const { field, oldValue, newValue } = change;
  const ev = { field, oldValue, newValue, slot: change.slot };
  const mk = (
    code: string,
    level: "alert" | "pause",
    severity: Severity,
    message: string,
  ): Verdict => ({ detector: "authorityChange", code, level, severity, message, evidence: ev });

  switch (field) {
    case "oracleAuthority": {
      if (ctx.expectedQuotingAuthorities.has(newValue)) {
        return mk(
          "quoting-auth-rotated-expected",
          "alert",
          "info",
          `quoting authority rotated to allowlisted ${shortKey(newValue)}`,
        );
      }
      const msg = `quoting authority changed ${shortKey(oldValue)} -> ${shortKey(newValue)} (NOT allowlisted)`;
      return ctx.pauseOnChange
        ? mk("quoting-auth-rotated", "pause", "critical", msg)
        : mk("quoting-auth-rotated", "alert", "critical", msg);
    }
    case "pauseAuthority":
      if (newValue === ctx.pauserPubkey) {
        return mk("pauser-installed", "alert", "info", `pause authority set to this watchdog (${shortKey(newValue)})`);
      }
      return mk(
        "pauser-rotated-away",
        "alert",
        "critical",
        `pause authority rotated AWAY from this watchdog: ${shortKey(oldValue)} -> ${shortKey(newValue)} — we can no longer pause this pool`,
      );
    case "authority":
      return mk("admin-changed", "alert", "critical", `pool admin changed ${shortKey(oldValue)} -> ${shortKey(newValue)}`);
    case "pendingAuthority": {
      const cleared = /^1{5,}$/.test(newValue) || newValue === "" || /^0+$/.test(newValue);
      return cleared
        ? mk("admin-nomination-cleared", "alert", "info", "admin nomination cleared")
        : mk("admin-nominated", "alert", "high", `new admin NOMINATED: ${shortKey(newValue)} (AcceptAuthority completes it)`);
    }
    case "withdrawAuthority":
      return mk("withdraw-auth-changed", "alert", "critical", `withdraw authority changed ${shortKey(oldValue)} -> ${shortKey(newValue)} — this key can drain vaults in states 1/3`);
    case "depositAuthority":
      return mk("deposit-auth-changed", "alert", "high", `deposit authority changed ${shortKey(oldValue)} -> ${shortKey(newValue)}`);
    case "deltaStaleness": {
      const toZero = newValue === "0";
      return mk(
        "delta-staleness-changed",
        "alert",
        toZero ? "critical" : "high",
        toZero
          ? `delta_staleness set to 0 — StaleOracle gate DISABLED (quoting-authority-signed; classic compromise opening move)`
          : `delta_staleness changed ${oldValue} -> ${newValue} slots (quoting-authority-signed)`,
      );
    }
    case "thresholdBps": {
      const weakened = newValue === "0" || Number(newValue) > Number(oldValue);
      return mk(
        "guard-threshold-changed",
        "alert",
        weakened ? "critical" : "warning",
        `drawdown guard threshold ${oldValue} -> ${newValue}bps${weakened ? " (WEAKENED)" : ""}`,
      );
    }
    case "rotationIntervalSlots": {
      const weakened = newValue === "0";
      return mk(
        "guard-interval-changed",
        "alert",
        weakened ? "critical" : "warning",
        `drawdown guard rotation interval ${oldValue} -> ${newValue} slots${weakened ? " (guard DISABLED)" : ""}`,
      );
    }
    case "state": {
      const from = STATE_NAMES[oldValue] ?? oldValue;
      const to = STATE_NAMES[newValue] ?? newValue;
      if (newValue === "2")
        return mk("pool-paused-externally", "alert", "high", `pool state ${from} -> Paused (guard trip or admin — not this watchdog)`);
      if (oldValue === "2" && newValue === "1")
        return mk("pool-unpaused", "alert", "high", `pool state Paused -> Initialized (admin unpause)`);
      if (newValue === "4")
        return mk("pool-closed", "alert", "critical", `pool state ${from} -> Closed (vaults swept to withdraw authority)`);
      if (newValue === "3")
        return mk("pool-reject-swaps", "alert", "warning", `pool state ${from} -> RejectSwaps (withdrawals still open in this state)`);
      return mk("pool-state-changed", "alert", "warning", `pool state ${from} -> ${to}`);
    }
    default:
      return null;
  }
}
