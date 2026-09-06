/**
 * `@farm/client` — the typed surface of Backline's JSON API.
 *
 * Free of React and of `window`, so the Expo app and the Electron app can both
 * depend on it. `main` points at this file: Metro and Electron's bundler both
 * transpile the TypeScript, so there is no build step to keep in sync.
 */

export * from './models';
export * from './errors';
export * from './http';
export * from './client';
export * from './sse';
export * from './uploads';
export { sha256Bytes, sha256Hex } from './sha256';
export * from './event-text';
export * from './derive';
export { createMockFarm } from './mock';
export type { MockFarm, MockFarmOptions } from './mock';
