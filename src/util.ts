/** Small shared helpers. No project imports — keep this leaf-level. */

/**
 * Expand a config value of the form "env:NAME" (or "ENV:NAME") into
 * process.env.NAME. Non-prefixed values pass through unchanged.
 */
export function expandEnvRef(value: string, label: string): string {
  const m = /^env:(.+)$/i.exec(value);
  if (!m) return value;
  const resolved = process.env[m[1]];
  if (resolved === undefined || resolved === "") {
    throw new Error(`${label}: environment variable ${m[1]} is not set`);
  }
  return resolved;
}

/** Little-endian u128 from a 16-byte slice (Config HWM fields). */
export function u128LE(bytes: Uint8Array): bigint {
  if (bytes.length !== 16) throw new Error(`u128LE: expected 16 bytes, got ${bytes.length}`);
  let out = 0n;
  for (let i = 15; i >= 0; i--) out = (out << 8n) | BigInt(bytes[i]);
  return out;
}

/** Q32.32 fixed point -> float. Precise enough for bps-level comparisons. */
export function q32ToNumber(x: bigint): number {
  return Number(x) / 2 ** 32;
}

/**
 * Oracle midprice is an ATOM ratio (quote atoms per base atom). Convert to a
 * UI price (quote units per base unit): ui = atomRatio * 10^(decBase - decQuote).
 */
export function atomRatioToUi(atomRatio: number, decBase: number, decQuote: number): number {
  return atomRatio * 10 ** (decBase - decQuote);
}

export function uiToAtomRatio(ui: number, decBase: number, decQuote: number): number {
  return ui * 10 ** (decQuote - decBase);
}

/** |a/b - 1| in basis points. Returns Infinity for a non-positive reference. */
export function bpsBetween(a: number, b: number): number {
  if (!(b > 0) || !Number.isFinite(a)) return Infinity;
  return Math.abs(a / b - 1) * 1e4;
}

/** Loss of `value` vs `ref` in bps, clamped at 0 (gains don't offset). */
export function lossBps(value: number, ref: number): number {
  if (!(ref > 0)) return 0;
  if (value >= ref) return 0;
  return ((ref - value) / ref) * 1e4;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function shortKey(k: string, n = 4): string {
  return k.length <= 2 * n ? k : `${k.slice(0, n)}..${k.slice(-n)}`;
}
