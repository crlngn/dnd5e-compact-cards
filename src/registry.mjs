import { CompactCards5e } from "./CompactCards5e.mjs";
import { COMPACT_CARDS_HOOKS } from "./hooks.mjs";
import pkg from "../package.json";

/** Version of the shared package bundled into the host, used to pick the copy that runs */
export const VERSION = pkg.version;

/** Name of the global the registry lives on, shared by every host bundle */
export const GLOBAL_KEY = "dnd5eCompactCards";

/** Host that wins version ties */
const PREFERRED_HOST = "crlngn-ui";

/**
 * @typedef {Object} CompactCardsCandidate
 * @property {string} id - Host module id
 * @property {string} version - Shared package version bundled in that host
 * @property {CompactCards5e} instance - The host's instance
 * @property {() => void} activate
 * @property {(handledBy: string) => void} deactivate
 */

/**
 * Orders candidates by shared package version, newest first, with ties going to the preferred host
 * @param {CompactCardsCandidate} a
 * @param {CompactCardsCandidate} b
 * @returns {number}
 */
function compareCandidates(a, b) {
  if (a.version !== b.version) return foundry.utils.isNewerVersion(a.version, b.version) ? -1 : 1;
  if (a.id === PREFERRED_HOST) return -1;
  if (b.id === PREFERRED_HOST) return 1;
  return 0;
}

/**
 * Returns the registry shared by every host bundle, creating it on first use. Only the first
 * bundle to load defines its methods, so the shape is kept minimal and every later version of
 * the package must stay compatible with it.
 * @returns {Object}
 */
function getRegistry() {
  if (!globalThis[GLOBAL_KEY]) {
    const registry = {
      /** @type {CompactCardsCandidate[]} */
      candidates: [],
      resolved: false,
      setupDone: false,
      /** @type {string|null} */
      activeId: null,
      get active() {
        return this.candidates.find(c => c.id === this.activeId)?.instance ?? null;
      },
      get isActive() {
        return this.active?.isActive ?? false;
      },
      resolve() {
        if (this.resolved) return this.activeId;
        this.resolved = true;
        const sorted = [...this.candidates].sort(compareCandidates);
        const winner = sorted[0];
        if (!winner) return null;
        this.activeId = winner.id;
        for (const candidate of this.candidates) {
          if (candidate === winner) candidate.activate();
          else candidate.deactivate(winner.id);
        }
        Hooks.callAll(COMPACT_CARDS_HOOKS.RESOLVED, this.activeId, this);
        return this.activeId;
      }
    };
    globalThis[GLOBAL_KEY] = registry;
    Hooks.once("setup", () => {
      registry.setupDone = true;
    });
  }
  return globalThis[GLOBAL_KEY];
}

/**
 * Registers a host's copy of the feature. Call during the host's `init` hook. At `setup` the
 * registry activates the copy with the highest shared package version (ties go to Carolingian
 * UI) and marks the others as handled by it.
 * @param {import("./CompactCards5e.mjs").CompactCardsOptions} options
 * @returns {CompactCards5e} The host's instance
 */
export function registerCompactCards(options) {
  const registry = getRegistry();
  const instance = new CompactCards5e(options);
  const candidate = {
    id: options.id,
    version: VERSION,
    instance,
    activate: () => instance.activate(),
    deactivate: (handledBy) => instance.deactivate(handledBy)
  };
  registry.candidates.push(candidate);
  if (registry.resolved) {
    candidate.deactivate(registry.activeId);
  } else if (registry.setupDone) {
    registry.resolve();
  } else {
    Hooks.once("setup", () => registry.resolve());
  }
  return instance;
}

/**
 * The shared registry, if any host has registered yet
 * @returns {Object|null}
 */
export function getCompactCardsRegistry() {
  return globalThis[GLOBAL_KEY] ?? null;
}
