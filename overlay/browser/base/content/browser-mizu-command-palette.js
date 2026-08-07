/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

var MizuCommandPaletteLazy = {};
ChromeUtils.defineESModuleGetters(MizuCommandPaletteLazy, {
  MizuTabSync: "resource:///modules/MizuTabSync.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

var MizuCommandPalette = {
  PREF_BRANCH: "mizu.palette.",
  HTML_NS: "http://www.w3.org/1999/xhtml",

  _initialized: false,
  _dialog: null,
  _input: null,
  _list: null,
  _status: null,
  _results: [],
  _selectedIndex: 0,
  _searchGeneration: 0,
  _autoOpenedTabs: new WeakSet(),

  get enabled() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}enabled`, true);
  },

  get maxResults() {
    return Services.prefs.getIntPref(`${this.PREF_BRANCH}max-results`, 14);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._build();
    window.addEventListener("keydown", this, true);
    window.addEventListener("unload", this, { once: true });
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    gBrowser.addTabsProgressListener(this);
    this._maybeOpenForTab(gBrowser.selectedTab);
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    window.removeEventListener("keydown", this, true);
    gBrowser.tabContainer.removeEventListener("TabSelect", this);
    gBrowser.removeTabsProgressListener(this);
    this._dialog?.remove();
    this._dialog = null;
  },

  handleEvent(event) {
    if (event.type == "unload") {
      this.uninit();
      return;
    }
    if (event.type == "TabSelect") {
      this._maybeOpenForTab(event.target);
      return;
    }
    if (
      event.type == "keydown" &&
      event.code == "Space" &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggle();
    }
  },

  onLocationChange(browser, webProgress, request, locationURI) {
    if (!webProgress?.isTopLevel) {
      return;
    }
    this._maybeOpenForTab(gBrowser.getTabForBrowser(browser), locationURI);
  },

  _maybeOpenForTab(tab, locationURI = null) {
    if (!tab) {
      return;
    }
    let isNewTab =
      (locationURI ?? tab.linkedBrowser.currentURI)?.spec == "about:newtab";
    if (!isNewTab) {
      this._autoOpenedTabs.delete(tab);
      return;
    }
    if (
      tab != gBrowser.selectedTab ||
      this._autoOpenedTabs.has(tab) ||
      !Services.prefs.getBoolPref(`${this.PREF_BRANCH}open-on-new-tab`, true)
    ) {
      return;
    }
    this._autoOpenedTabs.add(tab);
    this.open();
  },

  _element(name, className = "") {
    let element = document.createElementNS(this.HTML_NS, name);
    if (className) {
      element.className = className;
    }
    return element;
  },

  _build() {
    let dialog = this._element("dialog", "mizu-command-palette");
    dialog.id = "mizu-command-palette";
    dialog.setAttribute("aria-label", "Mizu command palette");

    let frame = this._element("div", "mizu-command-palette-frame");
    let search = this._element("div", "mizu-command-palette-search");
    let icon = this._element("span", "mizu-command-palette-search-icon");
    icon.setAttribute("aria-hidden", "true");
    let input = this._element("input", "mizu-command-palette-input");
    input.type = "text";
    input.placeholder = "Search tabs, history, bookmarks, and commands";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", "mizu-command-palette-results");
    input.setAttribute("aria-expanded", "true");
    let shortcut = this._element("kbd", "mizu-command-palette-shortcut");
    shortcut.textContent = "Esc";
    search.append(icon, input, shortcut);

    let hints = this._element("div", "mizu-command-palette-hints");
    for (let [prefix, label] of [
      [">", "Commands"],
      ["@", "Open tabs"],
      ["^", "History"],
    ]) {
      let hint = this._element("button", "mizu-command-palette-hint");
      hint.type = "button";
      hint.dataset.prefix = prefix;
      let key = this._element("kbd");
      key.textContent = prefix;
      hint.append(key, ` ${label}`);
      hint.addEventListener("click", () => {
        input.value = `${prefix} `;
        input.focus();
        this._refresh();
      });
      hints.append(hint);
    }

    let list = this._element("div", "mizu-command-palette-results");
    list.id = "mizu-command-palette-results";
    list.setAttribute("role", "listbox");
    let footer = this._element("div", "mizu-command-palette-footer");
    let status = this._element("span", "mizu-command-palette-status");
    let keys = this._element("span", "mizu-command-palette-keys");
    keys.innerHTML =
      "<kbd>\u2191</kbd><kbd>\u2193</kbd> navigate <kbd>Enter</kbd> open";
    footer.append(status, keys);
    frame.append(search, hints, list, footer);
    dialog.append(frame);
    document.body.append(dialog);

    input.addEventListener("input", () => this._refresh());
    input.addEventListener("keydown", event => this._onInputKeyDown(event));
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      this.close();
    });
    dialog.addEventListener("click", event => {
      if (event.target == dialog) {
        this.close();
      }
    });
    dialog.addEventListener("close", () => {
      input.value = "";
      this._results = [];
      this._list.replaceChildren();
      document.documentElement.removeAttribute("mizu-command-palette-open");
    });

    this._dialog = dialog;
    this._input = input;
    this._list = list;
    this._status = status;
  },

  toggle() {
    if (this._dialog.open) {
      this.close();
    } else {
      this.open();
    }
  },

  open(initialValue = "") {
    if (!this.enabled || this._dialog.open) {
      return;
    }
    this._input.value = initialValue;
    document.documentElement.setAttribute("mizu-command-palette-open", "true");
    this._dialog.showModal();
    this._input.focus();
    this._refresh();
  },

  close() {
    if (this._dialog.open) {
      this._dialog.close();
    }
  },

  _onInputKeyDown(event) {
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        this._select(this._selectedIndex + 1);
        break;
      case "ArrowUp":
        this._select(this._selectedIndex - 1);
        break;
      case "Home":
        this._select(0);
        break;
      case "End":
        this._select(this._results.length - 1);
        break;
      case "PageDown":
        this._select(this._selectedIndex + 5);
        break;
      case "PageUp":
        this._select(this._selectedIndex - 5);
        break;
      case "Enter":
        this._activateSelected(event);
        break;
      case "Escape":
        this.close();
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  },

  _query() {
    let raw = this._input.value.trimStart();
    let mode = "all";
    if (raw.startsWith(">")) {
      mode = "commands";
      raw = raw.slice(1).trimStart();
    } else if (raw.startsWith("@")) {
      mode = "tabs";
      raw = raw.slice(1).trimStart();
    } else if (raw.startsWith("^")) {
      mode = "history";
      raw = raw.slice(1).trimStart();
    }
    return { mode, text: raw.trim() };
  },

  async _refresh() {
    let generation = ++this._searchGeneration;
    let { mode, text } = this._query();
    let results = [];
    if (mode == "tabs") {
      results = this._tabResults(text);
    } else if (mode == "commands") {
      results = this._commandResults(text);
    } else if (mode == "history") {
      results = await this._placeResults(text);
    } else {
      let tabLimit = text ? 5 : 7;
      let commandLimit = text ? 4 : 7;
      results.push(...this._tabResults(text).slice(0, tabLimit));
      results.push(...this._commandResults(text).slice(0, commandLimit));
      if (text.length >= 2) {
        results.push(...(await this._placeResults(text)).slice(0, 4));
      }
      if (text) {
        results.push(this._searchResult(text));
      }
    }
    if (generation != this._searchGeneration || !this._dialog.open) {
      return;
    }
    this._results = results.slice(0, this.maxResults);
    this._selectedIndex = 0;
    this._render();
  },

  _matches(text, ...values) {
    if (!text) {
      return true;
    }
    let terms = text.toLocaleLowerCase().split(/\s+/);
    let haystack = values.join(" ").toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  },

  _tabResults(text) {
    let results = [];
    for (let browserWindow of Services.wm.getEnumerator("navigator:browser")) {
      if (browserWindow.closed || !browserWindow.gBrowser) {
        continue;
      }
      for (let tab of browserWindow.gBrowser.tabs) {
        let url = tab.linkedBrowser.currentURI?.displaySpec ?? "";
        let title = tab.label || url || "New Tab";
        if (!this._matches(text, title, url)) {
          continue;
        }
        results.push({
          kind: "tab",
          label: title,
          detail: url,
          badge: browserWindow == window ? "Open tab" : "Other window",
          icon: tab.getAttribute("image") || `page-icon:${url}`,
          lastAccessed: tab.lastAccessed || 0,
          run: () => {
            browserWindow.gBrowser.selectedTab = tab;
            browserWindow.focus();
          },
        });
      }
    }
    // Tabs from a paired phone are not a separate source: tab sync puts them in
    // the tab strip, so the windows walked above already have them.
    return results.sort((a, b) => b.lastAccessed - a.lastAccessed);
  },

  _commands() {
    let tab = gBrowser.selectedTab;
    return [
      {
        label: "New tab",
        detail: "Open a blank tab",
        keywords: "create page",
        run: () => BrowserCommands.openTab(),
      },
      {
        label: "New window",
        detail: "Open another Mizu window",
        keywords: "create browser",
        run: () => OpenBrowserWindow(),
      },
      {
        label: "New private window",
        detail: "Open a private browsing window",
        keywords: "incognito privacy",
        run: () => OpenBrowserWindow({ private: true }),
      },
      {
        label: "Reopen closed tab",
        detail: "Restore the most recently closed tab",
        keywords: "undo restore history",
        run: () => SessionWindowUI.undoCloseTab(window),
      },
      {
        label: "Duplicate current tab",
        detail: "Make a copy beside this tab",
        keywords: "clone copy",
        run: () => duplicateTabIn(gBrowser.selectedTab, "tab"),
      },
      {
        label: tab.pinned ? "Unpin current tab" : "Pin current tab",
        detail: tab.pinned
          ? "Return this tab to the tab list"
          : "Keep this tab available",
        keywords: "fixed favorite",
        run: () => (tab.pinned ? gBrowser.unpinTab(tab) : gBrowser.pinTab(tab)),
      },
      {
        label: tab.muted ? "Unmute current tab" : "Mute current tab",
        detail: tab.muted
          ? "Allow this tab to play audio"
          : "Silence audio from this tab",
        keywords: "audio sound volume",
        run: () => tab.toggleMuteAudio(),
      },
      {
        label: "Bookmark current page",
        detail: "Save this page to bookmarks",
        keywords: "favorite star save",
        run: () => PlacesCommandHook.bookmarkPage(),
      },
      {
        label: "Manage bookmarks",
        detail: "Open the bookmarks library",
        keywords: "library favorites saved",
        run: () => PlacesCommandHook.showPlacesOrganizer("AllBookmarks"),
      },
      {
        label: "Browse history",
        detail: "Open the browsing history library",
        keywords: "visited pages library",
        run: () => PlacesCommandHook.showPlacesOrganizer("History"),
      },
      {
        label: "Show downloads",
        detail: "Open the downloads library",
        keywords: "files downloaded library",
        run: () => PlacesCommandHook.showPlacesOrganizer("Downloads"),
      },
      {
        label: "Open settings",
        detail: "Configure Mizu",
        keywords: "preferences options configuration",
        run: () => openPreferences(),
      },
      {
        label: MizuCommandPaletteLazy.MizuTabSync.enabled
          ? "Show the tab sync pairing code"
          : "Pair a phone for tab sync",
        detail: MizuCommandPaletteLazy.MizuTabSync.enabled
          ? "Scan this desktop's code from the Mizu mobile browser"
          : "Keep one set of tabs across devices on this network",
        keywords: "mobile phone lan local network pair token qr code scan",
        run: () => MizuTabSyncPairing.open(),
      },
      {
        label: "Disable tab sync",
        detail: "Stop accepting tab sync connections",
        keywords: "mobile phone lan local network stop",
        hidden: !MizuCommandPaletteLazy.MizuTabSync.enabled,
        run: () => Services.prefs.setBoolPref("mizu.tabsync.enabled", false),
      },
      {
        label: "Toggle fullscreen",
        detail: "Enter or leave fullscreen",
        keywords: "full screen presentation",
        run: () => document.getElementById("View:FullScreen")?.doCommand(),
      },
      {
        label: "Close current tab",
        detail: "Close this page",
        keywords: "remove exit",
        run: () => gBrowser.removeTab(gBrowser.selectedTab, { animate: true }),
      },
    ];
  },

  _commandResults(text) {
    return this._commands()
      .filter(command => !command.hidden)
      .filter(command =>
        this._matches(text, command.label, command.detail, command.keywords)
      )
      .map(command => ({ ...command, kind: "command", badge: "Command" }));
  },

  async _placeResults(text) {
    if (!text) {
      return [];
    }
    try {
      let db = await PlacesUtils.promiseDBConnection();
      let rows = await db.executeCached(
        `SELECT p.url, COALESCE(NULLIF(p.title, ''), p.url) AS title,
                EXISTS(SELECT 1 FROM moz_bookmarks b
                       WHERE b.fk = p.id AND b.type = 1) AS bookmarked
           FROM moz_places p
          WHERE p.hidden = 0
            AND (p.url LIKE :search ESCAPE '\\'
                 OR p.title LIKE :search ESCAPE '\\')
          ORDER BY bookmarked DESC, p.frecency DESC, p.last_visit_date DESC
          LIMIT 30`,
        { search: `%${this._escapeLike(text)}%` }
      );
      let openUrls = new Set(this._tabResults("").map(result => result.detail));
      return rows
        .map(row => {
          let url = row.getResultByName("url");
          let bookmarked = Boolean(row.getResultByName("bookmarked"));
          return {
            kind: bookmarked ? "bookmark" : "history",
            label: row.getResultByName("title"),
            detail: url,
            badge: bookmarked ? "Bookmark" : "History",
            icon: `page-icon:${url}`,
            run: () => this._openURL(url),
          };
        })
        .filter(result => !openUrls.has(result.detail));
    } catch (error) {
      console.error("Could not search Mizu command palette history", error);
      return [];
    }
  },

  _escapeLike(value) {
    return value
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
  },

  _searchResult(text) {
    return {
      kind: "search",
      label: `Search the web for “${text}”`,
      detail: "Use your default search engine",
      badge: "Web search",
      run: () => this._searchWeb(text),
    };
  },

  _openURL(url) {
    openTrustedLinkIn(url, "current", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  },

  async _searchWeb(text) {
    let engine = await MizuCommandPaletteLazy.SearchService.getDefault();
    let submission = engine.getSubmission(text, null, "commandpalette");
    openTrustedLinkIn(submission.uri.spec, "current", {
      postData: submission.postData,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  },

  _render() {
    this._list.replaceChildren();
    if (!this._results.length) {
      let empty = this._element("div", "mizu-command-palette-empty");
      empty.textContent = "No matching tabs, pages, or commands";
      this._list.append(empty);
      this._status.textContent = "No results";
      this._input.removeAttribute("aria-activedescendant");
      return;
    }
    this._results.forEach((result, index) => {
      let item = this._element("button", "mizu-command-palette-result");
      item.type = "button";
      item.id = `mizu-command-palette-result-${index}`;
      item.setAttribute("role", "option");
      item.dataset.index = index;
      item.dataset.kind = result.kind;

      let icon = this._element(
        result.icon ? "img" : "span",
        "mizu-command-palette-result-icon"
      );
      icon.setAttribute("aria-hidden", "true");
      if (result.icon) {
        item.setAttribute("mizu-has-icon", "true");
        icon.src = result.icon;
      }
      let text = this._element("span", "mizu-command-palette-result-text");
      let label = this._element("span", "mizu-command-palette-result-label");
      label.textContent = result.label;
      let detail = this._element("span", "mizu-command-palette-result-detail");
      detail.textContent = result.detail;
      text.append(label, detail);
      let badge = this._element("span", "mizu-command-palette-result-badge");
      badge.textContent = result.badge;
      item.append(icon, text, badge);
      item.addEventListener("mouseenter", () => this._select(index));
      item.addEventListener("click", event => this._activate(index, event));
      this._list.append(item);
    });
    this._status.textContent = `${this._results.length} result${this._results.length == 1 ? "" : "s"}`;
    this._select(0);
  },

  _select(index) {
    if (!this._results.length) {
      return;
    }
    index = (index + this._results.length) % this._results.length;
    this._selectedIndex = index;
    for (let [itemIndex, item] of [...this._list.children].entries()) {
      item.toggleAttribute("selected", itemIndex == index);
      item.setAttribute("aria-selected", itemIndex == index ? "true" : "false");
    }
    let selected = this._list.children[index];
    this._input.setAttribute("aria-activedescendant", selected.id);
    selected.scrollIntoView({ block: "nearest" });
  },

  _activateSelected(event) {
    this._activate(this._selectedIndex, event);
  },

  _activate(index, event) {
    let result = this._results[index];
    if (!result) {
      return;
    }
    this.close();
    try {
      let outcome = result.run(event);
      if (outcome?.catch) {
        outcome.catch(error =>
          console.error("Could not run Mizu command palette action", error)
        );
      }
    } catch (error) {
      console.error("Could not run Mizu command palette action", error);
    }
  },
};

Services.obs.addObserver(function onDelayedStartup(subject) {
  if (subject !== window) {
    return;
  }
  Services.obs.removeObserver(
    onDelayedStartup,
    "browser-delayed-startup-finished"
  );
  MizuCommandPalette.init();
}, "browser-delayed-startup-finished");
