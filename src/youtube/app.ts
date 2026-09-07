/**
 * The handful of constants both the plugin and the routines need, in a file that imports nothing.
 *
 * The plugin runs inside the web and worker processes; the routines run in a child process with
 * webdriverio or a device driver loaded. Keeping the ids and the limits here means validating a
 * payload never drags an automation stack into the server.
 */

/** Android package name. */
export const YOUTUBE_ANDROID_PACKAGE = 'com.google.android.youtube';

/** iOS bundle id. */
export const YOUTUBE_IOS_BUNDLE_ID = 'com.google.ios.youtube';

/** YouTube's own limit on a Short's title. */
export const MAX_TITLE_LENGTH = 100;

/** The description box under a Short. */
export const MAX_DESCRIPTION_LENGTH = 5_000;

/** A Short is a single vertical clip of at most a minute; anything longer is an ordinary upload. */
export const MAX_SHORT_SECONDS = 60;
