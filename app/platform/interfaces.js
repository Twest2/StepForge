'use strict';

/**
 * Platform adapter interfaces (documentation + light runtime shape checks).
 *
 * The platform-neutral capture/text-intel code consumes these interfaces and
 * never inspects `process.platform` itself. `app/platform/index.js` is the
 * only module that selects a concrete implementation. New OS support is a new
 * set of files under `app/platform/<os>/`, not more conditionals inside the
 * shared code.
 *
 * ---------------------------------------------------------------------------
 * WindowContextProvider
 *   collect(osPoint?: {x,y}) -> Promise<{
 *     appName, windowTitle,
 *     elementLabel?, elementRole?, elementClass?, elementValue?
 *   }>
 *   Best-effort foreground window / clicked-element context. Never throws;
 *   returns {} (or partial) when unavailable.
 *
 * ClickSource   (runtime capture — implemented incrementally per platform)
 *   describe() -> { source, coordinates: boolean, keyboard: boolean }
 *     source ∈ 'windows-hook' | 'x11' | 'evdev-x11' | 'evdev-wayland' |
 *              'wayland-portal' | 'hotkey' | 'interval' | 'unavailable'
 *
 * PowerPolicy
 *   setRecording(recording: boolean) -> void
 *   Holds/releases OS power + throttling state for the recording lifecycle.
 *
 * PlatformCapabilities  (from index.detectCapabilities())
 *   { os, sessionType, isWayland, hasXinput, canSandbox, ... }
 * ---------------------------------------------------------------------------
 */

// Interface names, exported so adapters and tests can reference a single
// source of truth for the contract identifiers.
const INTERFACES = Object.freeze([
  'WindowContextProvider',
  'ClickSource',
  'PowerPolicy',
]);

const CLICK_SOURCES = Object.freeze([
  'windows-hook',
  'x11',
  'evdev-x11',
  'evdev-wayland',
  'wayland-portal',
  'hotkey',
  'interval',
  'unavailable',
]);

/** Assert a value looks like a WindowContextProvider (has async collect()). */
function assertWindowContextProvider(provider) {
  if (!provider || typeof provider.collect !== 'function') {
    throw new Error('platform: WindowContextProvider must implement collect()');
  }
  return provider;
}

module.exports = { INTERFACES, CLICK_SOURCES, assertWindowContextProvider };
