/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const HOST_ID = "mizu-link-hints-host";

/** Elements that are controls because of what they are, not how they behave. */
const CLICKABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "summary",
  "input:not([type='hidden']):not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "audio[controls]",
  "video[controls]",
  "label[for]",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[onclick]",
  "[onmousedown]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The roles a page uses when it builds a control out of a bare element. */
const CLICKABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/** A listener of one of these types is what makes a bare <div> worth hinting. */
const CLICK_LISTENERS = ["click", "mousedown", "mouseup"];

/** Text inputs want focus rather than a click. */
const TEXT_INPUT_TYPES = new Set([
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);

/** Schemes the parent may open in a new tab. Everything else is clicked. */
const LINKABLE_SCHEMES = /^(https?|ftp|file|about|mailto):/i;

/** Rects smaller than this in either axis are decoration, not targets. */
const MIN_SIZE = 4;

/** Hard cap, so a pathological page cannot lock up the content process. */
const MAX_HINTS = 500;

/** Events that invalidate every rect we measured, so the hints must go. */
const DISMISS_EVENTS = ["scroll", "resize", "pagehide", "wheel"];

/**
 * How long after labelling to ignore those events, in milliseconds.
 *
 * Lazy-loading pages emit a scroll or resize of their own the moment anything
 * touches the document, which would otherwise take the labels away in the same
 * frame they appeared in.
 */
const DISMISS_GRACE_MS = 200;

const STYLE = `
  :host {
    position: fixed !important;
    inset: 0 !important;
    display: block !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    background: none !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
    contain: layout style !important;
    opacity: 1 !important;
    visibility: visible !important;
    transform: none !important;
    filter: none !important;
  }

  .hint {
    position: absolute;
    padding: 1px 3px;
    border: 1px solid #a67c00;
    border-radius: 3px;
    background: linear-gradient(#ffe066, #ffc82e);
    box-shadow: 0 1px 3px rgb(0 0 0 / 45%);
    color: #1a1a00;
    font: 600 11px/1.2 monospace;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .hint[hidden] {
    display: none;
  }

  .hint > .typed {
    color: #a67c00;
  }
`;

/**
 * Content-process half of Mizu link hints: it finds the clickable elements in
 * one document, draws a label over each of them, and activates the one whose
 * label the user finished typing.
 *
 * Labels are assigned by the chrome process, because a page and the frames
 * inside it are separate documents that must not hand out the same label.
 */
export class MizuHintsChild extends JSWindowActorChild {
  #hints = [];
  #host = null;
  #root = null;
  #shownAt = 0;
  #listeners = [];

  didDestroy() {
    this.#teardown();
  }

  receiveMessage(message) {
    switch (message.name) {
      case "MizuHints:Collect":
        return this.#collect(message.data);
      case "MizuHints:Show":
        return this.#show(message.data);
      case "MizuHints:Filter":
        return this.#filter(message.data);
      case "MizuHints:Activate":
        return this.#activate(message.data);
      case "MizuHints:Cancel":
        return this.#teardown();
    }
    return undefined;
  }

  handleEvent() {
    // Every rect was measured against a viewport that has now moved.
    if (Date.now() - this.#shownAt > DISMISS_GRACE_MS) {
      this.sendAsyncMessage("MizuHints:Dismiss", {});
    }
  }

  /**
   * Measures every hintable element in this document.
   *
   * Nothing is written to the DOM here: the whole pass is reads, so layout is
   * flushed once instead of once per element.
   *
   * @param {object} options
   * @param {boolean} options.detectListeners Whether to hint elements that are
   *   only clickable because a script attached a listener to them.
   * @returns {object} The candidates, ordered top to bottom, with the screen
   *   offset of this frame so the parent can order across frames.
   */
  #collect({ detectListeners }) {
    this.#teardown();

    let doc = this.document;
    let win = this.contentWindow;
    if (!doc?.documentElement || !win || doc.documentURI == "about:blank") {
      return { candidates: [], offsetX: 0, offsetY: 0 };
    }

    let width = win.innerWidth;
    let height = win.innerHeight;
    let found = [];
    let claimed = new Set();

    for (let element of this.#elements(doc)) {
      if (found.length >= MAX_HINTS) {
        break;
      }
      if (element.id == HOST_ID) {
        continue;
      }
      if (!this.#isNative(element) && !this.#isRole(element)) {
        continue;
      }
      let rect = this.#target(element, width, height);
      if (rect) {
        claimed.add(element);
        found.push({ element, rect });
      }
    }

    if (detectListeners) {
      this.#collectListeners(doc, found, claimed, width, height);
    }

    found.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    this.#hints = found.map(entry => ({ ...entry, label: "", node: null }));

    return {
      candidates: this.#hints.map((entry, index) => ({
        index,
        top: entry.rect.top,
        left: entry.rect.left,
      })),
      // mozInnerScreen* puts every frame in one coordinate space, so the parent
      // can order an iframe's hints against the page that embeds it.
      offsetX: win.mozInnerScreenX ?? 0,
      offsetY: win.mozInnerScreenY ?? 0,
    };
  }

  /**
   * Adds the elements that only a listener makes clickable.
   *
   * A `<div>` wired up with addEventListener carries nothing in its markup to
   * match on, which is why an extension has to guess at these. The listener
   * service answers the question directly, so Mizu does not have to guess.
   *
   * @param {Document} doc The document being scanned.
   * @param {object[]} found The candidate list, appended to in place.
   * @param {Set<Element>} claimed Elements already hinted by an earlier pass.
   * @param {number} width Viewport width in CSS pixels.
   * @param {number} height Viewport height in CSS pixels.
   */
  #collectListeners(doc, found, claimed, width, height) {
    let service = Services.els;
    if (!service) {
      return;
    }

    for (let element of this.#elements(doc)) {
      if (found.length >= MAX_HINTS) {
        return;
      }
      if (claimed.has(element) || element.id == HOST_ID) {
        continue;
      }
      // A listener on an ancestor is usually delegation for a whole list, and
      // hinting the container instead of its rows is worse than nothing.
      if (this.#hasClaimedAncestor(element, claimed)) {
        continue;
      }
      let listeners;
      try {
        listeners = service.getListenerInfoFor(element);
      } catch (_) {
        continue;
      }
      if (!listeners?.some(info => CLICK_LISTENERS.includes(info.type))) {
        continue;
      }
      let rect = this.#target(element, width, height);
      if (rect) {
        claimed.add(element);
        found.push({ element, rect });
      }
    }
  }

  /**
   * Walks a document or shadow root, descending through shadow boundaries.
   *
   * `openOrClosedShadowRoot` is chrome-only, so a closed root that an extension
   * cannot see is still hintable here.
   *
   * @param {Document|ShadowRoot} root The tree to walk.
   * @yields {Element} Every element in the tree, hosts included.
   */
  *#elements(root) {
    for (let element of root.querySelectorAll("*")) {
      yield element;
      let shadow = element.openOrClosedShadowRoot;
      if (shadow) {
        yield* this.#elements(shadow);
      }
    }
  }

  #isNative(element) {
    try {
      return element.matches(CLICKABLE_SELECTOR);
    } catch (_) {
      return false;
    }
  }

  #isRole(element) {
    let role = element.getAttribute?.("role");
    return !!role && CLICKABLE_ROLES.has(role.toLowerCase());
  }

  #hasClaimedAncestor(element, claimed) {
    for (
      let node = element.parentNode;
      node;
      node = node.parentNode ?? node.host
    ) {
      if (claimed.has(node)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Decides where this element's hint goes, or that it gets none.
   *
   * @param {Element} element The candidate.
   * @param {number} width Viewport width in CSS pixels.
   * @param {number} height Viewport height in CSS pixels.
   * @returns {DOMRect|null} The rect to anchor the label to.
   */
  #target(element, width, height) {
    if (element.getAttribute("aria-hidden") == "true" || element.disabled) {
      return null;
    }
    if (!this.#isVisible(element)) {
      return null;
    }

    // A link that wraps across two lines has a bounding box whose middle falls
    // in the gutter between them, so the individual line boxes are the truth.
    let rect = null;
    for (let candidate of element.getClientRects()) {
      if (this.#usable(candidate, width, height)) {
        rect = candidate;
        break;
      }
    }
    if (!rect) {
      // An <a> wrapping nothing but a floated image has no box of its own.
      let bounds = element.getBoundingClientRect();
      if (!this.#usable(bounds, width, height)) {
        return null;
      }
      rect = bounds;
    }

    return this.#reachable(element, rect, width, height) ? rect : null;
  }

  #isVisible(element) {
    if (element.checkVisibility) {
      return element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      });
    }
    let style = this.contentWindow.getComputedStyle(element);
    return (
      style.visibility == "visible" &&
      style.display != "none" &&
      style.opacity != "0"
    );
  }

  #usable(rect, width, height) {
    return (
      rect.width >= MIN_SIZE &&
      rect.height >= MIN_SIZE &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < height &&
      rect.left < width
    );
  }

  /**
   * Hit-tests the element, so a control buried under a cookie banner or a
   * sticky header does not get a label the user cannot reach.
   *
   * @param {Element} element The candidate.
   * @param {DOMRect} rect Its chosen rect.
   * @param {number} width Viewport width in CSS pixels.
   * @param {number} height Viewport height in CSS pixels.
   * @returns {boolean} Whether a click at the label would land on the element.
   */
  #reachable(element, rect, width, height) {
    let scope = element.getRootNode();
    if (!scope?.elementFromPoint) {
      return true;
    }

    let clamp = (value, max) => Math.min(Math.max(value, 1), max - 1);
    let probes = [
      [rect.left + Math.min(rect.width / 2, 8), rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + rect.width - 2, rect.top + rect.height - 2],
    ];

    for (let [x, y] of probes) {
      let hit = scope.elementFromPoint(clamp(x, width), clamp(y, height));
      if (hit && this.#contains(element, hit)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether `hit` is `element` or sits inside it, crossing shadow boundaries.
   *
   * @param {Element} element The candidate.
   * @param {Node} hit What the hit test returned.
   * @returns {boolean} True when the hit belongs to the element.
   */
  #contains(element, hit) {
    for (let node = hit; node; node = node.parentNode ?? node.host) {
      if (node == element) {
        return true;
      }
    }
    return false;
  }

  /**
   * Draws the labels the parent assigned.
   *
   * @param {object} options
   * @param {object[]} options.labels `{ index, label }` for this frame.
   */
  #show({ labels }) {
    let doc = this.document;
    if (!doc?.documentElement || !labels.length) {
      return;
    }

    this.#host = doc.createElement("div");
    this.#host.id = HOST_ID;
    doc.documentElement.appendChild(this.#host);
    this.#root = this.#host.attachShadow({ mode: "closed" });

    let style = doc.createElement("style");
    style.textContent = STYLE;
    this.#root.appendChild(style);

    let fragment = doc.createDocumentFragment();
    for (let { index, label } of labels) {
      let entry = this.#hints[index];
      if (!entry) {
        continue;
      }
      entry.label = label;
      let node = doc.createElement("span");
      node.className = "hint";
      node.textContent = label;
      // Anchor to the top-left corner, pulled outwards so the label sits over
      // the control's own edge rather than over the word next to it.
      node.style.left = `${Math.max(entry.rect.left - 4, 0)}px`;
      node.style.top = `${Math.max(entry.rect.top - 6, 0)}px`;
      entry.node = node;
      fragment.appendChild(node);
    }
    this.#root.appendChild(fragment);

    this.#shownAt = Date.now();
    this.#listen();
  }

  /**
   * Narrows the visible labels as the user types.
   *
   * @param {object} options
   * @param {string} options.typed What the user has typed so far.
   * @param {string[]} options.matches Labels still in play, from the parent.
   */
  #filter({ typed, matches }) {
    let live = new Set(matches);
    for (let entry of this.#hints) {
      if (!entry.node) {
        continue;
      }
      let visible = live.has(entry.label);
      entry.node.hidden = !visible;
      if (!visible) {
        continue;
      }
      // Grey out the part the user has already committed to, so what is left
      // to type is what stands out.
      let done = entry.label.startsWith(typed) ? typed.length : 0;
      entry.node.textContent = "";
      if (done) {
        let prefix = this.document.createElement("span");
        prefix.className = "typed";
        prefix.textContent = entry.label.slice(0, done);
        entry.node.appendChild(prefix);
      }
      entry.node.appendChild(
        this.document.createTextNode(entry.label.slice(done))
      );
    }
  }

  /**
   * Activates one hint and tears the overlay down.
   *
   * @param {object} options
   * @param {number} options.index Which candidate to activate.
   * @param {boolean} options.newTab Whether to open it in a new tab.
   * @returns {boolean} Whether anything was activated.
   */
  #activate({ index, newTab }) {
    let entry = this.#hints[index];
    let element = entry?.element;
    let rect = entry?.rect;
    this.#teardown();

    if (!element?.isConnected) {
      return false;
    }

    // Text fields want the caret, not a click: clicking one and leaving is how
    // a keyboard user ends up typing into the page instead of the field.
    if (this.#isTextEntry(element)) {
      element.focus();
      return true;
    }

    let href = element.getAttribute?.("href");
    if (newTab && href && LINKABLE_SCHEMES.test(element.href ?? "")) {
      this.sendAsyncMessage("MizuHints:OpenLink", { url: element.href });
      return true;
    }

    element.focus?.();
    this.#click(element, rect);
    return true;
  }

  #isTextEntry(element) {
    let name = element.localName;
    if (name == "textarea" || element.isContentEditable) {
      return true;
    }
    return (
      name == "input" &&
      TEXT_INPUT_TYPES.has((element.type || "text").toLowerCase())
    );
  }

  /**
   * Clicks an element the way the user would have.
   *
   * A real widget usually listens on mousedown, not click, so a bare
   * `element.click()` misses it and the whole sequence has to be sent.
   *
   * Synthesising through the widget layer instead would produce trusted events,
   * which the handful of sites that test `isTrusted` would honour, but
   * sendMouseEvent takes widget coordinates rather than the viewport
   * coordinates every rect here is measured in. Getting that wrong clicks
   * whatever else is at those coordinates, so it stays off until someone has
   * confirmed the mapping on a page with a scrolled-out-of-view root frame.
   *
   * @param {Element} element The element to click.
   * @param {DOMRect} rect The rect it occupied when it was measured.
   */
  #click(element, rect) {
    let win = this.contentWindow;

    if (
      rect &&
      Services.prefs.getBoolPref("mizu.hints.trusted-click", false) &&
      this.#trustedClick(element, rect)
    ) {
      return;
    }

    for (let type of ["mouseover", "mousedown", "mouseup", "click"]) {
      element.dispatchEvent(
        new win.MouseEvent(type, {
          view: win,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
    }
  }

  /**
   * Clicks through the widget layer, so the page sees a trusted event.
   *
   * @param {Element} element The element to click.
   * @param {DOMRect} rect The rect it occupied when it was measured.
   * @returns {boolean} Whether the click was sent.
   */
  #trustedClick(element, rect) {
    let utils = this.contentWindow?.windowUtils;
    if (!utils) {
      return false;
    }

    let x = rect.left + Math.min(rect.width / 2, 8);
    let y = rect.top + rect.height / 2;
    let hit = element.getRootNode()?.elementFromPoint?.(x, y);
    if (!hit || !this.#contains(element, hit)) {
      return false;
    }

    try {
      utils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      utils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  #listen() {
    let win = this.contentWindow;
    if (!win) {
      return;
    }
    // Typed labels are handled in the chrome process, which sees key events
    // before they are forwarded here, so this document only has to notice when
    // its own layout moves out from under the labels.
    for (let type of DISMISS_EVENTS) {
      let options = { capture: true, passive: true };
      win.addEventListener(type, this, options);
      this.#listeners.push({ target: win, type, options });
    }
  }

  #teardown() {
    for (let { target, type, options } of this.#listeners) {
      target.removeEventListener(type, this, options);
    }
    this.#listeners = [];
    this.#hints = [];
    this.#host?.remove();
    this.#host = null;
    this.#root = null;
  }
}
