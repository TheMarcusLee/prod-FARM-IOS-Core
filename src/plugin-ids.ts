/**
 * The built-in plugin identifiers, in one place with no imports.
 *
 * They are read from two directions that must not be allowed to drift: the plugin modules
 * themselves, and the Android routines, which key their selector overrides (and the calibration
 * agent's work) by plugin id. A routine importing `tiktok-plugin.ts` for one string would drag
 * the whole task-definition surface into a child process that only wanted to tap a screen.
 */

export const TIKTOK_PLUGIN_ID = 'com.git-agni.tiktok';
export const INSTAGRAM_PLUGIN_ID = 'com.backline.instagram';
export const THREADS_PLUGIN_ID = 'com.backline.threads';
export const YOUTUBE_PLUGIN_ID = 'com.backline.youtube';
export const RUNBOOK_PLUGIN_ID = 'com.farm.runbook';
/** The calibration agent's own plugin — see src/agent-plugin.ts. */
export const AGENT_PLUGIN_ID = 'com.backline.agent';
