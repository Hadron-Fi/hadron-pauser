import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const VALID = {
  rpcUrls: ["https://rpc.example.com"],
  grpc: { endpoint: "https://grpc.example.com", token: "env:__TEST_GRPC" },
  pools: [
    {
      name: "test-pool",
      config: "6rK6f3zsp744uxhzA9n9rrzbpf4CvBy7oj3eaRrLogxL",
      refs: [{ kind: "binance", symbol: "SOLUSDC" }],
    },
  ],
};

afterEach(() => {
  delete process.env.CONFIG_JSON;
  delete process.env.__TEST_GRPC;
  delete process.env.HEALTH_PORT;
});

describe("config", () => {
  it("parses a minimal config with safe defaults", () => {
    process.env.__TEST_GRPC = "tok";
    process.env.CONFIG_JSON = JSON.stringify(VALID);
    const cfg = loadConfig();
    expect(cfg.dryRun).toBe(true); // safety default
    expect(cfg.pools[0].mode).toBe("shadow"); // safety default
    expect(cfg.grpc.token).toBe("tok"); // env expanded
    expect(cfg.pools[0].detectors.drawdown.maxBps).toBe(200);
    // A false pause stops the pool quoting, so only the high-precision
    // detectors pause out of the box; the drawdown budget alerts.
    expect(cfg.pools[0].detectors.drawdown.pauseOnBreach).toBe(false);
    expect(cfg.pools[0].detectors.midDeviation.enabled).toBe(true);
    expect(cfg.pools[0].detectors.drawdown.windowMs).toBe(64_800_000);
    expect(cfg.pools[0].detectors.midDeviation.maxBps).toBe(60);
    expect(cfg.pools[0].detectors.quoteAuthority.pauseOnChange).toBe(true);
  });

  it("HEALTH_PORT env overrides the document (the platform owns the port)", () => {
    process.env.__TEST_GRPC = "tok";
    process.env.CONFIG_JSON = JSON.stringify({ ...VALID, healthPort: 8091 });
    expect(loadConfig().healthPort).toBe(8091);
    process.env.HEALTH_PORT = "8080";
    expect(loadConfig().healthPort).toBe(8080);
    process.env.HEALTH_PORT = "not-a-port";
    expect(() => loadConfig()).toThrow(/HEALTH_PORT/);
  });

  it("rejects a pool without refs", () => {
    process.env.CONFIG_JSON = JSON.stringify({
      ...VALID,
      grpc: { endpoint: "x" },
      pools: [{ name: "p", config: "6rK6f3zsp744uxhzA9n9rrzbpf4CvBy7oj3eaRrLogxL", refs: [] }],
    });
    expect(() => loadConfig()).toThrow(/invalid config/);
  });

  it("rejects duplicate pools", () => {
    process.env.CONFIG_JSON = JSON.stringify({
      ...VALID,
      grpc: { endpoint: "x" },
      pools: [VALID.pools[0], VALID.pools[0]],
    });
    expect(() => loadConfig()).toThrow(/duplicate pool/);
  });

  it("fails loudly on a missing env secret", () => {
    process.env.CONFIG_JSON = JSON.stringify(VALID); // __TEST_GRPC not set
    expect(() => loadConfig()).toThrow(/__TEST_GRPC/);
  });
});
