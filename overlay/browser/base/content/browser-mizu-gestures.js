/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mizu mouse gestures.
 *
 * Holding the right button over a page and drawing a stroke runs a command:
 * left goes back, down-then-right closes the tab. Rocker gestures (holding one
 * button and clicking the other) and wheel gestures (holding the right button
 * and turning the wheel) are the same idea without the drawing.
 *
 * Recognition lives in the chrome process. A content process only ever sees
 * one document, so an add-on has to stitch a stroke back together out of every
 * frame it crossed and give up where it cannot reach at all; the parent is
 * handed the whole stroke by the widget layer already, in one coordinate
 * space, whether it passed over a cross-origin iframe, a scrollbar, the video
 * player or a page that swallows mouse events. The trail is drawn on a chrome
 * canvas over the content area for the same reason: nothing in the page can
 * style it, script it or cover it.
 *
 * Actions are command names, resolved the way Firefox's own touchpad gestures
 * resolve theirs -- a XUL <command> from browser-sets.inc.xhtml when the id
 * matches one, otherwise a controller command sent through goDoCommand, which
 * is what carries cmd_scrollTop and its neighbours into the page. So the
 * mapping prefs accept anything those two mechanisms accept, and a gesture can
 * be pointed at a command Mizu has never heard of.
 *
 * The one thing the parent cannot do is stop the page from acting on the
 * clicks a gesture consumed, since a mouse event is dispatched here and
 * forwarded to content afterwards. MizuGesturesChild handles that half.
 */

// Shared with the settings pane, so the menu it offers and the names shown
// here cannot drift apart. See browser/modules/MizuGestureActions.sys.mjs.
const { mizuGestureArrows, mizuGestureLabel } = ChromeUtils.importESModule(
  "resource:///modules/MizuGestureActions.sys.mjs"
);

/**
 * One wheel notch, in the pixel deltas a line-mode wheel event stands for.
 *
 * Wheel events arrive in lines from a mouse and in pixels from a touchpad, and
 * a touchpad sends a stream of small ones. Both are accumulated into notches so
 * a gesture is one action per detent rather than one per event.
 */
const MIZU_GESTURE_WHEEL_NOTCH = 40;

/** Longest stroke that is looked up, so a scribble cannot grow unbounded. */
const MIZU_GESTURE_MAX_STROKES = 8;

/**
 * How long a consumed gesture keeps suppressing the context menu, in ms.
 *
 * The menu is opened from the content process, so its request is already in
 * flight when the button is released and the suppression has to outlive that
 * round trip. It is cleared as soon as the menu is actually turned away, so
 * this only bounds the case where no menu was ever requested.
 */
const MIZU_GESTURE_SUPPRESS_MS = 1000;

var MizuGestures = {
  PREF_BRANCH: "mizu.gestures.",

  _initialized: false,
  _tracking: false,
  _wheeled: false,
  _pattern: "",
  _anchorX: 0,
  _anchorY: 0,
  _lastX: 0,
  _lastY: 0,
  _wheelDelta: 0,
  _threshold: 24,
  _consumedAt: 0,
  _overlay: null,
  _canvas: null,
  _context: null,
  _status: null,
  _contextMenu: null,
  _moveListeners: false,

  get enabled() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}enabled`, true);
  },

  get button() {
    return Services.prefs.getIntPref(`${this.PREF_BRANCH}button`, 2);
  },

  get threshold() {
    // Below a handful of pixels every jitter is a direction, and the pattern
    // becomes noise the moment the hand is not perfectly steady.
    return Math.max(
      Services.prefs.getIntPref(`${this.PREF_BRANCH}stroke-threshold`, 24),
      8
    );
  },

  get rockerEnabled() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}rocker`, true);
  },

  get wheelEnabled() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}wheel`, true);
  },

  get trailEnabled() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}trail`, true);
  },

  get statusEnabled() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}status`, true);
  },

  /**
   * Whether the settings pane is waiting to be handed a stroke.
   *
   * Recording goes through the same recogniser that will later interpret the
   * stroke rather than through a second one in the settings page, so a gesture
   * cannot be recorded in a form that the browser then reads differently.
   */
  get recording() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}recording`, false);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    // Only mousedown is watched all the time. The move, release and wheel
    // listeners are attached when a stroke starts and dropped when it ends,
    // because a listener on every mouse move in the window is a cost paid on
    // every page whether or not anyone ever draws a gesture.
    window.addEventListener("mousedown", this, true);
    window.addEventListener("unload", this, { once: true });

    // preventDefault on popupshowing is the one place the context menu can be
    // turned away from here with certainty. The contextmenu event itself is
    // dispatched in this process and then forwarded to content, so cancelling
    // it here does not reliably reach the actor that opens the menu.
    this._contextMenu = document.getElementById("contentAreaContextMenu");
    this._contextMenu?.addEventListener("popupshowing", this, true);
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    this._stop();
    window.removeEventListener("mousedown", this, true);
    this._contextMenu?.removeEventListener("popupshowing", this, true);
    this._contextMenu = null;
  },

  handleEvent(event) {
    switch (event.type) {
      case "unload":
        this.uninit();
        break;
      case "mousedown":
        this._onMouseDown(event);
        break;
      case "mousemove":
        this._onMouseMove(event);
        break;
      case "mouseup":
        this._onMouseUp(event);
        break;
      case "wheel":
        this._onWheel(event);
        break;
      case "popupshowing":
        this._onPopupShowing(event);
        break;
    }
  },

  /**
   * Converts a mouse event to a point in this window's coordinates.
   *
   * screenX is in the CSS pixels of the document the event was targeted at,
   * which is not necessarily this window's scale, so it is rescaled the way
   * MousePosTracker rescales it before the window origin is subtracted.
   *
   * @param {MouseEvent} event The event to locate.
   * @returns {object} `{ x, y }` relative to the top left of the window.
   */
  _point(event) {
    let source = event.target?.documentGlobal;
    let scale =
      source && source != window
        ? source.devicePixelRatio / window.devicePixelRatio
        : 1;
    return {
      x: event.screenX * scale - window.mozInnerScreenX,
      y: event.screenY * scale - window.mozInnerScreenY,
    };
  },

  /**
   * Whether an event belongs to the page rather than to Mizu's own chrome.
   *
   * A mouse event over remote content is targeted at the <browser> element in
   * this document, which is the whole test. A document still loaded in the
   * parent process bubbles its own nodes up here instead and gets no gestures;
   * that is deliberate, because the alternative is guessing which chrome nodes
   * belong to a page, and guessing wrong costs the user their context menu.
   *
   * @param {Event} event The event to place.
   * @returns {boolean} True when the event came from the selected tab's page.
   */
  _inContent(event) {
    let browser = gBrowser?.selectedBrowser;
    return !!browser && event.target == browser;
  },

  _onMouseDown(event) {
    // A press is a fresh interaction, so whatever the last gesture consumed is
    // no longer owed a suppressed menu.
    this._consumedAt = 0;

    // While recording, a stroke is accepted anywhere in the window rather than
    // only over a page, because the settings pane the user is drawing on may
    // itself be loaded in this process and so never looks like content.
    let recording = this.recording;
    if (!this.enabled || (!recording && !this._inContent(event))) {
      this._stop();
      return;
    }

    // Neither of these draws anything, so neither is a stroke to record.
    if (!recording && this._rocker(event)) {
      return;
    }

    if (event.button != this.button) {
      // Pressing another button mid-stroke means the user is doing something
      // else now; abandoning beats running a command they did not finish.
      this._stop();
      return;
    }

    this._start(event);
  },

  /**
   * Runs a rocker gesture if this press completes one.
   *
   * @param {MouseEvent} event The press.
   * @returns {boolean} Whether the press was a rocker and has been handled.
   */
  _rocker(event) {
    if (!this.rockerEnabled) {
      return false;
    }

    // buttons already includes the button being pressed, so the other one
    // being set is what says it was already held.
    let held = event.buttons;
    let action = null;
    if (event.button == 0 && held & 2) {
      action = "back";
    } else if (event.button == 2 && held & 1) {
      action = "forward";
    }
    if (!action) {
      return false;
    }

    this._stop();
    this._consume(this._pref(`rocker.${action}`), event);
    return true;
  },

  _start(event) {
    let point = this._point(event);
    this._tracking = true;
    this._wheeled = false;
    this._pattern = "";
    this._wheelDelta = 0;
    this._anchorX = this._lastX = point.x;
    this._anchorY = this._lastY = point.y;
    // Read once per press rather than on every move. MizuGesturesChild clamps
    // it the same way, so both halves agree on when a press became a gesture.
    this._threshold = this.threshold;

    if (!this._moveListeners) {
      this._moveListeners = true;
      window.addEventListener("mousemove", this, true);
      window.addEventListener("mouseup", this, true);
      window.addEventListener("wheel", this, { capture: true, passive: false });
    }
  },

  _onMouseMove(event) {
    if (!this._tracking || this._wheeled) {
      return;
    }

    let point = this._point(event);
    this._draw(point);

    let dx = point.x - this._anchorX;
    let dy = point.y - this._anchorY;
    let horizontal = Math.abs(dx) > Math.abs(dy);
    if (Math.max(Math.abs(dx), Math.abs(dy)) < this._threshold) {
      return;
    }

    // The anchor moves to where the direction was decided rather than back to
    // zero, so a long straight stroke keeps re-deciding the same direction
    // instead of accumulating the drift of the one before it.
    this._anchorX = point.x;
    this._anchorY = point.y;

    let direction;
    if (horizontal) {
      direction = dx > 0 ? "R" : "L";
    } else {
      direction = dy > 0 ? "D" : "U";
    }
    if (direction == this._pattern.at(-1)) {
      return;
    }
    if (this._pattern.length >= MIZU_GESTURE_MAX_STROKES) {
      return;
    }

    this._pattern += direction;
    this._updateStatus();
  },

  _onMouseUp(event) {
    if (event.button != this.button) {
      return;
    }
    if (!this._tracking) {
      this._stop();
      return;
    }

    let pattern = this._pattern;
    let recording = this.recording;
    this._stop();
    if (!pattern) {
      return;
    }

    if (recording) {
      // Hand the stroke over instead of acting on it, and mark the press
      // consumed so the release does not also open a context menu over the
      // settings pane. Recording is cleared here rather than by the pane, so
      // one drawn stroke ends it even if the pane has gone away.
      Services.prefs.setBoolPref(`${this.PREF_BRANCH}recording`, false);
      Services.prefs.setStringPref(`${this.PREF_BRANCH}recorded`, pattern);
      this._consumedAt = Date.now();
      return;
    }

    this._consume(this._pref(`pattern.${pattern}`), event);
  },

  _onWheel(event) {
    if (!this._tracking || !this.wheelEnabled || this.recording) {
      return;
    }

    // The stroke and the wheel are alternative readings of the same press, so
    // turning the wheel settles it: neither the moves that follow nor the
    // release may still be read as a stroke.
    this._wheeled = true;
    this._pattern = "";
    this._hideOverlay();

    let step =
      event.deltaMode == event.DOM_DELTA_PIXEL ? 1 : MIZU_GESTURE_WHEEL_NOTCH;
    this._wheelDelta += event.deltaY * step;

    let fired = false;
    while (Math.abs(this._wheelDelta) >= MIZU_GESTURE_WHEEL_NOTCH) {
      let down = this._wheelDelta > 0;
      this._wheelDelta -= down
        ? MIZU_GESTURE_WHEEL_NOTCH
        : -MIZU_GESTURE_WHEEL_NOTCH;
      this._consume(this._pref(`wheel.${down ? "down" : "up"}`), event);
      fired = true;
    }

    // Scrolling is stopped whether or not a notch completed, so the page does
    // not creep along underneath a gesture that is still being counted.
    event.preventDefault();
    if (fired) {
      this._consumedAt = Date.now();
    }
  },

  /**
   * Cancels the context menu a completed gesture has already paid for.
   *
   * @param {Event} event The popupshowing event.
   */
  _onPopupShowing(event) {
    if (event.target != this._contextMenu || !this._consumedAt) {
      return;
    }
    // The keyboard menu key can ask for the menu without a press to clear the
    // mark first, so an old one is allowed to lapse rather than swallow it.
    let owed = Date.now() - this._consumedAt < MIZU_GESTURE_SUPPRESS_MS;
    this._consumedAt = 0;
    if (owed) {
      event.preventDefault();
    }
  },

  _pref(name) {
    return Services.prefs
      .getStringPref(`${this.PREF_BRANCH}${name}`, "")
      .trim();
  },

  /**
   * Runs the command a gesture resolved to and records that it consumed it.
   *
   * The gesture is marked consumed even when nothing is bound to it, because
   * the user still drew one, and following it with a context menu they did not
   * ask for is worse than doing nothing at all.
   *
   * @param {string} command A XUL command id or a controller command name.
   * @param {MouseEvent} event The event that completed the gesture.
   */
  _consume(command, event) {
    this._consumedAt = Date.now();
    if (command) {
      this._run(command, event);
    }
  },

  /**
   * Executes one command.
   *
   * Both halves mirror gGestureSupport, so a command name means exactly what it
   * means to Firefox's own gestures. The synthesised command event carries the
   * modifiers through, which is what lets a shift-held Back open in a new tab.
   *
   * @param {string} command A XUL command id or a controller command name.
   * @param {MouseEvent} event The event that completed the gesture.
   */
  _run(command, event) {
    let node = document.getElementById(command);
    if (node) {
      if (node.getAttribute("disabled") == "true") {
        return;
      }
      let commandEvent = document.createEvent("xulcommandevent");
      commandEvent.initCommandEvent(
        "command",
        true,
        true,
        window,
        0,
        event.ctrlKey,
        event.altKey,
        event.shiftKey,
        event.metaKey,
        0,
        event,
        event.mozInputSource ?? 0
      );
      node.dispatchEvent(commandEvent);
      return;
    }

    try {
      goDoCommand(command);
    } catch (error) {
      console.error(`Mizu gesture command ${command} failed`, error);
    }
  },

  _stop() {
    this._tracking = false;
    this._wheeled = false;
    this._pattern = "";
    this._wheelDelta = 0;
    this._hideOverlay();

    if (this._moveListeners) {
      this._moveListeners = false;
      window.removeEventListener("mousemove", this, true);
      window.removeEventListener("mouseup", this, true);
      window.removeEventListener("wheel", this, { capture: true });
    }
  },

  /**
   * Builds the trail canvas and the status readout.
   *
   * Both are created when a stroke starts and thrown away when it ends, so
   * there is nothing to keep in step with window resizes, full screen, or a
   * move between screens of different scale.
   */
  _showOverlay() {
    if (this._overlay || !document.body) {
      return;
    }

    let html = "http://www.w3.org/1999/xhtml";
    this._overlay = document.createElementNS(html, "div");
    this._overlay.id = "mizu-gesture-overlay";

    if (this.trailEnabled) {
      let ratio = window.devicePixelRatio;
      this._canvas = document.createElementNS(html, "canvas");
      this._canvas.id = "mizu-gesture-trail";
      this._canvas.width = Math.round(window.innerWidth * ratio);
      this._canvas.height = Math.round(window.innerHeight * ratio);
      this._context = this._canvas.getContext("2d");
      this._context.scale(ratio, ratio);
      this._context.lineWidth = Services.prefs.getIntPref(
        `${this.PREF_BRANCH}trail-width`,
        3
      );
      this._context.strokeStyle = Services.prefs.getStringPref(
        `${this.PREF_BRANCH}trail-colour`,
        "#5ab9e0"
      );
      this._context.lineCap = "round";
      this._context.lineJoin = "round";
      this._overlay.appendChild(this._canvas);
    }

    if (this.statusEnabled) {
      this._status = document.createElementNS(html, "div");
      this._status.id = "mizu-gesture-status";
      this._status.hidden = true;
      this._overlay.appendChild(this._status);
    }

    document.body.appendChild(this._overlay);
  },

  _hideOverlay() {
    this._overlay?.remove();
    this._overlay = null;
    this._canvas = null;
    this._context = null;
    this._status = null;
  },

  /**
   * Extends the trail to a new point.
   *
   * Only the new segment is stroked. Re-stroking the whole path on every move
   * would make a long gesture quadratic in the number of points it collected,
   * which is exactly when the drawing has to stay ahead of the pointer.
   *
   * @param {object} point The `{ x, y }` the pointer has reached.
   */
  _draw(point) {
    if (!this._overlay) {
      // _lastX/_lastY still hold the press point until something is drawn, so
      // this is the distance from it. A right click with a pixel of tremor in
      // it is not a gesture and should not flash anything on screen.
      let moved = Math.max(
        Math.abs(point.x - this._lastX),
        Math.abs(point.y - this._lastY)
      );
      if (moved < 4 || (!this.trailEnabled && !this.statusEnabled)) {
        return;
      }
      this._showOverlay();
    }

    if (this._context) {
      this._context.beginPath();
      this._context.moveTo(this._lastX, this._lastY);
      this._context.lineTo(point.x, point.y);
      this._context.stroke();
    }

    this._lastX = point.x;
    this._lastY = point.y;
  },

  _updateStatus() {
    if (!this._status) {
      return;
    }

    let arrows = mizuGestureArrows(this._pattern);
    // While recording, what the stroke is currently bound to is beside the
    // point; the user is being shown the stroke they are handing over.
    let command = this.recording ? "" : this._pref(`pattern.${this._pattern}`);

    // An unbound stroke names itself instead, because the code it just spelled
    // is the one thing the user needs in order to bind it: the preference to
    // create is mizu.gestures.pattern. followed by exactly this.
    this._status.textContent = command
      ? `${arrows}  ${mizuGestureLabel(command)}`
      : `${arrows}  ${this._pattern}`;
    this._status.toggleAttribute("unbound", !command);
    this._status.hidden = false;
  },
};

// gBrowser does not exist at DOMContentLoaded, and init() reaches for it.
Services.obs.addObserver(function onDelayedStartup(subject) {
  if (subject !== window) {
    return;
  }
  Services.obs.removeObserver(
    onDelayedStartup,
    "browser-delayed-startup-finished"
  );
  MizuGestures.init();
}, "browser-delayed-startup-finished");
