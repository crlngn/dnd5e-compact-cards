# Carolingian UI DnD5e Compact Cards

Compact activity cards for dnd5e 5.3+ and 6.0, shared as a git submodule by
[Carolingian UI](https://github.com/crlngn/crlngn-ui) and
[Flash Token Bar 5e](https://github.com/crlngn/flash-rolls-5e). Attack, damage and
healing rolls are folded into the usage card that created them as rows with a total
column and a drawer, saves are grouped into one row per ability, and the tag row is
unified and collapsed.

## System generations

A system adapter (`src/adapters/`) hides the differences between dnd5e generations;
the rest of the code only talks to it.

- **dnd5e 6.0+** builds on the system's own chat card summaries: roll messages whose
  `system.origin` points at a usage card are rendered by the system as
  `.card-summary` entries, and the package redirects the attack and damage summary
  templates to its own. The system hides the folded messages and refreshes the card.
- **dnd5e 5.3+** links rolls to their card through `flags.dnd5e.originatingMessage`
  and `dnd5e.registry.messages`, but renders nothing from that link. The adapter
  builds the `.card-summary` entries itself from the same templates (attack and
  damage) and from a save-summary shaped row (saves and checks), hides the folded
  roll messages in the log, and re-renders the card when a roll is created, updated
  or deleted. Targets are read and written as `flags.dnd5e.targets`. There is no
  "Summary Chat Cards" setting to keep in sync on 5.x.

The templates carry both variants: a `legacy` context flag and per-target `plain`
flags switch the 5.x markup on, since 5.x has no `target-pill` element or damage
breakdown partial. The retroactive advantage code is the same on both generations,
as the D20 die model is identical.

Support is declined when midi-qol is active on either generation: midi keeps its
rolls inside its own card and rewrites that card's rolls from memory, so folding
or changing them would desync its workflow.

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
      setCompactCards: value => game.settings.set("my-module", "compact-activity-cards", value),
      collapseTags: () => game.settings.get("my-module", "collapse-card-tags"),
      labeledButtons: () => game.settings.get("my-module", "labeled-card-buttons"),
      retroAdvantage: () => game.settings.get("my-module", "retro-advantage-buttons")
    },
    hooks: { renderRoll: "my-module.renderCompactRoll", renderCard: "my-module.renderCompactCard" },
    log: (ref, data) => console.debug(ref, ...data)
  });
  // Call cards.applyCompactCards(value) / applyCollapseTags(value) / applyLabeledButtons(value)
  // / applyRetroAdvantage(value) from the settings' onChange handlers.
});
```

The host's compact cards setting and the dnd5e "Summary Chat Cards" client setting
(`dnd5e.chatCardSummary`) are kept in sync. At `ready` the host's setting is the
source of truth and the dnd5e setting is changed to match it, with a notification.
Afterwards the user's last interaction wins: `applyCompactCards(value)` writes the
dnd5e setting, and a change of the dnd5e setting is written back through the
optional `setCompactCards` setter. Without the setter the display is only refreshed.

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

## Retroactive advantage

Attack rows, save entries, check summaries and standalone check and save cards carry
two buttons flanking the total, angles up on the left and angles down on the right,
for the roll's author and the GM, that apply advantage or disadvantage to a roll after it was made; clicking the active one
returns the roll to normal. The change rolls one extra d20 (two with Elven
Accuracy), shown through Dice So Nice when present, partitions the results the
way the system does, recomputes the total and formula, and updates the message's
rolls and flavor. Every d20 rolled for a message is kept under
`flags.<host>.retroAdvantage.pool`, so switching modes back and forth reuses the
same dice instead of rolling new ones, and the original mode is kept so a changed
roll shows a marked pill. A die Halfling Lucky rerolled away stays out of the
pool, a fresh natural 1 is rerolled the same way while that reroll is unused, and
the d20's minimum and maximum modifiers are re-applied to pooled dice so Reliable
Talent still counts. Rolls with explosions on the d20 are left alone, as are all
rolls when Ready Set Roll is active or the host's optional `retroAdvantage`
setting is off. `instance.setAdvantageMode(
rollMessage, mode, rollIndex?)` exposes the same operation for macros, with `mode`
one of `CONFIG.Dice.D20Roll.ADV_MODE`.

## Hooks

- `dnd5e-compact-cards.renderRoll` `({ origin, rollMessage, summary, row, drawer })`
  for each folded roll.
- `dnd5e-compact-cards.renderCard` `(message, html)` after a card is enriched.
- `dnd5e-compact-cards.resolved` `(activeId, registry)` once at `setup`.

Hosts may pass alias hook names that are fired alongside these.

## CSS

The stylesheet is gated by `body.dnd5e-compact-cards` (compact cards) and
`body.dnd5e-icon-card-buttons` (icon-only card buttons), which the active copy
toggles. Rules specific to the 5.x card markup match `body.crlngn-dnd5e-v5`, the
class Carolingian UI adds for the system's major version, or the 5.x card markup
itself. Colors use the host's `--cui-chat-*` tokens when defined and fall back to
values derived from the card's text color. All classes are prefixed `dcc-`.

## Releasing

Bump `version` in `package.json` on every change that hosts should prefer: the
registry compares that version to pick which host runs the feature.

## License

[Creative Commons Attribution-NonCommercial 4.0](https://creativecommons.org/licenses/by-nc/4.0/). See the LICENSE file.
