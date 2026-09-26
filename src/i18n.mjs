/**
 * Localizes the first of several system keys that exists, so labels resolve across dnd5e
 * generations whose key names differ. Falls back to the last key's localization.
 * @param {...string} keys - Localization keys, preferred first
 * @returns {string}
 */
export function systemLabel(...keys) {
  const key = keys.find(k => game.i18n.has(k)) ?? keys[keys.length - 1];
  return game.i18n.localize(key);
}
