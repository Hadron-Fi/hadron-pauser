/**
 * Lazy loader for the Yellowstone gRPC client.
 *
 * The module id is a runtime string (typed `string`, not a string literal) so
 * neither `tsc` nor the bundler tries to resolve `@triton-one/yellowstone-grpc`
 * at build time. This package declares it as a PEER dependency — every consuming
 * service already installs it — so the stream manager stays dependency-light
 * (matching the `@hadron-fi/observability` zero-runtime-dep convention).
 *
 * The CJS/ESM `default ?? module` interop is intentional: the Yellowstone client
 * ships as CommonJS, and the default export shape differs between bundlers.
 */
const MODULE_ID: string = "@triton-one/yellowstone-grpc";

/** The raw imported module (typed `any` — the client has no first-party types we depend on). */
export async function loadYellowstoneModule(): Promise<any> {
  return import(MODULE_ID);
}

/** The Yellowstone `Client` constructor, normalised across CJS/ESM default shapes. */
export async function loadYellowstoneClient(): Promise<any> {
  const mod = await loadYellowstoneModule();
  return mod?.default ?? mod;
}
