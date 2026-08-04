import type { GrpcEndpoint, KeepaliveMode } from "./types.js";

const KEEPALIVE_MODES: readonly KeepaliveMode[] = ["client-ping", "stream-ping", "none"];

function asKeepalive(v: string | undefined): KeepaliveMode | undefined {
  return v && (KEEPALIVE_MODES as readonly string[]).includes(v)
    ? (v as KeepaliveMode)
    : undefined;
}

/**
 * Resolve an ordered gRPC failover list from environment variables, so every
 * service configures providers identically instead of hand-rolling the parse.
 *
 *   Primary:  GRPC_ENDPOINT     / GRPC_API_KEY     (with the ALCHEMY_GRPC_ENDPOINT /
 *             ALCHEMY_API_KEY fallback the services already use),
 *             optional GRPC_LABEL / GRPC_KEEPALIVE.
 *   Backups:  GRPC_ENDPOINT_2 / GRPC_API_KEY_2, GRPC_ENDPOINT_3 / ... (contiguous
 *             from _2; the scan stops at the first missing _N endpoint),
 *             optional GRPC_LABEL_N / GRPC_KEEPALIVE_N.
 *
 * Returns primary-first; backups are included only when their endpoint is set, so
 * an unconfigured backup is simply absent (single-provider behaviour, unchanged).
 * Throws if no primary endpoint is configured.
 */
export function endpointsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GrpcEndpoint[] {
  const primaryEndpoint = env.GRPC_ENDPOINT ?? env.ALCHEMY_GRPC_ENDPOINT;
  const primaryToken = env.GRPC_API_KEY ?? env.ALCHEMY_API_KEY;
  if (!primaryEndpoint) {
    throw new Error(
      "endpointsFromEnv: no GRPC_ENDPOINT (or ALCHEMY_GRPC_ENDPOINT) configured",
    );
  }

  const endpoints: GrpcEndpoint[] = [
    {
      endpoint: primaryEndpoint,
      token: primaryToken,
      label: env.GRPC_LABEL,
      keepalive: asKeepalive(env.GRPC_KEEPALIVE),
    },
  ];

  for (let i = 2; ; i++) {
    const endpoint = env[`GRPC_ENDPOINT_${i}`];
    if (!endpoint) break; // contiguous from _2
    endpoints.push({
      endpoint,
      token: env[`GRPC_API_KEY_${i}`],
      label: env[`GRPC_LABEL_${i}`],
      keepalive: asKeepalive(env[`GRPC_KEEPALIVE_${i}`]),
    });
  }

  return endpoints;
}
