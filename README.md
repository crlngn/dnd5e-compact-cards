# Carolingian UI DnD5e Compact Cards

Compact activity cards for dnd5e 6.0, shared as a git submodule by
[Carolingian UI](https://github.com/crlngn/crlngn-ui) and
[Flash Token Bar 5e](https://github.com/crlngn/flash-rolls-5e). It builds on the
system's own chat card summary mechanism: attack, damage and healing rolls whose
`system.origin` points at a usage card are folded into that card as rows with a
total column and a drawer, saves are grouped into one row per ability, and the
tag row is unified and collapsed.

The package is source only. Each host bundles `src/` with Vite, imports the
stylesheet, and copies the two templates into its own `templates/` folder.

## Host integration

```js
import { registerCompactCards } from "../shared/dnd5e-compact-cards/src/index.mjs";

Hooks.once("init", () => {
  const cards = registerCompactCards({
    id: "my-module",
    templatesPath: "modules/my-module/templates",
    i18nPrefix: "MY_MODULE.compactCards",
    settings: {
      compactCards: () => game.settings.get("my-module", "compact-activity-cards"),
      collapseTags: () => game.settings.get("my-module", "collapse-card-tags"),
      labeledButtons: () => game.settings.get("my-module", "labeled-card-buttons")
    },
    hooks: { renderRoll: "my-module.renderCompactRoll", renderCard: "my-module.renderCompactCard" },
    log: (ref, data) => console.debug(ref, ...data)
  });
  // Call cards.applyCompactCards(value) / applyCollapseTags(value) / applyLabeledButtons(value)
  // from the settings' onChange handlers.
});
```

Build steps for a host:

- `import "../shared/dnd5e-compact-cards/styles/compact-cards.css"` from the module entry.
- Copy `templates/*.hbs` into the host's `dist/templates` (rollup-plugin-copy target).
- Copy `lang/en.json` under the `i18nPrefix` in every language the host ships.

## One active copy

Every host registers a candidate `{ id, version, activate, deactivate }` on
`globalThis.dnd5eCompactCards` during `init`. At `setup` the registry activates the
candidate bundling the newest package version; ties go to `crlngn-ui`. The other
copies install nothing and expose the winner through `instance.handledBy`, so their
settings can show a hint. `globalThis.dnd5eCompactCards.isActive` reports whether
compact cards are in effect on this client regardless of which host runs them.

## Hooks

- `dnd5e-compact-cards.renderRoll` `({ origin, rollMessage, summary, row, drawer })`
  for each folded roll.
- `dnd5e-compact-cards.renderCard` `(message, html)` after a card is enriched.
- `dnd5e-compact-cards.resolved` `(activeId, registry)` once at `setup`.

Hosts may pass alias hook names that are fired alongside these.

## CSS

The stylesheet is gated by `body.dnd5e-compact-cards` (compact cards) and
`body.dnd5e-icon-card-buttons` (icon-only card buttons), which the active copy
toggles. Colors use the host's `--cui-chat-*` tokens when defined and fall back to
values derived from the card's text color. All classes are prefixed `dcc-`.

## Releasing

Bump `version` in `package.json` on every change that hosts should prefer: the
registry compares that version to pick which host runs the feature.

## License

[Creative Commons Attribution-NonCommercial 4.0](https://creativecommons.org/licenses/by-nc/4.0/). See the LICENSE file.
