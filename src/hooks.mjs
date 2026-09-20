/** Prefix of the hooks and global exposed by the shared package */
export const HOOK_PREFIX = "dnd5e-compact-cards";

/**
 * Hooks fired by whichever module copy is active. Hosts may also declare alias names
 * that are fired alongside these, so integrations written against one host keep working.
 */
export const COMPACT_CARDS_HOOKS = {
  /** Fired for each roll folded into a compact activity card, after its row and drawer are built: `({ origin, rollMessage, summary, row, drawer })` */
  RENDER_ROLL: `${HOOK_PREFIX}.renderRoll`,
  /** Fired after a compact activity card has been fully enriched: `(message, html)` */
  RENDER_CARD: `${HOOK_PREFIX}.renderCard`,
  /** Fired once the registry picked the copy that handles the feature: `(activeId, registry)` */
  RESOLVED: `${HOOK_PREFIX}.resolved`
};
