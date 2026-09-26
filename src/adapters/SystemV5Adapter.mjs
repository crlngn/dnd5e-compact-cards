import { SystemV6Adapter } from "./SystemV6Adapter.mjs";
import { systemLabel } from "../i18n.mjs";
import { FOLDED_KINDS } from "../rollKinds.mjs";

/** Kind of row each dnd5e 5.x roll type becomes */
const ROLL_KINDS = {
  attack: "attack",
  damage: "damage",
  healing: "damage",
  save: "save",
  ability: "check",
  skill: "check",
  tool: "check",
  death: "death"
};

/**
 * System adapter for dnd5e 5.x. Roll messages point at their usage card through
 * `flags.dnd5e.originatingMessage` and the system indexes them in `dnd5e.registry.messages`, but
 * it neither renders them inside the card nor refreshes the card when they change. The adapter
 * builds the `.card-summary` entries the enrichment code expects, hides the folded roll
 * messages in the log, and re-renders the card when a roll is created, updated or deleted.
 */
export class SystemV5Adapter {
  /** @type {string} */
  generation = "v5";

  /** @type {boolean} dnd5e 5.x has no "Summary Chat Cards" setting */
  usesSummarySetting = false;

  /** @type {boolean} The card face carries only the target buttons: the attack row and the damage tray already list the targets */
  showsCardTargets = false;

  /** @type {boolean} The card's tags share the row with the target buttons, since the card footer has no icon of its own */
  tagsInTargetsRow = true;

  /** @type {import("../CompactCards5e.mjs").CompactCards5e} */
  cards;

  /** @type {Set<string>} Ids of messages queued for a re-render */
  #pendingRefresh = new Set();

  /** @type {boolean} */
  #installed = false;

  /**
   * @param {import("../CompactCards5e.mjs").CompactCards5e} cards
   */
  constructor(cards) {
    this.cards = cards;
  }

  /**
   * Checks that the message registry and the template API the adapter relies on exist
   * @returns {string} The reason support is declined, or an empty string
   */
  checkSupport() {
    if (typeof dnd5e?.registry?.messages?.get !== "function") return "message registry missing";
    if (typeof ChatMessage.implementation?.prototype?.getAssociatedRolls !== "function") return "associated rolls missing";
    if (typeof foundry.applications?.handlebars?.loadTemplates !== "function") return "handlebars api missing";
    return "";
  }

  /**
   * Listens for roll messages being created, updated or deleted so their card re-renders
   */
  install() {
    if (this.#installed) return;
    this.#installed = true;
    Hooks.on("createChatMessage", this.#onCreateMessage);
    Hooks.on("deleteChatMessage", this.#onDeleteMessage);
    Hooks.on("updateChatMessage", this.#onUpdateMessage);
  }

  /**
   * @param {ChatMessage} message
   */
  #onCreateMessage = (message) => {
    this.#refreshOrigin(message);
  };

  /**
   * Re-renders the card a deleted roll belonged to. When the card itself is deleted its folded
   * rolls are re-rendered so they show up in the log again.
   * @param {ChatMessage} message
   */
  #onDeleteMessage = (message) => {
    this.#refreshOrigin(message);
    if (!this.cards.isActive || !this.isUsageMessage(message)) return;
    for (const child of this.#childrenOf(message.id)) this.#scheduleRefresh(child.id);
  };

  /**
   * Flag changes on a roll, such as the ammunition data the system adds after an attack, change
   * what the row shows. Roll changes are handled by the shared code for both generations.
   * @param {ChatMessage} message
   * @param {object} changed
   */
  #onUpdateMessage = (message, changed) => {
    if ("flags" in (changed ?? {})) this.#refreshOrigin(message);
  };

  /**
   * Roll messages the registry lists for a usage card
   * @param {string} originId
   * @returns {ChatMessage[]}
   */
  #childrenOf(originId) {
    try {
      return dnd5e.registry.messages.get(originId) ?? [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Queues a re-render of the card a roll message belongs to
   * @param {ChatMessage} message
   */
  #refreshOrigin(message) {
    if (!this.cards.isActive) return;
    const originId = message?.getFlag?.("dnd5e", "originatingMessage");
    if (originId && this.getRollKind(message)) this.#scheduleRefresh(originId);
  }

  /**
   * Re-renders a message in the chat log and its popout once the current document operation has
   * finished, coalescing several changes to the same card into one render
   * @param {string} id
   */
  #scheduleRefresh(id) {
    if (this.#pendingRefresh.has(id)) return;
    this.#pendingRefresh.add(id);
    setTimeout(() => {
      this.#pendingRefresh.delete(id);
      const message = game.messages.get(id);
      if (!message) return;
      for (const log of [ui.chat, ui.chat?.popout]) log?.updateMessage?.(message);
    }, 0);
  }

  /**
   * There is no summary setting to honor on 5.x
   * @returns {boolean}
   */
  summarySettingEnabled() {
    return true;
  }

  /**
   * Whether a message is an activity usage card
   * @param {ChatMessage} message
   * @returns {boolean}
   */
  isUsageMessage(message) {
    return message?.type === "usage";
  }

  /**
   * The usage card a roll message points at, if it still exists
   * @param {ChatMessage} message
   * @returns {ChatMessage|null}
   */
  getOrigin(message) {
    const id = message?.getFlag?.("dnd5e", "originatingMessage");
    if (!id || id === message.id) return null;
    const origin = game.messages.get(id);
    return this.isUsageMessage(origin) ? origin : null;
  }

  /**
   * Kind of roll a message holds: attack, damage, save, check, death, or null for other messages
   * @param {ChatMessage} message
   * @returns {string|null}
   */
  getRollKind(message) {
    return ROLL_KINDS[message?.getFlag?.("dnd5e", "roll.type")] ?? null;
  }

  /**
   * @param {ChatMessage} message
   * @returns {boolean}
   */
  isHealing(message) {
    return message?.getFlag?.("dnd5e", "roll.type") === "healing";
  }

  /**
   * @param {ChatMessage} message
   * @returns {string}
   */
  getSaveAbility(message) {
    return message?.getFlag?.("dnd5e", "roll.ability") ?? "";
  }

  /**
   * @param {ChatMessage} message
   * @returns {string}
   */
  getAttackMode(message) {
    return message?.getFlag?.("dnd5e", "roll.attackMode") ?? "";
  }

  /**
   * Recorded targets of a message, converted from the system's `{ name, img, uuid, ac }` entries,
   * whose uuid is the actor's, to the `{ name, img, ac, actor, token }` shape the shared code uses
   * @param {ChatMessage} message
   * @returns {object[]}
   */
  getTargets(message) {
    const targets = message?.getFlag?.("dnd5e", "targets") ?? [];
    return targets.map(t => ({ name: t.name, img: t.img, ac: t.ac ?? null, actor: t.uuid }));
  }

  /**
   * Writes the recorded targets of a usage card in the system's own shape, which its damage and
   * effect trays read in "targeted" mode
   * @param {ChatMessage} origin
   * @param {object[]} targets
   * @returns {Promise<ChatMessage>}
   */
  setTargets(origin, targets) {
    const stored = targets.map(t => ({ name: t.name, img: t.img, uuid: t.actor, ac: t.ac ?? null }));
    return origin.update({ "flags.dnd5e.targets": stored });
  }

  /**
   * Builds target descriptors for tokens the way the system's `getTargetDescriptors` does, one per actor
   * @param {Token[]} tokens
   * @returns {object[]}
   */
  getTargetDescriptors(tokens) {
    const targets = new Map();
    for (const target of tokens) {
      const token = target.document ?? target;
      const actor = token.actor;
      if (!actor) continue;
      const ac = actor.statuses?.has("coverTotal") ? null : actor.system?.attributes?.ac?.value;
      targets.set(actor.uuid, { name: token.name, img: actor.img, ac: ac ?? null, actor: actor.uuid });
    }
    return Array.from(targets.values());
  }

  /**
   * Resolves a recorded target descriptor to a token on the viewed scene, if any
   * @param {object} descriptor
   * @returns {Token|null}
   */
  resolveTargetToken(descriptor) {
    return SystemV6Adapter.findTokenByActorUuid(descriptor?.actor);
  }

  /**
   * UUIDs of the token and actor a roll message speaks for
   * @param {ChatMessage} message
   * @returns {{ token?: string, actor?: string }}
   */
  getSpeakerUuids(message) {
    const { scene, token } = message.speaker ?? {};
    return {
      token: scene && token ? `Scene.${scene}.Token.${token}` : undefined,
      actor: message.getAssociatedActor?.()?.uuid
    };
  }

  /**
   * Renders the usage card's folded rolls as `.card-summary` entries after the card face, in the
   * order the system lists them, using the shared attack and damage templates and a row of the
   * system's save summary shape for saves and checks. The summaries are inserted after the system
   * enriched the message, which is when it strips the `dnd5e2` class from nested elements, so the
   * same is done here: under a dark interface theme a nested `dnd5e2` element would otherwise take
   * the system's dark variables and paint the damage tray dark inside the light card
   * @param {ChatMessage} origin
   * @param {HTMLElement} content - The message content element
   */
  renderSummaries(origin, content) {
    const container = this.getSummaryContainer(content);
    if (!container || container.querySelector(":scope > .card-summary")) return;
    const anchor = container.querySelector(":scope > effect-application");
    for (const message of this.#childrenOf(origin.id)) {
      const kind = this.getRollKind(message);
      if (!FOLDED_KINDS.has(kind) || !message.visible) continue;
      const html = this.#renderSummary(origin, message, kind);
      if (!html) continue;
      const summary = document.createElement("div");
      summary.className = "card-summary";
      summary.dataset.messageId = message.id;
      const token = this.getSpeakerUuids(message).token;
      if (token) summary.dataset.targetUuid = token;
      summary.innerHTML = html;
      summary.querySelectorAll(".dnd5e2").forEach(el => el.classList.remove("dnd5e2"));
      if (anchor) anchor.before(summary);
      else container.appendChild(summary);
      if (kind === "damage") this.#prepareDamageTray(message, summary);
      this.#addDeleteControl(message, summary);
    }
  }

  /**
   * HTML of one folded roll
   * @param {ChatMessage} origin
   * @param {ChatMessage} message
   * @param {string} kind
   * @returns {string}
   */
  #renderSummary(origin, message, kind) {
    if (kind === "attack") return this.#renderTemplate(origin, this.cards.summaryTemplates.attack, this.#attackContext(message));
    if (kind === "damage") return this.#renderTemplate(origin, this.cards.summaryTemplates.damage, this.#damageContext(message));
    return this.#renderD20Summary(origin, message, kind);
  }

  /**
   * Renders a preloaded template synchronously, the way the system's renderTemplate does once
   * the template is compiled. When the template is not compiled yet the card is re-rendered as
   * soon as the templates have loaded.
   * @param {ChatMessage} origin
   * @param {string} path
   * @param {object} context
   * @returns {string}
   */
  #renderTemplate(origin, path, context) {
    const template = Handlebars.partials[path];
    if (typeof template !== "function") {
      this.cards.templatesReady?.then(() => this.#scheduleRefresh(origin.id));
      return "";
    }
    return template(context, { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true });
  }

  /**
   * Context for the attack summary template: the total button with the classes the system's
   * highlighting would give it, the weapon mastery and the recorded targets with hit or miss
   * evaluated the way the system's attack card does
   * @param {ChatMessage} message
   * @returns {object}
   */
  #attackContext(message) {
    const roll = message.rolls.find(r => r?.validD20Roll) ?? message.rolls[0];
    const visible = message.isContentVisible;
    const visibility = this.#setting("attackRollVisibility", "all");
    const showResult = visible && (game.user.isGM || visibility !== "none");
    const showAC = game.user.isGM || visibility === "all";
    const masteryConfig = CONFIG.DND5E.weaponMasteries?.[message.getFlag("dnd5e", "roll.mastery")];
    const mastery = masteryConfig ? { label: game.i18n.localize(masteryConfig.label), reference: masteryConfig.reference } : null;
    const classes = [];
    if (roll && showResult) {
      if (roll.isCritical) classes.push("critical");
      if (roll.isFumble) classes.push("fumble");
      if (Number.isNumeric(roll.options?.target)) classes.push(roll.isSuccess ? "success" : "failure");
    }
    const targets = this.getTargets(message).map(target => {
      const hasAC = Number.isNumeric(target.ac);
      const isMiss = Boolean(roll && showResult && !roll.isCritical && ((hasAC && roll.total < target.ac) || roll.isFumble));
      return { name: target.name, ac: target.ac, hasAC, showAC, showResult, isMiss, plain: true };
    });
    return {
      header: {},
      mastery,
      rolls: [this.#totalButton(roll, visible, classes)],
      targets,
      targetsLabel: systemLabel("DND5E.CHATMESSAGE.Row.Targets", "DND5E.TargetPl", "DND5E.Targets"),
      rows: { properties: { entries: [] } },
      legacy: true
    };
  }

  /**
   * Context for the damage summary template: one part per aggregated damage type, the grand
   * total, the damage-on-save note and whether the GM's damage tray is shown
   * @param {ChatMessage} message
   * @returns {object}
   */
  #damageContext(message) {
    const rolls = message.rolls;
    const isPrivate = !message.isContentVisible;
    const parts = this.#aggregate(rolls).map(roll => {
      const type = roll.options?.type;
      const config = CONFIG.DND5E.damageTypes?.[type] ?? CONFIG.DND5E.healingTypes?.[type];
      return { type, config, total: roll.total, label: config?.label ?? "" };
    });
    const total = rolls.reduce((sum, roll) => sum + (roll.total ?? 0), 0);
    const onSaveKey = message.getFlag("dnd5e", "roll.damageOnSave");
    const onSaveI18n = onSaveKey ? `DND5E.SAVE.FIELDS.damage.onSave.${onSaveKey.capitalize()}` : "";
    return {
      parts,
      total,
      isPrivate,
      onSave: onSaveI18n && game.i18n.has(onSaveI18n) ? game.i18n.localize(onSaveI18n) : "",
      showTray: game.user.isGM,
      rows: { properties: { entries: [] } },
      legacy: true
    };
  }

  /**
   * Aggregates damage rolls by type the way the system's breakdown does
   * @param {Roll[]} rolls
   * @param {object} [options]
   * @returns {Roll[]}
   */
  #aggregate(rolls, options) {
    const aggregate = dnd5e.dice?.aggregateDamageRolls;
    if (typeof aggregate !== "function" || (!options && !CONFIG.DND5E.aggregateDamageDisplay)) return rolls;
    try {
      return aggregate(rolls, options);
    } catch (error) {
      return rolls;
    }
  }

  /**
   * Gives the GM's damage tray the damages the system would give it on the roll message itself
   * @param {ChatMessage} message
   * @param {HTMLElement} summary
   */
  #prepareDamageTray(message, summary) {
    const tray = summary.querySelector("damage-application");
    if (!tray) return;
    tray.damages = this.#aggregate(message.rolls, { respectProperties: true }).map(roll => ({
      value: Math.max(0, roll.total),
      type: roll.options?.type,
      properties: new Set(roll.options?.properties ?? [])
    }));
  }

  /**
   * A save or check folded into the card, in the shape of the system's save summary: an icon
   * row naming the roller, with the roll's total button marked as a success or failure when the
   * challenge is visible. Checks also name what was rolled.
   * @param {ChatMessage} origin
   * @param {ChatMessage} message
   * @param {string} kind
   * @returns {string}
   */
  #renderD20Summary(origin, message, kind) {
    const roll = message.rolls.find(r => r?.validD20Roll) ?? message.rolls[0];
    if (!roll) return "";
    const visible = message.isContentVisible;
    const showResult = visible && (origin.shouldDisplayChallenge ?? game.user.isGM);
    const classes = [];
    if (showResult && Number.isNumeric(roll.options?.target)) classes.push(roll.isSuccess ? "success" : "failure");
    const escape = foundry.utils.escapeHTML;
    const pills = [`<li class="pill target transparent">${escape(message.alias ?? "")}</li>`];
    if (kind === "check") {
      const label = this.#stripAdvantage(message.flavor ?? "");
      if (label) pills.push(`<li class="pill transparent"><span class="label">${escape(label)}</span></li>`);
    }
    return `
      <section class="icon-row ${kind}-summary" data-roll-type="${kind}">
        <i class="fa-fw fa-solid fa-dice" inert></i>
        <ul class="pills unlist">${pills.join("")}</ul>
        ${this.#totalButton(roll, visible, classes, true)}
      </section>
    `;
  }

  /**
   * The total button of a d20 or damage roll in the shape the shared styles expect
   * @param {Roll|undefined} roll
   * @param {boolean} visible - Whether the current user may see the result
   * @param {string[]} classes - Result classes: success, failure, critical, fumble
   * @param {boolean} [icons=false] - Whether to add the check or cross icon the system shows on saves
   * @returns {string}
   */
  #totalButton(roll, visible, classes, icons = false) {
    const total = visible ? (roll?.total ?? "") : "?";
    let iconHtml = "";
    if (icons && classes.includes("success")) iconHtml = `<div class="icons"><i class="fa-solid fa-check" inert></i></div>`;
    else if (icons && classes.includes("failure")) iconHtml = `<div class="icons"><i class="fa-solid fa-xmark" inert></i></div>`;
    return `<button type="button" class="dice-roll ${classes.join(" ")}"${visible ? "" : " disabled"}>${iconHtml}<span class="result"><strong class="total">${total}</strong></span></button>`;
  }

  /**
   * Removes the advantage suffix the system appends to a roll message's flavor
   * @param {string} flavor
   * @returns {string}
   */
  #stripAdvantage(flavor) {
    let result = String(flavor);
    for (const key of ["DND5E.Advantage", "DND5E.Disadvantage"]) result = result.replace(` (${game.i18n.localize(key)})`, "");
    return result.trim();
  }

  /**
   * Adds the control that deletes a folded roll, since its own message is hidden in the log
   * @param {ChatMessage} message
   * @param {HTMLElement} summary
   */
  #addDeleteControl(message, summary) {
    if (!message.canUserModify?.(game.user, "delete")) return;
    const host = summary.querySelector(":scope > .dcc-row-title") ?? summary.firstElementChild;
    if (!host) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "unbutton control-button message-delete dcc-delete";
    button.setAttribute("aria-label", game.i18n.localize("Delete"));
    button.setAttribute("data-tooltip", "");
    button.innerHTML = `<i class="fa-solid fa-trash" inert></i>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      message.delete();
    });
    host.appendChild(button);
  }

  /**
   * Reads a dnd5e setting, with a fallback when it is not registered
   * @param {string} key
   * @param {any} fallback
   * @returns {any}
   */
  #setting(key, fallback) {
    try {
      return game.settings.get("dnd5e", key);
    } catch (error) {
      return fallback;
    }
  }

  /**
   * The system's usage card template wraps the card face in a div that also holds the effects
   * tray, so summaries go into that wrapper
   * @param {HTMLElement} content - The message content element
   * @returns {HTMLElement}
   */
  getSummaryContainer(content) {
    return content.querySelector(":scope > div:has(> .chat-card)") ?? content;
  }

  /**
   * The card footer holds the card's tags on 5.x, so it is both the row and the list
   * @param {HTMLElement} face - The `.chat-card` element
   * @returns {{ row: HTMLElement, list: HTMLElement }|null}
   */
  getTagRow(face) {
    const list = face.querySelector(":scope > ul.card-footer.pills");
    return list ? { row: list, list } : null;
  }

  /**
   * Creates an empty card footer
   * @returns {{ row: HTMLElement, list: HTMLElement }}
   */
  createTagRow() {
    const list = document.createElement("ul");
    list.className = "card-footer pills unlist";
    return { row: list, list };
  }

  /**
   * The card's action buttons container, if any
   * @param {HTMLElement} face - The `.chat-card` element
   * @returns {HTMLElement|null}
   */
  getButtonsRow(face) {
    return face.querySelector(":scope > .card-buttons");
  }

  /**
   * Totals of the rolls shown in an element. Rows this adapter rendered hold the total in a
   * button next to the pill list, like the system's 6.0 summaries. A standalone roll card shows
   * each total as a heading inside the dice result block; its value is wrapped in a span the
   * advantage buttons flank inside the heading, leaving the system's result icons in place.
   * There is no pill list on these cards.
   * @param {HTMLElement} element - The summary or message content element
   * @returns {{ button: HTMLElement, pills: HTMLElement|null }[]}
   */
  getRollTotals(element) {
    const buttons = Array.from(element.querySelectorAll(".icon-row > button.dice-roll"));
    if (buttons.length) {
      const pills = element.querySelector(".icon-row > ul.pills");
      return buttons.map((button, index) => ({ button, pills: index === 0 ? pills : null }));
    }
    return Array.from(element.querySelectorAll(".dice-roll .dice-total")).map(total => {
      let value = total.querySelector(":scope > .dcc-total-value");
      if (!value) {
        value = document.createElement("span");
        value.className = "dcc-total-value";
        const moved = Array.from(total.childNodes).filter(node => !(node instanceof HTMLElement && node.classList.contains("icons")));
        value.append(...moved);
        total.appendChild(value);
      }
      return { button: value, pills: null };
    });
  }

  /**
   * Hides a roll message that is folded into an existing usage card, as the system does on 6.0
   * @param {ChatMessage} message
   * @param {HTMLElement} html - The chat message element
   */
  onRenderRollMessage(message, html) {
    if (!this.cards.isActive) return;
    if (!FOLDED_KINDS.has(this.getRollKind(message)) || !this.getOrigin(message)) return;
    html.hidden = true;
  }
}
