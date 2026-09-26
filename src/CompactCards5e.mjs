import { COMPACT_CARDS_HOOKS } from "./hooks.mjs";

/** Number of tags shown before the row collapses behind a "+N" chip */
const VISIBLE_TAGS = 3;

/**
 * Display priority of usage card tags by dnd5e property type, per item kind. Lower sorts first.
 * Keys are the property type, or `property:<id>` for a specific item property such as concentration.
 * Tags coming from the roll cards use the "roll" key.
 * @type {Record<string, Record<string, number>>}
 */
const TAG_PRIORITY = {
  default: {
    activation: 0,
    reach: 1,
    range: 2,
    target: 3,
    property: 4,
    mastery: 4,
    duration: 5,
    components: 6,
    level: 7,
    school: 7,
    "weapon:category": 8,
    "weapon:class": 8,
    proficiency: 8,
    label: 9,
    roll: 10
  },
  spell: {
    activation: 0,
    "property:concentration": 1,
    components: 2,
    range: 3,
    target: 4,
    duration: 5,
    property: 6,
    level: 7,
    school: 7,
    label: 9,
    roll: 10
  }
};

/** Priority used for tags whose type could not be determined */
const DEFAULT_TAG_PRIORITY = 9;

/** Icon shown on healing rows, the same one dnd5e uses on the healing button */
const HEALING_ICON = "systems/dnd5e/icons/svg/damage/healing.svg";

/** Body class set while compact cards are in effect */
export const COMPACT_CARDS_BODY_CLASS = "dnd5e-compact-cards";

/** Body class set while card buttons are icon-only */
export const ICON_BUTTONS_BODY_CLASS = "dnd5e-icon-card-buttons";

/** Key of the dnd5e "Summary Chat Cards" client setting compact cards build on, kept in sync with the host's setting */
export const DND5E_SUMMARY_SETTING = "chatCardSummary";

/** Flag, under the host module's scope, recording a roll whose advantage mode was changed after the fact */
export const RETRO_FLAG = "retroAdvantage";

/** Module that provides its own retroactive advantage buttons, so this feature stays out of its way */
const READY_SET_ROLL_ID = "ready-set-roll-5e";

/**
 * @typedef {Object} CompactCardsSettings
 * @property {() => boolean} compactCards - Whether the host's compact cards setting is on
 * @property {(value: boolean) => Promise<void>|void} [setCompactCards] - Writes the host's compact cards setting, so it follows the dnd5e "Summary Chat Cards" setting when the user changes that one instead
 * @property {() => boolean} collapseTags - Whether the host's collapse tags setting is on
 * @property {() => boolean} labeledButtons - Whether the host's labeled buttons setting is on
 * @property {() => boolean} [retroAdvantage] - Whether the host's retroactive advantage buttons setting is on; treated as on when missing
 */

/**
 * @typedef {Object} CompactCardsOptions
 * @property {string} id - Id of the host module
 * @property {string} templatesPath - Directory the two summary templates are served from, e.g. `modules/<id>/templates`
 * @property {string} i18nPrefix - Prefix of the host's localization keys for this feature, e.g. `CRLNGN_UI.dnd5e.chatCard`
 * @property {CompactCardsSettings} settings - Getters for the host's settings
 * @property {{ renderRoll?: string, renderCard?: string }} [hooks] - Host-specific hook names fired in addition to the shared ones
 * @property {(ref: string, data?: any[]) => void} [log] - Debug logger
 * @property {(ref: string, data?: any[]) => void} [warn] - Warning logger
 */

/**
 * Compact activity cards for dnd5e 6.0: folds attack, damage and healing rolls into the activity
 * card that created them, groups save rolls into one row, unifies and collapses the tag row,
 * and toggles labeled or icon-only card buttons.
 *
 * One instance is created per host module. Only the instance the shared registry picks at
 * `setup` is activated; the others stay inert and expose the id of the module handling the
 * feature through `handledBy`.
 */
export class CompactCards5e {
  /** @type {CompactCardsOptions} */
  options;
  /** @type {boolean} Whether the registry activated this copy */
  activated = false;
  /** @type {string|null} Id of the module handling the feature when this copy was not activated */
  handledBy = null;
  /** @type {boolean} Whether the running system supports the summary mechanism this feature builds on */
  isSupported = false;
  /** @type {string} Why support was declined, for diagnostics */
  unsupportedReason = "";
  /** @type {Record<string, string>} Summary templates keyed by the ChatMessage document type */
  #summaryTemplates;
  /** @type {boolean} Whether summary template getters have been installed */
  #patched = false;
  /** @type {Map<string, boolean>} Open state of roll drawers, keyed by `${originId}:${rollMessageId}` */
  #drawerStates = new Map();
  /** @type {Map<string, boolean>} Expanded state of tag rows, keyed by origin message id */
  #tagStates = new Map();
  /** @type {Map<string, boolean>} Open state of save sections, keyed by `${originId}:${ability}` */
  #saveStates = new Map();
  /** @type {boolean} Whether a setting write started by this copy is in progress, so its change is not mirrored back */
  #syncing = false;

  /**
   * @param {CompactCardsOptions} options
   */
  constructor(options) {
    this.options = options;
    const base = options.templatesPath.replace(/\/$/, "");
    this.#summaryTemplates = {
      attack: `${base}/chat-summary-attack.hbs`,
      damage: `${base}/chat-summary-damage.hbs`
    };
  }

  /**
   * Id of the host module that created this instance
   * @returns {string}
   */
  get id() {
    return this.options.id;
  }

  /**
   * Whether compact cards are currently in effect for this client through this copy
   * @returns {boolean}
   */
  get isActive() {
    if (!this.activated || !this.isSupported || !this.#setting("compactCards")) return false;
    try {
      return game.settings.get("dnd5e", "chatCardSummary") !== false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Activates this copy: checks support, installs the summary templates and hooks, and sets the
   * body classes before the chat log renders for the first time. Called by the registry at `setup`,
   * once every package has finished its init hook so the system's message data models exist.
   */
  activate() {
    if (this.activated || game.system?.id !== "dnd5e") return;
    this.activated = true;
    this.handledBy = null;
    this.isSupported = this.#checkSupport();
    this.#log("CompactCards5e.activate", [this.id, this.isSupported, this.unsupportedReason]);
    if (!this.isSupported) return;
    this.applyLabeledButtons();

    foundry.applications.handlebars.loadTemplates(Object.values(this.#summaryTemplates));
    this.#patchSummaryTemplates();
    Hooks.on("dnd5e.renderChatMessage", this.#onRenderChatMessage);
    Hooks.on("clientSettingChanged", this.#onClientSettingChanged);
    Hooks.on("updateSetting", this.#onUpdateSetting);
    Hooks.on("updateChatMessage", this.#onUpdateChatMessage);
    this.applyCompactCards(undefined, false);
    Hooks.once("ready", () => {
      this.applyCompactCards(undefined, false);
      this.#syncSummarySetting(this.#setting("compactCards"), true);
    });
  }

  /**
   * Marks this copy as inert because another module's copy was activated
   * @param {string} handledBy - Id of the module handling the feature
   */
  deactivate(handledBy) {
    this.activated = false;
    this.handledBy = handledBy ?? null;
  }

  /**
   * Makes the dnd5e "Summary Chat Cards" setting match the host's compact cards setting, then
   * applies the result. At load the host's setting is the source of truth and the user is told
   * when the dnd5e setting had to change; after a user interaction the change is mirrored silently.
   * @param {boolean} value - Desired state of both settings
   * @param {boolean} [notify=false] - Whether to notify the user when the dnd5e setting was changed
   */
  async #syncSummarySetting(value, notify = false) {
    if (!this.activated) return;
    if (!this.isSupported) {
      if (value) this.#log("CompactCards5e: compact activity cards are enabled but inactive", [this.unsupportedReason]);
      return;
    }
    const current = this.#getSummarySetting();
    if (current !== null && current !== value) {
      this.#syncing = true;
      try {
        await game.settings.set("dnd5e", DND5E_SUMMARY_SETTING, value);
        if (notify) ui.notifications?.info(this.#localize(value ? "enabledSummarySetting" : "disabledSummarySetting"));
      } catch (error) {
        this.#warn("CompactCards5e: could not change the dnd5e chatCardSummary setting", [error]);
        if (value) ui.notifications?.warn(this.#localize("needsSummarySetting"));
      } finally {
        this.#syncing = false;
      }
    }
    this.#refreshSummarySettingInputs();
    this.applyCompactCards();
  }

  /**
   * Updates the "Summary Chat Cards" checkbox in any open settings form to the stored value.
   * Foundry's settings window does not re-render when a setting changes underneath it, so
   * without this a later save of that window would write its stale value back.
   */
  #refreshSummarySettingInputs() {
    const value = this.#getSummarySetting();
    if (value === null) return;
    const inputs = document.querySelectorAll(`form input[type="checkbox"][name="dnd5e.${DND5E_SUMMARY_SETTING}"]`);
    for (const input of inputs) input.checked = value;
  }

  /**
   * Mirrors a change of the dnd5e "Summary Chat Cards" setting made outside this copy onto the
   * host's compact cards setting, so the user's last interaction wins whichever setting it touched.
   * Hosts that provide no setter only get the display refreshed.
   */
  async #mirrorSummarySetting() {
    if (!this.activated || !this.isSupported || this.#syncing) return;
    const wanted = this.#getSummarySetting();
    const setter = this.options.settings?.setCompactCards;
    if (wanted !== null && setter && this.#setting("compactCards") !== wanted) {
      this.#syncing = true;
      try {
        await setter(wanted);
      } catch (error) {
        this.#warn("CompactCards5e: could not change the host's compact cards setting", [error]);
      } finally {
        this.#syncing = false;
      }
    }
    this.applyCompactCards();
  }

  /**
   * Current value of the dnd5e "Summary Chat Cards" setting, or null when it is not registered
   * @returns {boolean|null}
   */
  #getSummarySetting() {
    try {
      return game.settings.get("dnd5e", DND5E_SUMMARY_SETTING) !== false;
    } catch (error) {
      return null;
    }
  }

  /**
   * Listens for client-scope changes of the dnd5e "Summary Chat Cards" setting
   * @param {string} key - Namespaced setting key
   */
  #onClientSettingChanged = (key) => {
    if (key !== `dnd5e.${DND5E_SUMMARY_SETTING}`) return;
    this.#mirrorSummarySetting();
  };

  /**
   * Listens for world-scope changes of the summary setting, should a system version store it per world
   * @param {Setting} setting - The updated Setting document
   */
  #onUpdateSetting = (setting) => {
    if (setting?.key !== `dnd5e.${DND5E_SUMMARY_SETTING}`) return;
    this.#mirrorSummarySetting();
  };

  /**
   * Re-renders the usage card a roll message is folded into when the message's rolls change. The
   * system only refreshes the origin on changes to a roll message's system data, so a roll changed
   * after the fact would otherwise keep showing its old total in the card.
   * @param {ChatMessage} message
   * @param {object} changed
   */
  #onUpdateChatMessage = (message, changed) => {
    if (!this.isActive || !("rolls" in (changed ?? {}))) return;
    const origin = message.system?.origin;
    if (!origin?.system?.rendersSummaries) return;
    for (const log of [ui.chat, ui.chat?.popout]) log?.updateMessage?.(origin);
  };

  /**
   * Applies the compact cards setting: body class and, unless skipped, a chat log re-render.
   * When called with a new value from the host's setting change, the dnd5e "Summary Chat Cards"
   * setting is first brought in line with it and the display is refreshed once that is done.
   * @param {boolean} [value] - New setting value, when called from a setting change
   * @param {boolean} [rerender=true]
   */
  applyCompactCards(value, rerender = true) {
    if (!this.activated) return;
    if (value !== undefined) {
      this.#syncSummarySetting(value);
      return;
    }
    document.body.classList.toggle(COMPACT_CARDS_BODY_CLASS, this.isActive);
    if (rerender) this.#rerenderChat();
  }

  /**
   * Applies the collapse tags setting, resetting any per-card expansion the user toggled
   * @param {boolean} [value] - New setting value, when called from a setting change
   */
  applyCollapseTags(value) {
    if (!this.activated) return;
    this.#tagStates.clear();
    this.#rerenderChat();
  }

  /**
   * Applies the retroactive advantage buttons setting by re-rendering the chat log
   * @param {boolean} [value] - New setting value, when called from a setting change
   */
  applyRetroAdvantage(value) {
    if (!this.activated) return;
    this.#rerenderChat();
  }

  /**
   * Applies the labeled buttons setting through a body class. Like the rest of the feature this
   * only acts on dnd5e 6.0+, where the cards it styles exist.
   * @param {boolean} [value] - New setting value, when called from a setting change
   */
  applyLabeledButtons(value) {
    if (!this.activated || !this.isSupported) return;
    const labeled = value !== undefined ? value : this.#setting("labeledButtons");
    document.body.classList.toggle(ICON_BUTTONS_BODY_CLASS, !labeled);
  }

  /**
   * Re-renders every message currently shown in the chat log and its popout, in place, so cards
   * pick up a changed setting. A full log render keeps its existing message list, so each rendered
   * message is updated individually; roll cards hidden behind a summary are still in the list and
   * come back when the setting is turned off.
   */
  #rerenderChat() {
    if (!this.isSupported) return;
    for (const log of [ui.chat, ui.chat?.popout]) {
      const element = log?.element;
      if (!element) continue;
      const items = element.querySelectorAll(".chat-log .message[data-message-id], #chat-log .message[data-message-id], ol.chat-log > li[data-message-id]");
      const ids = new Set(Array.from(items, li => li.dataset.messageId));
      for (const id of ids) {
        const message = game.messages.get(id);
        if (message) log.updateMessage(message);
      }
    }
  }

  /**
   * Checks whether dnd5e 6.0's card summary mechanism is available and no conflicting module is active
   * @returns {boolean}
   */
  #checkSupport() {
    const fail = (reason) => {
      this.unsupportedReason = reason;
      return false;
    };
    if (game.system?.id !== "dnd5e") return fail("system");
    if (foundry.utils.isNewerVersion("6.0.0", game.system.version)) return fail(`dnd5e ${game.system.version} < 6.0.0`);
    const models = CONFIG.ChatMessage?.dataModels ?? {};
    if (!models.usage?.prototype || !models.attack?.prototype || !models.damage?.prototype) return fail("message data models missing");
    if (!("rendersSummaries" in models.usage.prototype)) return fail("no card summary support");
    if (game.modules.get("midi-qol")?.active) return fail("midi-qol active");
    this.unsupportedReason = "";
    return true;
  }

  /**
   * Installs summaryTemplate getters on the attack and damage message data models.
   * The getters return the shared templates while compact cards are active and fall back to the
   * system's own value otherwise, so the setting can be toggled without a reload.
   */
  #patchSummaryTemplates() {
    if (this.#patched) return;
    const models = CONFIG.ChatMessage.dataModels;
    const instance = this;
    for (const [type, template] of Object.entries(this.#summaryTemplates)) {
      const proto = models[type]?.prototype;
      if (!proto) continue;
      const original = Object.getOwnPropertyDescriptor(proto, "summaryTemplate");
      Object.defineProperty(proto, "summaryTemplate", {
        configurable: true,
        get() {
          if (instance.isActive) return template;
          if (original?.get) return original.get.call(this);
          return this.metadata?.summaryTemplate ?? "";
        }
      });
    }
    this.#patched = true;
  }

  /**
   * Enriches usage cards after dnd5e has rendered them and their summaries
   * @param {ChatMessage} message
   * @param {HTMLElement} html - The chat message element
   */
  #onRenderChatMessage = (message, html) => {
    if (!this.isActive) return;
    const content = html?.querySelector?.(".message-content");
    if (!content) return;
    if (message.type !== "usage") {
      this.#enrichStandaloneRoll(message, content);
      return;
    }
    try {
      this.#enrichSummaries(message, content);
      this.#groupSaves(message, content);
      this.#buildTagRow(message, content);
      this.#buildTargetControls(message, content);
      this.#callHooks("renderCard", COMPACT_CARDS_HOOKS.RENDER_CARD, message, html);
    } catch (error) {
      this.#warn("CompactCards5e.#onRenderChatMessage", [error]);
    }
  };

  /**
   * Fires a shared hook and, when the host defined one, its alias
   * @param {"renderRoll"|"renderCard"} key
   * @param {string} hookName
   * @param {...any} args
   */
  #callHooks(key, hookName, ...args) {
    Hooks.callAll(hookName, ...args);
    const alias = this.options.hooks?.[key];
    if (alias && alias !== hookName) Hooks.callAll(alias, ...args);
  }

  /**
   * Fills the drawers of attack and damage summaries with roll details and wires their toggles
   * @param {ChatMessage} origin
   * @param {HTMLElement} content
   */
  #enrichSummaries(origin, content) {
    const summaries = content.querySelectorAll(".card-summary[data-message-id]");
    for (const summary of summaries) {
      const row = summary.querySelector(":scope > .dcc-roll-row");
      const drawer = summary.querySelector(":scope > .dcc-roll-drawer");
      const title = summary.querySelector(":scope > .dcc-row-title");
      if (!row || !drawer) continue;
      const rollMessage = game.messages.get(summary.dataset.messageId);
      if (!rollMessage) continue;
      if (row.dataset.rollType === "attack") {
        this.#fillAttackRow(origin, rollMessage, row, drawer);
      } else {
        this.#fillDamageRow(rollMessage, row, drawer, title);
      }
      this.#wireDrawer(origin, rollMessage, row, drawer);
      this.#callHooks("renderRoll", COMPACT_CARDS_HOOKS.RENDER_ROLL, { origin, rollMessage, summary, row, drawer });
    }
    for (const summary of summaries) {
      const rollMessage = game.messages.get(summary.dataset.messageId);
      if (rollMessage?.type === "check") this.#enrichSystemRollRows(rollMessage, summary);
    }
  }

  /**
   * Adds the advantage pill and buttons to the roll rows of a message the system rendered with its
   * own templates: a check summary inside a usage card, or a standalone check or save card. Each
   * roll row is an icon row holding the roll's total button; the pill goes on the first pill list
   * of the element, which names the target on summaries.
   * @param {ChatMessage} rollMessage
   * @param {HTMLElement} element - The summary or message content element
   */
  #enrichSystemRollRows(rollMessage, element) {
    if (!rollMessage.isContentVisible) return;
    const buttons = Array.from(element.querySelectorAll(".icon-row > button.dice-roll"));
    const pills = element.querySelector(".icon-row > ul.pills");
    for (const [index, button] of buttons.entries()) {
      if (button.closest(".dcc-roll-row, .dcc-save-list")) continue;
      this.#addAdvantage(rollMessage, index, button, index === 0 ? pills : null);
    }
  }

  /**
   * Adds the advantage buttons to a check or save message rendered as its own card, i.e. one not
   * folded into a usage card. Death saves are left alone.
   * @param {ChatMessage} message
   * @param {HTMLElement} content
   */
  #enrichStandaloneRoll(message, content) {
    if (message.type !== "check" && message.type !== "save") return;
    if (message.system?.type === "death") return;
    if (message.system?.origin?.system?.rendersSummaries) return;
    try {
      this.#enrichSystemRollRows(message, content);
    } catch (error) {
      this.#warn("CompactCards5e.#enrichStandaloneRoll", [error]);
    }
  }

  /**
   * Adds, for one d20 roll of a message, the pill naming its advantage mode and, for users who may
   * change it, the two buttons flanking its total button
   * @param {ChatMessage} rollMessage
   * @param {number} index - Index of the roll in the message's rolls
   * @param {HTMLElement|null} diceButton - The roll's total button
   * @param {HTMLElement|null} pills - Pill list the mode pill is appended to, if any
   */
  #addAdvantage(rollMessage, index, diceButton, pills) {
    const roll = rollMessage.rolls[index];
    if (!roll?.validD20Roll) return;
    if (pills) {
      const pill = this.#createAdvantagePill(rollMessage, roll);
      if (pill) pills.appendChild(pill);
    }
    if (!diceButton || !this.#canChangeAdvantage(rollMessage, roll)) return;
    const [up, down] = this.#createAdvantageControls(rollMessage, roll, index);
    diceButton.parentElement?.classList.add("dcc-with-advantage");
    diceButton.before(up);
    diceButton.after(down);
  }

  /**
   * Adds the attack mode pill and writes the d20 line into the drawer
   * @param {ChatMessage} origin
   * @param {ChatMessage} rollMessage
   * @param {HTMLElement} row
   * @param {HTMLElement} drawer
   */
  #fillAttackRow(origin, rollMessage, row, drawer) {
    const pills = row.querySelector(".dcc-row-pills");
    const modeLabel = this.#getAttackModeLabel(rollMessage);
    if (modeLabel && pills) {
      pills.appendChild(this.#createPill(modeLabel, "dcc-row-tag dcc-mode-tag"));
    }

    if (!rollMessage.isContentVisible) return;
    const index = rollMessage.rolls.findIndex(r => r?.validD20Roll);
    if (index >= 0) {
      this.#addAdvantage(rollMessage, index, row.querySelector(".dcc-row-total > button.dice-roll"), pills);
    }
    for (const roll of rollMessage.rolls) {
      const line = this.#buildD20Line(roll);
      if (line) drawer.prepend(line);
    }
  }

  /**
   * Pill naming the roll's advantage mode, marked when the mode was changed after the roll
   * @param {ChatMessage} rollMessage
   * @param {Roll} roll - The message's d20 roll
   * @returns {HTMLElement|null}
   */
  #createAdvantagePill(rollMessage, roll) {
    const ADV_MODE = CONFIG.Dice.D20Roll.ADV_MODE;
    const mode = roll.options?.advantageMode ?? ADV_MODE.NORMAL;
    const retro = rollMessage.getFlag(this.options.id, RETRO_FLAG);
    const changed = retro && retro.original !== mode;
    if (mode === ADV_MODE.NORMAL && !changed) return null;
    const label = mode === ADV_MODE.ADVANTAGE ? game.i18n.localize("DND5E.Advantage")
      : mode === ADV_MODE.DISADVANTAGE ? game.i18n.localize("DND5E.Disadvantage")
        : this.#localize("normalRoll");
    const pill = this.#createPill(label, "dcc-row-tag dcc-advantage-tag");
    if (changed) {
      pill.classList.add("changed");
      pill.setAttribute("aria-label", `${label}: ${this.#localize("retroChanged")}`);
      pill.setAttribute("data-tooltip", "");
      pill.insertAdjacentHTML("afterbegin", `<i class="fa-solid fa-clock-rotate-left" inert></i>`);
    }
    return pill;
  }

  /**
   * Whether the current user may change this roll's advantage mode after the fact: the message
   * must be theirs or they must be the GM, the d20 must be a plain die (one die, or the two or
   * three an advantage or disadvantage roll keeps one of) without explosions, and Ready Set Roll
   * must not be providing the same controls. Rerolls are fine: a die Halfling Lucky rerolled
   * away is set aside, and a Reliable Talent minimum only marks a result as rerolled.
   * @param {ChatMessage} rollMessage
   * @param {Roll} roll - The message's d20 roll
   * @returns {boolean}
   */
  #canChangeAdvantage(rollMessage, roll) {
    if (!this.#setting("retroAdvantage")) return false;
    if (game.modules.get(READY_SET_ROLL_ID)?.active) return false;
    if (!rollMessage.canUserModify?.(game.user, "update")) return false;
    if (!roll?._evaluated || !roll.validD20Roll) return false;
    const die = roll.d20;
    if (!die || die.faces !== 20 || die.number < 1 || die.number > 3) return false;
    return die.results.every(r => !r.exploded);
  }

  /**
   * Creates the two buttons that apply advantage (angles up) or disadvantage (angles down) to a
   * roll after it was made. The active mode's button is highlighted, and clicking it returns the
   * roll to normal. Both buttons are disabled while a change is in flight.
   * @param {ChatMessage} rollMessage
   * @param {Roll} roll - The d20 roll the buttons act on
   * @param {number} index - Index of that roll in the message's rolls
   * @returns {[HTMLButtonElement, HTMLButtonElement]} The advantage and disadvantage buttons
   */
  #createAdvantageControls(rollMessage, roll, index) {
    const ADV_MODE = CONFIG.Dice.D20Roll.ADV_MODE;
    const current = roll.options?.advantageMode ?? ADV_MODE.NORMAL;
    const entries = [
      { mode: ADV_MODE.ADVANTAGE, icon: "fa-angles-up", key: "retroAdvantage", side: "up" },
      { mode: ADV_MODE.DISADVANTAGE, icon: "fa-angles-down", key: "retroDisadvantage", side: "down" }
    ];
    const buttons = entries.map(({ mode, icon, key, side }) => {
      const active = current === mode;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `unbutton dcc-advantage-button dcc-advantage-${side}`;
      button.dataset.mode = String(mode);
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", this.#localize(active ? "retroNormal" : key));
      button.setAttribute("data-tooltip", "");
      button.innerHTML = `<i class="fa-solid ${icon}" inert></i>`;
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (buttons.some(b => b.disabled)) return;
        buttons.forEach(b => { b.disabled = true; });
        try {
          await this.setAdvantageMode(rollMessage, active ? ADV_MODE.NORMAL : mode, index);
        } catch (error) {
          this.#warn("CompactCards5e.setAdvantageMode", [error]);
          ui.notifications?.warn(this.#localize("retroFailed"));
        } finally {
          buttons.forEach(b => { b.disabled = false; });
        }
      });
      return button;
    });
    return /** @type {[HTMLButtonElement, HTMLButtonElement]} */ (buttons);
  }

  /**
   * Changes the advantage mode of an already rolled d20 roll and stores the result on its message.
   * Every d20 value ever rolled for the message is kept in a flag, so switching modes back and
   * forth reuses the same dice instead of rolling new ones; a die is only rolled when the pool
   * is short, and shown through Dice So Nice when present. The kept die is the highest for
   * advantage (of three with Elven Accuracy), the lowest for disadvantage, and the first rolled
   * for a normal roll. A die Halfling Lucky rerolled away stays in the results but out of the
   * pool, a fresh natural 1 is rerolled the same way when that reroll is still unused, and the
   * die's minimum and maximum modifiers are re-applied to every pooled die so Reliable Talent
   * survives the change. Hit or miss, critical and fumble follow from the new total when the
   * card re-renders.
   * @param {ChatMessage} rollMessage - An attack, check, save or other d20 roll message
   * @param {number} mode - One of `CONFIG.Dice.D20Roll.ADV_MODE`
   * @param {number} [rollIndex] - Index of the roll to change; defaults to the message's first d20 roll
   * @returns {Promise<ChatMessage|null>} The updated message, or null when nothing changed
   */
  async setAdvantageMode(rollMessage, mode, rollIndex) {
    const ADV_MODE = CONFIG.Dice.D20Roll.ADV_MODE;
    const index = rollIndex ?? rollMessage.rolls.findIndex(r => r?.validD20Roll);
    const roll = rollMessage.rolls[index];
    if (!roll || !this.#canChangeAdvantage(rollMessage, roll)) return null;
    const current = roll.options.advantageMode ?? ADV_MODE.NORMAL;
    if (current === mode) return null;
    const die = roll.d20;
    const flag = rollMessage.getFlag(this.options.id, RETRO_FLAG);
    const stored = flag && (flag.index ?? index) === index ? flag : {};
    const setAside = die.results.filter(r => this.#isRerolledAway(r));
    const rolled = die.results.filter(r => !this.#isRerolledAway(r)).map(r => r.result);
    const pool = [...rolled, ...(stored.pool ?? []).slice(rolled.length)];
    const elvenAccuracy = mode === ADV_MODE.ADVANTAGE && die.options.elvenAccuracy === true;
    const needed = mode === ADV_MODE.NORMAL ? 1 : (elvenAccuracy ? 3 : 2);
    while (pool.length < needed) {
      const result = await this.#rollExtraD20(rollMessage);
      if (result === 1 && !setAside.length && die.modifiers.includes("r1=1")) {
        setAside.push(this.#buildD20Result(die, result, { active: false, rerolled: true }));
        continue;
      }
      pool.push(result);
    }

    const values = pool.slice(0, needed);
    const kept = mode === ADV_MODE.NORMAL ? 0
      : values.indexOf(mode === ADV_MODE.ADVANTAGE ? Math.max(...values) : Math.min(...values));
    die.applyAdvantage(mode);
    die.results = [
      ...setAside,
      ...values.map((result, i) => this.#buildD20Result(die, result, i === kept
        ? { active: true }
        : { active: false, discarded: true }))
    ];
    roll.options.advantageMode = mode;
    roll.options.advantage = mode === ADV_MODE.ADVANTAGE;
    roll.options.disadvantage = mode === ADV_MODE.DISADVANTAGE;
    roll._total = roll._evaluateTotal();
    roll.resetFormula();

    const rolls = rollMessage.rolls.map((r, i) => (i === index ? roll : r).toJSON());
    return rollMessage.update({
      rolls,
      flavor: this.#replaceAdvantageFlavor(rollMessage.flavor, mode),
      [`flags.${this.options.id}.${RETRO_FLAG}`]: {
        original: stored.original ?? current,
        mode,
        pool,
        index
      }
    });
  }

  /**
   * Whether a die result was rerolled away, as by Halfling Lucky: core marks it rerolled and
   * inactive without discarding it, unlike a result a minimum or maximum only adjusted
   * @param {DiceTermResult} result
   * @returns {boolean}
   */
  #isRerolledAway(result) {
    return result.rerolled === true && !result.active && !result.discarded;
  }

  /**
   * Builds a d20 result entry from a pooled value, applying the die's `min` and `max` modifiers
   * the way core does so a Reliable Talent minimum counts toward the total
   * @param {DiceTerm} die
   * @param {number} result - The rolled value
   * @param {Partial<DiceTermResult>} state - The active, discarded and rerolled flags for the entry
   * @returns {DiceTermResult}
   */
  #buildD20Result(die, result, state) {
    const entry = { result, ...state };
    const min = this.#rangeModifier(die, "min");
    const max = this.#rangeModifier(die, "max");
    if (min !== null && result < min) Object.assign(entry, { count: min, rerolled: true });
    else if (max !== null && result > max) Object.assign(entry, { count: max, rerolled: true });
    return entry;
  }

  /**
   * Reads the value of a die's `min` or `max` modifier, if it has one
   * @param {DiceTerm} die
   * @param {"min"|"max"} kind
   * @returns {number|null}
   */
  #rangeModifier(die, kind) {
    const rgx = new RegExp(`^${kind}(\\d+)$`, "i");
    const match = die.modifiers.map(m => m.match(rgx)).find(m => m);
    return match ? parseInt(match[1]) : null;
  }

  /**
   * Rolls one extra d20 for a message, showing it through Dice So Nice when present
   * @param {ChatMessage} rollMessage
   * @returns {Promise<number>}
   */
  async #rollExtraD20(rollMessage) {
    const extra = await new Roll("1d20").evaluate();
    try {
      await game.dice3d?.showForRoll(extra, game.user, true, rollMessage.whisper, rollMessage.blind);
    } catch (error) {
      this.#log("CompactCards5e.#rollExtraD20 - dice3d", [error]);
    }
    return extra.total;
  }

  /**
   * Replaces the "(Advantage)" or "(Disadvantage)" suffix the system puts on a roll message's
   * flavor with the one for the new mode
   * @param {string} flavor
   * @param {number} mode
   * @returns {string}
   */
  #replaceAdvantageFlavor(flavor, mode) {
    const ADV_MODE = CONFIG.Dice.D20Roll.ADV_MODE;
    const labels = [game.i18n.localize("DND5E.Advantage"), game.i18n.localize("DND5E.Disadvantage")];
    let result = String(flavor ?? "");
    for (const label of labels) result = result.replace(` (${label})`, "");
    if (mode === ADV_MODE.ADVANTAGE) result += ` (${labels[0]})`;
    else if (mode === ADV_MODE.DISADVANTAGE) result += ` (${labels[1]})`;
    return result;
  }

  /**
   * Sets the healing label and icon, marks critical hits and writes one line per damage part into the drawer
   * @param {ChatMessage} rollMessage
   * @param {HTMLElement} row
   * @param {HTMLElement} drawer
   * @param {HTMLElement|null} title
   */
  #fillDamageRow(rollMessage, row, drawer, title) {
    if (rollMessage.system?.isHealing) {
      const label = title?.querySelector(".dcc-row-label");
      if (label) label.textContent = game.i18n.localize("DND5E.Healing");
      const icon = row.querySelector(".dcc-row-icon");
      if (icon) {
        const svg = document.createElement("dnd5e-icon");
        svg.setAttribute("src", HEALING_ICON);
        icon.replaceChildren(svg);
      }
    }
    if (rollMessage.rolls[0]?.isCritical) {
      row.classList.add("critical");
    }
    if (game.user.isGM) {
      row.querySelector(".dcc-row-main")?.appendChild(this.#createSelectTargetsButton(rollMessage));
    }

    if (!rollMessage.isContentVisible) return;
    const rolls = this.#aggregateDamage(rollMessage.rolls);
    for (const roll of rolls) {
      const line = this.#buildDamageLine(roll);
      if (line) drawer.appendChild(line);
    }
  }

  /**
   * Makes the button in the total column toggle the drawer, restoring its stored open state.
   * For roll rows that button is the system's dice-roll button, whose breakdown popover is
   * replaced by the drawer.
   * @param {ChatMessage} origin
   * @param {{ id: string }} rollMessage
   * @param {HTMLElement} row
   * @param {HTMLElement} drawer
   */
  #wireDrawer(origin, rollMessage, row, drawer) {
    const toggle = row.querySelector(".dcc-row-total button:not(.dcc-advantage-button)");
    if (!toggle) return;
    if (toggle.classList.contains("dice-roll")) {
      toggle.popoverTargetElement = null;
      row.querySelector(".dcc-row-total .roll-breakdown[popover]")?.remove();
    }
    if (!drawer.childElementCount || toggle.disabled) {
      toggle.classList.add("dcc-no-drawer");
      return;
    }
    const key = `${origin.id}:${rollMessage.id}`;
    const setOpen = (open) => {
      drawer.hidden = !open;
      row.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
    };
    setOpen(this.#drawerStates.get(key) ?? false);
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = drawer.hidden;
      this.#drawerStates.set(key, open);
      setOpen(open);
    });
  }

  /**
   * Builds the save section. For save activities every recorded target is listed, showing its
   * save summary when it has rolled and a placeholder otherwise, and the card's own targets row is
   * hidden. Other cards group the save summaries dnd5e rendered by ability. Counts and the DC are
   * only shown when the challenge is visible to this user.
   * @param {ChatMessage} origin
   * @param {HTMLElement} content
   */
  #groupSaves(origin, content) {
    const activity = origin.getAssociatedActivity?.();
    const isSaveActivity = activity?.type === "save";
    const entries = [];
    for (const summary of content.querySelectorAll(".card-summary[data-message-id]")) {
      const message = game.messages.get(summary.dataset.messageId);
      if (message?.type !== "save" || message.system?.type === "death") continue;
      entries.push({ summary, message });
    }
    if (!entries.length && !isSaveActivity) return;

    const groups = new Map();
    if (isSaveActivity) {
      groups.set(activity.save?.ability?.first?.() ?? "", entries);
    } else {
      for (const entry of entries) {
        const ability = entry.message.system?.ability ?? "";
        if (!groups.has(ability)) groups.set(ability, []);
        groups.get(ability).push(entry);
      }
    }

    const displayChallenge = origin.shouldDisplayChallenge ?? game.user.isGM;
    const insertBefore = entries[0]?.summary ?? content.querySelector(":scope > effect-application");
    for (const [ability, groupEntries] of groups) {
      const abilityLabel = CONFIG.DND5E.abilities?.[ability]?.label ?? "";
      const dc = groupEntries.map(e => e.message.rolls[0]?.options?.target).find(t => Number.isNumeric(t))
        ?? (isSaveActivity ? activity.save?.dc?.value : undefined);

      const row = document.createElement("section");
      row.className = "dcc-roll-row dcc-save-row";
      row.dataset.rollType = "save";
      row.innerHTML = `
        <span class="dcc-row-icon"><i class="fa-fw fa-solid fa-shield-heart" inert></i></span>
        <div class="dcc-row-main">
          <ul class="pills unlist dcc-row-pills"></ul>
        </div>
        <div class="dcc-row-total"></div>
      `;
      if (abilityLabel) {
        row.querySelector(".dcc-row-icon").setAttribute("aria-label", abilityLabel);
        row.querySelector(".dcc-row-icon").setAttribute("data-tooltip", "");
      }
      const pills = row.querySelector(".dcc-row-pills");
      if (displayChallenge) {
        if (groupEntries.length) {
          const successes = groupEntries.filter(e => e.message.rolls[0]?.isSuccess).length;
          pills.appendChild(this.#createCountPill(successes, "hit", "fa-check", "successes"));
          pills.appendChild(this.#createCountPill(groupEntries.length - successes, "miss", "fa-xmark", "failures"));
        }
        if (Number.isNumeric(dc)) {
          const dcLabel = game.i18n.has("DND5E.AbbreviationDC") ? game.i18n.localize("DND5E.AbbreviationDC") : "DC";
          const dcTag = document.createElement("span");
          dcTag.className = "dcc-dc";
          dcTag.textContent = `${dcLabel} ${dc}`;
          row.querySelector(".dcc-row-total").appendChild(dcTag);
        }
      } else if (groupEntries.length) {
        pills.appendChild(this.#createCountPill(groupEntries.length, "", "fa-bullseye", "targets"));
      }

      const list = document.createElement("section");
      list.className = "dcc-save-list";
      const wrapper = document.createElement("div");
      wrapper.className = "dcc-save-group";
      wrapper.append(row, list);
      if (insertBefore) insertBefore.before(wrapper);
      else content.appendChild(wrapper);
      this.#wireSaveToggle(origin, ability, row, wrapper);

      if (isSaveActivity) {
        this.#fillSaveTargets(origin, groupEntries, list);
      } else {
        for (const entry of groupEntries) list.appendChild(entry.summary);
      }
      for (const entry of groupEntries) {
        if (!entry.message.isContentVisible) continue;
        const index = entry.message.rolls.findIndex(r => r?.validD20Roll);
        if (index < 0) continue;
        const line = entry.summary.querySelector(".save-summary");
        this.#addAdvantage(entry.message, index, line?.querySelector(":scope > button.dice-roll"), line?.querySelector(":scope > ul.pills"));
      }
    }

    if (isSaveActivity) {
      content.querySelector("recorded-targets")?.classList.add("dcc-merged-targets");
    }
  }

  /**
   * Makes a save row collapse its list of saves. Clicking the row's icon or any empty area of the
   * row toggles the list; clicks on buttons, links and the DC are left alone. The state is kept
   * per card and ability so re-renders restore it. The chevron goes into the total column when
   * nothing else is shown there (no DC for this user), so it always sits at the right edge.
   * @param {ChatMessage} origin
   * @param {string} ability
   * @param {HTMLElement} row
   * @param {HTMLElement} wrapper - The group element holding the row and the list
   */
  #wireSaveToggle(origin, ability, row, wrapper) {
    const key = `${origin.id}:${ability}`;
    const toggle = document.createElement("span");
    toggle.className = "dcc-save-toggle";
    toggle.innerHTML = `<i class="fa-solid fa-chevron-up" inert></i>`;
    const total = row.querySelector(".dcc-row-total");
    const host = total && !total.childElementCount ? total : row.querySelector(".dcc-row-main");
    host?.appendChild(toggle);
    row.classList.add("dcc-collapsible");
    const setOpen = (open) => {
      wrapper.classList.toggle("collapsed", !open);
      row.setAttribute("aria-expanded", String(open));
    };
    setOpen(this.#saveStates.get(key) ?? true);
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, a, input, .dcc-dc")) return;
      event.preventDefault();
      event.stopPropagation();
      const open = wrapper.classList.contains("collapsed");
      this.#saveStates.set(key, open);
      setOpen(open);
    });
  }

  /**
   * Adds a targets row to the card face for the GM and the card's author: the buttons that record
   * the user's targeted or selected tokens on the card, followed by the recorded targets. It sits
   * between the tag row and the action buttons and replaces the system's own targets row, so it is
   * available on every activity card, not only on saves. Save activities list their targets in
   * the save section instead, so their row carries only the buttons.
   * @param {ChatMessage} origin
   * @param {HTMLElement} content
   */
  #buildTargetControls(origin, content) {
    if (!(game.user.isGM || origin.isAuthor)) return;
    const face = content.querySelector(".chat-card");
    if (!face || face.querySelector(":scope > .dcc-card-targets")) return;
    const activity = origin.getAssociatedActivity?.();
    const isSaveActivity = activity?.type === "save";

    const row = document.createElement("section");
    row.className = "icon-row dcc-card-targets";
    row.innerHTML = `<i class="fa-fw fa-solid fa-bullseye" aria-label="${game.i18n.localize("DND5E.CHATMESSAGE.Row.Targets")}"></i>`;
    const controls = document.createElement("span");
    controls.className = "dcc-target-controls";
    controls.append(
      this.#createRecordTargetsButton(origin, "targeted"),
      this.#createRecordTargetsButton(origin, "selected")
    );
    row.appendChild(controls);

    if (!isSaveActivity) {
      const targets = origin.system?.targets ?? [];
      const pills = document.createElement("ul");
      pills.className = "pills unlist targets dcc-card-target-pills";
      for (const target of targets) {
        const li = document.createElement("li");
        li.className = "pill target transparent";
        li.textContent = target.name ?? "";
        if (target.token) li.dataset.tokenUuid = target.token;
        pills.appendChild(li);
      }
      if (!targets.length) {
        const li = document.createElement("li");
        li.className = "none pill target transparent";
        li.textContent = game.i18n.localize("DND5E.Tokens.NoTargets");
        pills.appendChild(li);
      }
      row.appendChild(pills);
    }

    const recorded = face.querySelector(":scope > recorded-targets");
    recorded?.classList.add("dcc-merged-targets");
    const rows = Array.from(face.querySelectorAll(":scope > .icon-row"));
    const buttonsRow = rows.find(r => r.querySelector(":scope > ul.unlist:not(.pills)"));
    if (recorded) recorded.before(row);
    else if (buttonsRow) buttonsRow.before(row);
    else face.appendChild(row);
  }

  /**
   * Creates a button that adds the user's targeted or selected tokens to the card's recorded
   * targets, so the save section lists them and the save button rolls for them
   * @param {ChatMessage} origin
   * @param {"targeted"|"selected"} mode
   * @returns {HTMLButtonElement}
   */
  #createRecordTargetsButton(origin, mode) {
    const isTargeted = mode === "targeted";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `unbutton dcc-record-targets ${mode}`;
    button.setAttribute("aria-label", this.#localize(isTargeted ? "addTargeted" : "addSelected"));
    button.setAttribute("data-tooltip", "");
    button.innerHTML = `<i class="fa-solid ${isTargeted ? "fa-bullseye" : "fa-expand"}" inert></i>`;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const tokens = isTargeted ? Array.from(game.user.targets ?? []) : (canvas.tokens?.controlled ?? []);
      const added = CompactCards5e.getTargetDescriptors(tokens);
      if (!added.length) {
        ui.notifications?.warn(this.#localize(isTargeted ? "noTargeted" : "noSelected"));
        return;
      }
      const existing = (origin.system?.targets ?? []).map(t => foundry.utils.deepClone(t));
      const known = new Set(existing.map(t => t.token ?? t.actor));
      const merged = existing.concat(added.filter(t => !known.has(t.token ?? t.actor)));
      if (merged.length === existing.length) return;
      button.disabled = true;
      try {
        await origin.update({ "system.targets": merged });
      } catch (error) {
        this.#warn("CompactCards5e.#createRecordTargetsButton", [error]);
        button.disabled = false;
      }
    });
    return button;
  }

  /**
   * Creates the GM's button that selects, on the canvas, the tokens a damage or healing roll
   * recorded as its targets
   * @param {ChatMessage} rollMessage
   * @returns {HTMLButtonElement}
   */
  #createSelectTargetsButton(rollMessage) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "unbutton dcc-record-targets dcc-select-targets";
    button.setAttribute("aria-label", this.#localize("selectTargeted"));
    button.setAttribute("data-tooltip", "");
    button.innerHTML = `<i class="fa-solid fa-crosshairs" inert></i>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const tokens = (rollMessage.system?.targets ?? [])
        .map(descriptor => CompactCards5e.resolveTargetToken(descriptor))
        .filter(token => token?.control);
      if (!tokens.length) {
        ui.notifications?.warn(this.#localize("noRecordedTargets"));
        return;
      }
      tokens.forEach((token, i) => token.control({ releaseOthers: i === 0 }));
    });
    return button;
  }

  /**
   * Resolves a recorded target descriptor to a token on the viewed scene, if any
   * @param {object} descriptor
   * @returns {Token|null}
   */
  static resolveTargetToken(descriptor) {
    const TargetsField = dnd5e.dataModels?.chatMessage?.fields?.TargetsField;
    const resolved = TargetsField?.resolve?.(descriptor);
    if (resolved?.token) return resolved.token;
    const actorId = foundry.utils.parseUuid(descriptor?.actor ?? "")?.id;
    if (!actorId) return null;
    return canvas.tokens?.placeables.find(t => t.document.actor?.id === actorId || t.document.baseActor?.id === actorId) ?? null;
  }

  /**
   * Builds target descriptors for tokens the way the system does, using its field when available
   * @param {Token[]} tokens
   * @returns {object[]}
   */
  static getTargetDescriptors(tokens) {
    const TargetsField = dnd5e.dataModels?.chatMessage?.fields?.TargetsField;
    if (typeof TargetsField?.getDescriptors === "function") {
      return TargetsField.getDescriptors(tokens);
    }
    const targets = new Map();
    for (const target of tokens) {
      const token = target.document ?? target;
      const actor = token.actor;
      if (!actor) continue;
      const ac = actor.statuses?.has("coverTotal") ? null : actor.system?.attributes?.ac?.value;
      targets.set(token.uuid, {
        actor: actor.uuid,
        ac: ac ?? null,
        img: token.texture?.src,
        name: token.name,
        token: token.uuid
      });
    }
    return Array.from(targets.values());
  }

  /**
   * Lists every recorded target of a save activity card, with its save summary when it has rolled
   * and a placeholder line otherwise; saves from creatures that are not recorded targets follow
   * @param {ChatMessage} origin
   * @param {{ summary: HTMLElement, message: ChatMessage }[]} entries
   * @param {HTMLElement} list
   */
  #fillSaveTargets(origin, entries, list) {
    const remaining = new Set(entries);
    const targets = origin.system?.targets ?? [];
    for (const target of targets) {
      const matches = entries.filter(entry => {
        if (!remaining.has(entry)) return false;
        const token = entry.message.getAssociatedToken?.()?.uuid;
        const actor = entry.message.getAssociatedActor?.()?.uuid;
        return (target.token && token === target.token) || (target.actor && actor === target.actor);
      });
      if (matches.length) {
        for (const entry of matches) {
          remaining.delete(entry);
          list.appendChild(entry.summary);
        }
        continue;
      }
      const line = document.createElement("section");
      line.className = "icon-row save-summary dcc-pending-save";
      line.innerHTML = `
        <i class="fa-fw fa-solid fa-dice" aria-label="${game.i18n.localize("DND5E.CHATMESSAGE.Row.Roll")}"></i>
        <ul class="pills unlist"><li class="pill target transparent"></li></ul>
        <span class="dcc-pending-result" aria-label="${this.#localize("pendingSave")}" data-tooltip>&mdash;</span>
      `;
      line.querySelector("li.pill").textContent = target.name ?? "";
      if (target.token) line.dataset.tokenUuid = target.token;
      list.appendChild(line);
    }
    for (const entry of remaining) {
      list.appendChild(entry.summary);
    }
  }

  /**
   * Merges the usage card tags with the roll summaries' property tags into one deduplicated row,
   * sorted by priority, kept above the action buttons and collapsed behind a "+N" chip
   * @param {ChatMessage} origin
   * @param {HTMLElement} content
   */
  #buildTagRow(origin, content) {
    const face = content.querySelector(".chat-card");
    const rows = face ? Array.from(face.querySelectorAll(":scope > .icon-row")) : [];
    let tagRow = rows.find(r => r.querySelector(":scope > i.fa-tag") && r.querySelector(":scope > ul.pills"));

    const seen = new Set();
    const entries = [];
    const itemType = origin.getAssociatedItem?.()?.type ?? origin.system?.item?.type ?? "";
    const priorities = TAG_PRIORITY[itemType] ?? TAG_PRIORITY.default;
    const priorityOf = (typeKey) => {
      if (!typeKey) return DEFAULT_TAG_PRIORITY;
      if (typeKey in priorities) return priorities[typeKey];
      const base = typeKey.split(":")[0];
      return priorities[base] ?? DEFAULT_TAG_PRIORITY;
    };
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const repeatsExisting = (key) => [...seen].some(k => k && new RegExp(`(^|\\W)${escape(k)}(\\W|$)`).test(key));
    const addEntry = (label, typeKey) => {
      const key = label.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      if (typeKey === "roll" && repeatsExisting(key)) return;
      seen.add(key);
      entries.push({ label: label.trim(), priority: priorityOf(typeKey) });
    };

    for (const pill of content.querySelectorAll(".dcc-row-pills .label, .dcc-row-pills .content-link")) {
      seen.add(pill.textContent.trim().toLowerCase());
    }

    if (tagRow) {
      const pills = Array.from(tagRow.querySelectorAll(":scope > ul.pills > li.pill"));
      const types = this.#getPropertyTypes(origin, pills);
      pills.forEach((pill, index) => addEntry(pill.textContent.trim(), types[index]));
    }

    for (const list of content.querySelectorAll(".dcc-row-props")) {
      for (const item of list.querySelectorAll("li")) {
        addEntry(item.textContent, "roll");
      }
      list.remove();
    }

    if (!entries.length) {
      tagRow?.remove();
      return;
    }

    entries.sort((a, b) => a.priority - b.priority);

    if (!tagRow) {
      tagRow = document.createElement("section");
      tagRow.className = "icon-row";
      tagRow.innerHTML = `<i class="fa-fw fa-solid fa-tag" aria-label="${game.i18n.localize("DND5E.CHATMESSAGE.Row.Properties")}"></i><ul class="pills unlist"></ul>`;
    }
    const list = tagRow.querySelector(":scope > ul.pills");
    list.replaceChildren(...entries.map(e => this.#createPill(e.label)));
    list.classList.add("dcc-tags");

    if (!tagRow.isConnected && face) {
      const buttonsRow = rows.find(r => r.querySelector(":scope > ul.unlist:not(.pills)"));
      if (buttonsRow) buttonsRow.before(tagRow);
      else face.appendChild(tagRow);
    }

    if (this.#setting("collapseTags") && entries.length > VISIBLE_TAGS) {
      this.#wireTagToggle(origin, list, entries.length - VISIBLE_TAGS);
    }
  }

  /**
   * Adds the "+N" chip to a tag list and toggles the collapsed state on click
   * @param {ChatMessage} origin
   * @param {HTMLElement} list
   * @param {number} hiddenCount
   */
  #wireTagToggle(origin, list, hiddenCount) {
    const toggle = document.createElement("li");
    toggle.className = "pill transparent dcc-tags-toggle";
    toggle.setAttribute("role", "button");
    toggle.tabIndex = 0;
    const render = (expanded) => {
      list.classList.toggle("collapsed", !expanded);
      toggle.innerHTML = expanded
        ? `<i class="fa-solid fa-chevron-up" inert></i>`
        : `<span class="label">+${hiddenCount}</span>`;
      toggle.setAttribute("aria-label", this.#localize(expanded ? "showFewerTags" : "showAllTags"));
      toggle.setAttribute("aria-expanded", String(expanded));
    };
    render(this.#tagStates.get(origin.id) ?? false);
    const onToggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const expanded = list.classList.contains("collapsed");
      this.#tagStates.set(origin.id, expanded);
      render(expanded);
    };
    toggle.addEventListener("click", onToggle);
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") onToggle(event);
    });
    list.appendChild(toggle);
  }

  /**
   * Resolves the property type key of each tag pill on a usage card. The system renders the card's
   * typed properties in order but drops the ones without a label, so each property's label is
   * recomputed through the system's property field and the pills are matched to them in sequence.
   * Pills that match no property, such as ones added at render time, get no type.
   * @param {ChatMessage} origin
   * @param {HTMLElement[]} pills
   * @returns {(string|null)[]}
   */
  #getPropertyTypes(origin, pills) {
    const types = pills.map(() => null);
    try {
      const system = origin.system;
      const showIdentity = system?.showIdentity ?? true;
      const props = (system?.properties ?? []).filter(p => p && (showIdentity || !p.identity));
      if (!props.length) return types;
      const keyOf = (prop) => prop.type === "property" && prop.property ? `property:${prop.property}` : prop.type;
      const PropertyField = dnd5e.dataModels?.shared?.PropertyField ?? dnd5e.dataModels?.fields?.PropertyField;
      if (!PropertyField?.getLabels) {
        return props.length === pills.length ? props.map(keyOf) : types;
      }
      const options = { ...system, properties: system.item?.properties };
      const labeled = props.map(prop => {
        try {
          const [label] = PropertyField.getLabels([prop], options);
          return { key: keyOf(prop), label: String(label ?? "").trim().toLowerCase() };
        } catch (error) {
          this.#log("CompactCards5e.#getPropertyTypes", [prop.type, error]);
          return { key: keyOf(prop), label: "" };
        }
      }).filter(entry => entry.label);
      let cursor = 0;
      return pills.map(pill => {
        const text = pill.textContent.trim().toLowerCase();
        const index = labeled.findIndex((entry, i) => i >= cursor && entry.label === text);
        if (index === -1) return null;
        cursor = index + 1;
        return labeled[index].key;
      });
    } catch (error) {
      this.#log("CompactCards5e.#getPropertyTypes", [error]);
      return types;
    }
  }

  /**
   * Localized label of the attack mode used by an attack roll message, if any
   * @param {ChatMessage} rollMessage
   * @returns {string}
   */
  #getAttackModeLabel(rollMessage) {
    const mode = rollMessage.system?.mode;
    if (!mode) return "";
    const key = `DND5E.ATTACK.Mode.${mode.split("-").map(s => s.capitalize()).join("")}`;
    return game.i18n.has(key) ? game.i18n.localize(key) : "";
  }

  /**
   * Aggregates damage rolls by type the same way the system does for its breakdown
   * @param {Roll[]} rolls
   * @returns {Roll[]}
   */
  #aggregateDamage(rolls) {
    const damageRolls = rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll);
    if (!damageRolls.length) return rolls;
    const aggregate = dnd5e.dice?.aggregateDamageRolls;
    if (!CONFIG.DND5E.aggregateDamageDisplay || typeof aggregate !== "function") return damageRolls;
    try {
      return aggregate(damageRolls);
    } catch (error) {
      return damageRolls;
    }
  }

  /**
   * Builds the "17 + 5 (1d20 + 3 + 2)" line for a d20 roll, striking dropped dice
   * @param {Roll} roll
   * @returns {HTMLElement|null}
   */
  #buildD20Line(roll) {
    if (!roll?._evaluated || !roll.validD20Roll) return null;
    const die = roll.d20;
    const modifier = roll.total - die.total;
    const dice = die.results.map(r => r.active === false || r.discarded
      ? `<s>${r.result}</s>`
      : `<span class="dcc-die">${r.result}</span>`).join(" ");
    return this.#createLine(`${dice}${this.#formatModifier(modifier)}`, this.#cleanFormula(roll.formula));
  }

  /**
   * Builds the "6 + 5 piercing (1d8 + 5)" line for one aggregated damage roll, listing every die
   * result the way the system's breakdown popover did
   * @param {Roll} roll
   * @returns {HTMLElement|null}
   */
  #buildDamageLine(roll) {
    if (!roll?._evaluated) return null;
    const results = roll.dice.flatMap(die => die.results ?? []);
    const diceTotal = roll.dice.reduce((total, die) => total + (die.total ?? 0), 0);
    const modifier = roll.total - diceTotal;
    const dice = results.length
      ? results.map(r => r.active === false || r.discarded
        ? `<s>${r.result}</s>`
        : `<span class="dcc-die">${r.result}</span>`).join(" + ")
      : `${diceTotal}`;
    const type = roll.options?.type;
    const typeLabel = CONFIG.DND5E.damageTypes?.[type]?.label ?? CONFIG.DND5E.healingTypes?.[type]?.label ?? "";
    const formula = this.#cleanFormula(roll.formula);
    const detail = typeLabel ? `${typeLabel} (${formula})` : formula;
    return this.#createLine(`${dice}${this.#formatModifier(modifier)}`, detail);
  }

  /**
   * Strips the leading plus the system leaves on aggregated damage formulas
   * @param {string} formula
   * @returns {string}
   */
  #cleanFormula(formula) {
    return String(formula ?? "").replace(/^\s*\+\s*/, "").trim();
  }

  /**
   * Formats a modifier as " + N" or " − N", or an empty string for zero
   * @param {number} modifier
   * @returns {string}
   */
  #formatModifier(modifier) {
    if (!modifier) return "";
    return modifier > 0 ? ` + ${modifier}` : ` − ${Math.abs(modifier)}`;
  }

  /**
   * Creates a drawer line with a bold result on the left and a muted detail on the right
   * @param {string} resultHtml
   * @param {string} detail
   * @returns {HTMLElement}
   */
  #createLine(resultHtml, detail) {
    const line = document.createElement("div");
    line.className = "dcc-drawer-line";
    const result = document.createElement("strong");
    result.innerHTML = resultHtml;
    const formula = document.createElement("span");
    formula.className = "dcc-formula";
    formula.textContent = detail;
    line.append(result, formula);
    return line;
  }

  /**
   * Creates a transparent pill with a text label
   * @param {string} label
   * @param {string} [extraClass]
   * @returns {HTMLElement}
   */
  #createPill(label, extraClass = "") {
    const li = document.createElement("li");
    li.className = `pill transparent ${extraClass}`.trim();
    const span = document.createElement("span");
    span.className = "label";
    span.textContent = label;
    li.appendChild(span);
    return li;
  }

  /**
   * Creates a count pill such as "✓ 4" with a localized accessible name
   * @param {number} count
   * @param {string} state - "hit", "miss" or empty
   * @param {string} icon - Font Awesome icon class
   * @param {string} labelKey - Key under the host's i18n prefix used for the aria label
   * @returns {HTMLElement}
   */
  #createCountPill(count, state, icon, labelKey) {
    const li = document.createElement("li");
    li.className = `pill transparent dcc-count-pill ${state}`.trim();
    li.setAttribute("aria-label", `${count} ${this.#localize(labelKey)}`);
    li.setAttribute("data-tooltip", "");
    li.innerHTML = `<i class="fa-solid ${icon}" inert></i><span class="label">${count}</span>`;
    return li;
  }

  /**
   * Reads one of the host's settings, defaulting to true when the getter is missing or throws
   * @param {keyof CompactCardsSettings} key
   * @returns {boolean}
   */
  #setting(key) {
    try {
      const value = this.options.settings?.[key]?.();
      return value ?? true;
    } catch (error) {
      return true;
    }
  }

  /**
   * Localizes a key under the host's i18n prefix
   * @param {string} key
   * @returns {string}
   */
  #localize(key) {
    return game.i18n.localize(`${this.options.i18nPrefix}.${key}`);
  }

  /**
   * Debug log through the host's logger when it provided one
   * @param {string} ref
   * @param {any[]} [data]
   */
  #log(ref, data = []) {
    this.options.log?.(ref, data);
  }

  /**
   * Warning through the host's logger, falling back to the console
   * @param {string} ref
   * @param {any[]} [data]
   */
  #warn(ref, data = []) {
    if (this.options.warn) this.options.warn(ref, data);
    else console.warn(`${this.options.id} | ${ref}`, ...data);
  }
}
