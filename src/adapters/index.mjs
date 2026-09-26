import { SystemV6Adapter } from "./SystemV6Adapter.mjs";
import { SystemV5Adapter } from "./SystemV5Adapter.mjs";

export { SystemV6Adapter, SystemV5Adapter };

/** Lowest dnd5e version the 5.x adapter was written against */
export const MIN_SYSTEM_VERSION = "5.3.0";

/**
 * @typedef {SystemV6Adapter|SystemV5Adapter} SystemAdapter
 * Bridges the differences between dnd5e generations: where a roll message finds the card it
 * belongs to, what kind of roll it holds, where targets are stored, how the card is laid out,
 * and who renders the summaries. Both adapters expose the same methods.
 */

/**
 * Picks the adapter for the running dnd5e version, or null when the version is too old
 * @param {import("../CompactCards5e.mjs").CompactCards5e} cards
 * @returns {SystemAdapter|null}
 */
export function createSystemAdapter(cards) {
  const version = game.system?.version ?? "0";
  if (!foundry.utils.isNewerVersion("6.0.0", version)) return new SystemV6Adapter(cards);
  if (!foundry.utils.isNewerVersion(MIN_SYSTEM_VERSION, version)) return new SystemV5Adapter(cards);
  return null;
}
