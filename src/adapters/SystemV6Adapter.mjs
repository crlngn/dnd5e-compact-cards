/**
 * System adapter for dnd5e 6.0 and later, where chat messages have data models and the system
 * itself renders roll messages as summaries inside the usage card that spawned them. The adapter
 * only redirects the attack and damage summary templates to the shared ones and reads roll data
 * from each message's `system`.
 */
export class SystemV6Adapter {
  /** @type {string} */
  generation = "v6";

  /** @type {boolean} The dnd5e "Summary Chat Cards" client setting exists and gates the feature */
  usesSummarySetting = true;

  /** @type {boolean} The card face carries only the target buttons: the attack row and the damage tray already list the targets */
  showsCardTargets = false;

  /** @type {boolean} The tag row stays a row of its own, with the system's tag icon */
  tagsInTargetsRow = false;

  /** @type {import("../CompactCards5e.mjs").CompactCards5e} */
  cards;

  /** @type {boolean} Whether the summary template getters have been installed */
  #patched = false;

  /**
   * @param {import("../CompactCards5e.mjs").CompactCards5e} cards
   */
  constructor(cards) {
    this.cards = cards;
  }

  /**
   * Checks that the message data models and the card summary mechanism exist
   * @returns {string} The reason support is declined, or an empty string
   */
  checkSupport() {
    const models = CONFIG.ChatMessage?.dataModels ?? {};
    if (!models.usage?.prototype || !models.attack?.prototype || !models.damage?.prototype) return "message data models missing";
    if (!("rendersSummaries" in models.usage.prototype)) return "no card summary support";
    return "";
  }

  /**
   * Installs summaryTemplate getters on the attack and damage message data models. The getters
   * return the shared templates while compact cards are active and fall back to the system's own
   * value otherwise, so the setting can be toggled without a reload.
   */
  install() {
    if (this.#patched) return;
    const models = CONFIG.ChatMessage.dataModels;
    const cards = this.cards;
    for (const [type, template] of Object.entries(this.cards.summaryTemplates)) {
      const proto = models[type]?.prototype;
      if (!proto) continue;
      const original = Object.getOwnPropertyDescriptor(proto, "summaryTemplate");
      Object.defineProperty(proto, "summaryTemplate", {
        configurable: true,
        get() {
          if (cards.isActive) return template;
          if (original?.get) return original.get.call(this);
          return this.metadata?.summaryTemplate ?? "";
        }
      });
    }
    this.#patched = true;
  }

  /**
   * Whether the dnd5e "Summary Chat Cards" setting allows summaries
   * @returns {boolean}
   */
  summarySettingEnabled() {
    try {
      return game.settings.get("dnd5e", "chatCardSummary") !== false;
    } catch (error) {
      return false;
    }
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
   * The usage card a roll message is folded into, if any
   * @param {ChatMessage} message
   * @returns {ChatMessage|null}
   */
  getOrigin(message) {
    const origin = message?.system?.origin;
    return origin?.system?.rendersSummaries ? origin : null;
  }

  /**
   * Kind of roll a message holds: attack, damage, save, check, death, or null for other messages
   * @param {ChatMessage} message
   * @returns {string|null}
   */
  getRollKind(message) {
    const type = message?.type;
    if (type === "save" && message.system?.type === "death") return "death";
    if (["attack", "damage", "save", "check"].includes(type)) return type;
    return null;
  }

  /**
   * @param {ChatMessage} message
   * @returns {boolean}
   */
  isHealing(message) {
    return message?.system?.isHealing === true;
  }

  /**
   * @param {ChatMessage} message
   * @returns {string}
   */
  getSaveAbility(message) {
    return message?.system?.ability ?? "";
  }

  /**
   * @param {ChatMessage} message
   * @returns {string}
   */
  getAttackMode(message) {
    return message?.system?.mode ?? "";
  }

  /**
   * Recorded targets of a message as `{ name, img, ac, actor, token }` descriptors
   * @param {ChatMessage} message
   * @returns {object[]}
   */
  getTargets(message) {
    return message?.system?.targets ?? [];
  }

  /**
   * Writes the recorded targets of a usage card
   * @param {ChatMessage} origin
   * @param {object[]} targets
   * @returns {Promise<ChatMessage>}
   */
  setTargets(origin, targets) {
    return origin.update({ "system.targets": targets });
  }

  /**
   * Builds target descriptors for tokens the way the system does, using its field when available
   * @param {Token[]} tokens
   * @returns {object[]}
   */
  getTargetDescriptors(tokens) {
    const TargetsField = dnd5e.dataModels?.chatMessage?.fields?.TargetsField;
    if (typeof TargetsField?.getDescriptors === "function") return TargetsField.getDescriptors(tokens);
    const targets = new Map();
    for (const target of tokens) {
      const token = target.document ?? target;
      const actor = token.actor;
      if (!actor) continue;
      const ac = actor.statuses?.has("coverTotal") ? null : actor.system?.attributes?.ac?.value;
      targets.set(token.uuid, { actor: actor.uuid, ac: ac ?? null, img: token.texture?.src, name: token.name, token: token.uuid });
    }
    return Array.from(targets.values());
  }

  /**
   * Resolves a recorded target descriptor to a token on the viewed scene, if any
   * @param {object} descriptor
   * @returns {Token|null}
   */
  resolveTargetToken(descriptor) {
    const TargetsField = dnd5e.dataModels?.chatMessage?.fields?.TargetsField;
    const resolved = TargetsField?.resolve?.(descriptor);
    if (resolved?.token) return resolved.token;
    return SystemV6Adapter.findTokenByActorUuid(descriptor?.actor);
  }

  /**
   * Finds a token on the viewed scene whose actor, or base actor, has the given actor UUID
   * @param {string} actorUuid
   * @returns {Token|null}
   */
  static findTokenByActorUuid(actorUuid) {
    const actorId = foundry.utils.parseUuid(actorUuid ?? "")?.id;
    if (!actorId) return null;
    return canvas.tokens?.placeables.find(t => t.document.actor?.id === actorId || t.document.baseActor?.id === actorId) ?? null;
  }

  /**
   * UUIDs of the token and actor a roll message speaks for
   * @param {ChatMessage} message
   * @returns {{ token?: string, actor?: string }}
   */
  getSpeakerUuids(message) {
    return {
      token: message.getAssociatedToken?.()?.uuid,
      actor: message.getAssociatedActor?.()?.uuid
    };
  }

  /**
   * The system renders the summaries itself, so nothing is done here
   * @param {ChatMessage} origin
   * @param {HTMLElement} content
   */
  renderSummaries(origin, content) {}

  /**
   * Element the `.card-summary` entries are direct children of
   * @param {HTMLElement} content - The message content element
   * @returns {HTMLElement}
   */
  getSummaryContainer(content) {
    return content;
  }

  /**
   * The card's tag row and its pill list, if the card has one
   * @param {HTMLElement} face - The `.chat-card` element
   * @returns {{ row: HTMLElement, list: HTMLElement }|null}
   */
  getTagRow(face) {
    const rows = Array.from(face.querySelectorAll(":scope > .icon-row"));
    const row = rows.find(r => r.querySelector(":scope > i.fa-tag") && r.querySelector(":scope > ul.pills"));
    return row ? { row, list: row.querySelector(":scope > ul.pills") } : null;
  }

  /**
   * Creates an empty tag row in the system's markup
   * @returns {{ row: HTMLElement, list: HTMLElement }}
   */
  createTagRow() {
    const row = document.createElement("section");
    row.className = "icon-row";
    row.innerHTML = `<i class="fa-fw fa-solid fa-tag" aria-label="${game.i18n.localize("DND5E.CHATMESSAGE.Row.Properties")}"></i><ul class="pills unlist"></ul>`;
    return { row, list: row.querySelector(":scope > ul.pills") };
  }

  /**
   * The row holding the card's action buttons, if any
   * @param {HTMLElement} face - The `.chat-card` element
   * @returns {HTMLElement|null}
   */
  getButtonsRow(face) {
    const rows = Array.from(face.querySelectorAll(":scope > .icon-row"));
    return rows.find(r => r.querySelector(":scope > ul.unlist:not(.pills)")) ?? null;
  }

  /**
   * Total buttons of the d20 rolls the system rendered in an element, in roll order, each with
   * the pill list the advantage pill goes on. On check summaries and standalone check or save
   * cards each roll row is an icon row holding the roll's total button; the pill goes on the
   * first pill list of the element, which names the target on summaries.
   * @param {HTMLElement} element - The summary or message content element
   * @returns {{ button: HTMLElement, pills: HTMLElement|null }[]}
   */
  getRollTotals(element) {
    const pills = element.querySelector(".icon-row > ul.pills");
    return Array.from(element.querySelectorAll(".icon-row > button.dice-roll"))
      .map((button, index) => ({ button, pills: index === 0 ? pills : null }));
  }

  /**
   * The system hides folded roll messages itself, so nothing is done here
   * @param {ChatMessage} message
   * @param {HTMLElement} html
   */
  onRenderRollMessage(message, html) {}
}
