/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mizu link hints.
 *
 * Ctrl+G labels every clickable element in the tab; typing a label activates
 * it. Ctrl+Shift+G does the same but opens links in a background tab.
 *
 * The session lives here rather than in the content actors because a tab is
 * many documents. Labels have to be unique across all of them, so one place
 * has to hand them out, and only the chrome process can see every frame.
 */
var MizuLinkHints = {
  PREF_BRANCH: "mizu.hints.",

  _initialized: false,
  _active: false,
  _newTab: false,
  _typed: "",
  _hints: [],
  _actors: new Set(),
  _browser: null,
  _generation: 0,

  get enabled() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}enabled`, true);
  },

  get characters() {
    let value = Services.prefs.getStringPref(
      `${this.PREF_BRANCH}characters`,
      "sadfjklewcmpgh"
    );
    // A one-character alphabet cannot label two elements, and a duplicate
    // character would produce two hints answering to the same keystroke.
    let unique = [...new Set(value.toUpperCase())].filter(char =>
      /[A-Z0-9]/.test(char)
    );
    return unique.length > 1 ? unique : [..."SADFJKLEWCMPGH"];
  },

  get detectListeners() {
    return Services.prefs.getBoolPref(
      `${this.PREF_BRANCH}detect-listeners`,
      true
    );
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    window.addEventListener("keydown", this, true);
    window.addEventListener("unload", this, { once: true });
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    gBrowser.addTabsProgressListener(this);
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    this.stop();
    window.removeEventListener("keydown", this, true);
    gBrowser.tabContainer.removeEventListener("TabSelect", this);
    gBrowser.removeTabsProgressListener(this);
  },

  handleEvent(event) {
    switch (event.type) {
      case "unload":
        this.uninit();
        break;
      case "TabSelect":
        this.stop();
        break;
      case "keydown":
        this._onKeyDown(event);
        break;
    }
  },

  onLocationChange(browser, webProgress) {
    if (webProgress?.isTopLevel && browser == this._browser) {
      this.stop();
    }
  },

  get _keyCode() {
    return Services.prefs.getStringPref(`${this.PREF_BRANCH}key-code`, "KeyG");
  },

  _onKeyDown(event) {
    let shortcut =
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      event.code == this._keyCode;

    if (this._active) {
      this._onSessionKey(event, shortcut);
      return;
    }

    if (!this.enabled || !shortcut) {
      return;
    }

    // Capture phase, so this wins over the XUL <key> that Ctrl+G is bound to
    // by default. Find-again still answers to F3.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.start(event.shiftKey);
  },

  /**
   * Handles a keystroke typed while labels are on screen.
   *
   * The whole session is driven from the chrome process. Key events reach the
   * browser window before they are forwarded into content, so listening here
   * catches them wherever focus happens to be, including inside an iframe, and
   * preventing the default keeps the page from ever seeing letters that were
   * meant for Mizu.
   *
   * @param {KeyboardEvent} event The keystroke.
   * @param {boolean} shortcut Whether it is the hint shortcut itself.
   */
  _onSessionKey(event, shortcut) {
    if (shortcut) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.stop();
      return;
    }

    // A modifier on its own is the user reaching for shift, not a label.
    if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) {
      return;
    }

    // Anything with a modifier is a browser shortcut the user still wants, so
    // step out of the way rather than swallowing it.
    if (event.ctrlKey || event.altKey || event.metaKey) {
      this.stop();
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    this._onTyped(event.key, event.shiftKey);
  },

  /**
   * Starts a hint session in the current tab.
   *
   * @param {boolean} newTab Whether links should open in a background tab.
   */
  async start(newTab = false) {
    this.stop();

    let generation = ++this._generation;
    let browser = gBrowser.selectedBrowser;
    let detectListeners = this.detectListeners;
    let collected = [];
    let actors = new Set();

    for (let context of this._contexts(browser.browsingContext)) {
      let actor;
      try {
        actor = context.currentWindowGlobal?.getActor("MizuHints");
      } catch (_) {
        continue;
      }
      if (!actor) {
        continue;
      }
      try {
        let frame = await actor.sendQuery("MizuHints:Collect", {
          detectListeners,
        });
        // A tab switch or a navigation during the round trip means these
        // measurements describe a page the user is no longer looking at.
        if (generation != this._generation) {
          return;
        }
        for (let candidate of frame.candidates) {
          collected.push({
            actor,
            index: candidate.index,
            y: frame.offsetY + candidate.top,
            x: frame.offsetX + candidate.left,
          });
        }
        if (frame.candidates.length) {
          actors.add(actor);
        }
      } catch (_) {}
    }

    if (!collected.length) {
      return;
    }

    // Screen coordinates put an iframe's controls in the same order the user
    // sees them, rather than after everything in the page that embeds them.
    collected.sort((a, b) => a.y - b.y || a.x - b.x);

    let labels = this._labels(collected.length);
    this._hints = collected.map((entry, position) => ({
      ...entry,
      label: labels[position],
    }));
    this._active = true;
    this._newTab = newTab;
    this._typed = "";
    this._actors = actors;
    this._browser = browser;

    for (let actor of actors) {
      let mine = this._hints
        .filter(hint => hint.actor == actor)
        .map(hint => ({ index: hint.index, label: hint.label }));
      try {
        actor.sendAsyncMessage("MizuHints:Show", { labels: mine });
      } catch (_) {}
    }

    // Without focus in content, the letters the user types next would go to
    // the chrome element that happens to hold focus instead.
    browser.focus();
  },

  stop() {
    if (!this._active) {
      this._generation++;
      return;
    }
    this._active = false;
    this._generation++;
    for (let actor of this._actors) {
      try {
        actor.sendAsyncMessage("MizuHints:Cancel", {});
      } catch (_) {}
    }
    this._actors = new Set();
    this._hints = [];
    this._typed = "";
    this._browser = null;
  },

  /**
   * Advances the session by one typed character.
   *
   * @param {string} key The KeyboardEvent key value.
   * @param {boolean} shiftKey Whether shift was held.
   */
  _onTyped(key, shiftKey) {
    if (key == "Escape") {
      this.stop();
      return;
    }

    if (key == "Backspace") {
      if (!this._typed) {
        this.stop();
        return;
      }
      this._typed = this._typed.slice(0, -1);
      this._update();
      return;
    }

    if (key.length != 1) {
      return;
    }

    let typed = this._typed + key.toUpperCase();
    let matches = this._hints.filter(hint => hint.label.startsWith(typed));
    if (!matches.length) {
      // Swallow the miss rather than dropping the session: a typo should not
      // cost the user the labels they had already narrowed down.
      return;
    }

    this._typed = typed;
    if (matches.length == 1) {
      this._activate(matches[0], shiftKey);
      return;
    }
    this._update();
  },

  onDismiss(browser) {
    if (browser == this._browser) {
      this.stop();
    }
  },

  _update() {
    let matches = this._hints.filter(hint =>
      hint.label.startsWith(this._typed)
    );
    let live = new Set(matches.map(hint => hint.label));
    for (let actor of this._actors) {
      try {
        actor.sendAsyncMessage("MizuHints:Filter", {
          typed: this._typed,
          matches: [...live],
        });
      } catch (_) {}
    }
  },

  _activate(hint, shiftKey) {
    let { actor, index } = hint;
    let newTab = this._newTab || shiftKey;
    // Activate before stopping. Messages arrive in the order they were sent,
    // so the Cancel that stop() broadcasts would otherwise clear the frame's
    // candidate list before it had a chance to look this index up in it.
    try {
      actor.sendAsyncMessage("MizuHints:Activate", { index, newTab });
    } catch (_) {}
    this.stop();
  },

  /**
   * Builds a prefix-free set of labels, shortest first.
   *
   * Prefix freedom is what lets a hint fire the moment its label is the only
   * one still matching, instead of waiting for a fixed number of keystrokes.
   *
   * @param {number} count How many labels are needed.
   * @returns {string[]} The labels, sorted so the shortest go to the top of
   *   the page.
   */
  _labels(count) {
    let chars = this.characters;
    let labels = [""];
    let offset = 0;

    while (labels.length - offset < count || labels.length == 1) {
      let head = labels[offset++];
      for (let char of chars) {
        labels.push(char + head);
      }
    }

    return labels
      .slice(offset, offset + count)
      .map(label => [...label].reverse().join(""))
      .sort();
  },

  _contexts(root) {
    let contexts = [];
    let pending = [root];
    while (pending.length) {
      let context = pending.shift();
      contexts.push(context);
      pending.push(...context.children);
    }
    return contexts;
  },
};

// gBrowser does not exist at DOMContentLoaded, and init() touches it.
Services.obs.addObserver(function onDelayedStartup(subject) {
  if (subject !== window) {
    return;
  }
  Services.obs.removeObserver(
    onDelayedStartup,
    "browser-delayed-startup-finished"
  );
  MizuLinkHints.init();
}, "browser-delayed-startup-finished");
