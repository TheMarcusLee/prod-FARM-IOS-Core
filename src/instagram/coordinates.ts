import type { DeviceCoordinates } from '../devices/coordinates.js';

/**
 * The Instagram half of a coordinate profile — the sibling of `src/tiktok/coordinates.ts`.
 *
 * The profiles themselves live in one place, `src/devices/coordinates.ts`, because that is what
 * `resolveDeviceCoordinates()` reads and what `devices.json` selects with `coordinateProfile`.
 * Adding an `instagram` section there was a far smaller change than making the per-app files
 * platform-neutral, so this module is only the name the iOS routines import the section by.
 *
 * **Every default is unverified.** See docs/coordinates.md.
 */
export type InstagramCoordinates = DeviceCoordinates['instagram'];

export { coordinatesForProfile, resolveDeviceCoordinates, type Point } from '../devices/coordinates.js';
