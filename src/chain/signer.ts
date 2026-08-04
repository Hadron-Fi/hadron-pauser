import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { expandEnvRef } from "../util.js";

/**
 * Load the pauser keypair from a config spec:
 *   "env:PAUSER_SECRET"  -> secret in an env var (bs58 string or JSON array)
 *   "/path/to/key.json"  -> solana-keygen style JSON array file
 * The key is OPERATOR-PROVIDED — this service never generates keys.
 */
export function loadPauserKeypair(spec: string): Keypair {
  const value = /^env:/i.test(spec) ? expandEnvRef(spec, "pauserKeypair") : readFileSync(spec, "utf8");
  const trimmed = value.trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed) as number[])
    : bs58.decode(trimmed);
  if (bytes.length !== 64) {
    throw new Error(`pauser keypair: expected 64 secret bytes, got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}
