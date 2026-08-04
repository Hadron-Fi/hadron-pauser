/**
 * Reference price sources — the prices the attacker does NOT control.
 * All sources report a UI price: quote units per base unit (post-invert).
 */

export interface RefSample {
  price: number;
  ts: number; // ms epoch of the observation (exchange/publish time when available)
}

export interface RefSourceStatus {
  name: string;
  price: number | null;
  ageMs: number | null;
  fresh: boolean;
}

export interface RefSource {
  readonly name: string;
  readonly staleMs: number;
  start(): void;
  stop(): void;
  latest(): RefSample | null;
}

export function statusOf(src: RefSource, now: number): RefSourceStatus {
  const s = src.latest();
  const ageMs = s ? now - s.ts : null;
  return {
    name: src.name,
    price: s?.price ?? null,
    ageMs,
    fresh: s != null && ageMs != null && ageMs <= src.staleMs && Number.isFinite(s.price) && s.price > 0,
  };
}
