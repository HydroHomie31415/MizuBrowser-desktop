/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Content-process half of Mizu mouse gestures.
 *
 * It recognises nothing and runs nothing. MizuGestures, in the chrome process,
 * does all of that; this exists only to take away from the page the input a
 * gesture has already spent, which is the one thing the chrome process cannot
 * do for itself. A mouse event is dispatched in the parent first and forwarded
 * to content afterwards, so by the time the parent has decided that a press
 * was a gesture, the page is about to be told about it regardless.
 *
 * There is no message traffic in either direction. Both halves watch the same
 * button presses and apply the same threshold from the same preference, so the
 * child can tell that a press has become a gesture without being told, and a
 * dropped or late message can never leave the two disagreeing.
 *
 * Three things get taken away:
 *
 * - the context menu, once a stroke has been drawn, including any the page
 *   draws for itself out of its own contextmenu handler;
 * - the click that completes a rocker gesture, which would otherwise follow
 *   whatever link it happened to land on as well as going back;
 * - the scroll under a wheel gesture. Nothing in the parent can stop that one:
 *   the page scrolls from the compositor, and only a content listener that
 *   refuses the event holds it back.
 */

/**
 * Cheap listeners kept for the actor's life once anything has been pressed.
 *
 * All three arrive after the button that earned them has been released, so
 * dropping them at that release is exactly what would let them through.
 */
const TAIL_EVENTS = ["contextmenu", "click", "auxclick"];

/** Listeners that only make sense while a button is actually down. */
const PRESS_EVENTS = ["mousemove", "mouseup", "wheel"];

export class MizuGesturesChild extends JSWindowActorChild {
  /** Whether the gesture button is down and this frame saw it go down. */
  #tracking = false;

  /**
   * Whether this press has already been spent on a gesture.
   *
   * True once a stroke has travelled far enough to be one, and immediately for
   * a rocker or a wheel gesture, which are gestures the moment they happen. It
   * is what the context menu that follows the release is tested against.
   */
  #spent = false;

  /** Buttons whose next click and release belong to a rocker, not the page. */
  #swallow = new Set();

  #startX = 0;
  #startY = 0;
  #threshold = 0;
  #tailListening = false;
  #pressListening = false;

  didDestroy() {
    this.#unlisten();
  }

  handleEvent(event) {
    switch (event.type) {
      case "mousedown":
        this.#onMouseDown(event);
        break;
      case "mousemove":
        this.#onMouseMove(event);
        break;
      case "mouseup":
        this.#onMouseUp(event);
        break;
      case "wheel":
        this.#onWheel(event);
        break;
      case "contextmenu":
        this.#onContextMenu(event);
        break;
      case "click":
      case "auxclick":
        this.#onClick(event);
        break;
    }
  }

  get #enabled() {
    return Services.prefs.getBoolPref("mizu.gestures.enabled", true);
  }

  get #button() {
    return Services.prefs.getIntPref("mizu.gestures.button", 2);
  }

  #onMouseDown(event) {
    this.#spent = false;
    this.#tracking = false;
    // A rocker whose click never arrived -- the pointer moved between press
    // and release, so Gecko produced none -- would otherwise leave this button
    // armed and swallow an ordinary click much later. Clearing it on the next
    // press of the same button is early enough, since that press comes before
    // the click it would have eaten.
    this.#swallow.delete(event.button);

    if (!this.#enabled || !event.isTrusted) {
      return;
    }

    if (
      Services.prefs.getBoolPref("mizu.gestures.rocker", true) &&
      // buttons already counts the button going down, so the other one being
      // set is what says it was being held when this one arrived.
      ((event.button == 0 && event.buttons & 2) ||
        (event.button == 2 && event.buttons & 1))
    ) {
      // Both buttons, not just the one that completed the rocker. The one
      // being held is released afterwards and produces a click of its own,
      // which is how a rocker over a link would go back and then follow it.
      this.#swallow.add(event.button);
      this.#swallow.add(event.button == 0 ? 2 : 0);
      // The held button is also the one that asks for a context menu when it
      // is finally released.
      this.#spent = true;
      this.#consume(event);
      this.#listenTail();
      return;
    }

    if (event.button != this.#button) {
      return;
    }

    this.#tracking = true;
    this.#startX = event.screenX;
    this.#startY = event.screenY;
    // Read once per press. The parent clamps this the same way, so both sides
    // agree on the point at which a press has become a gesture.
    this.#threshold = Math.max(
      Services.prefs.getIntPref("mizu.gestures.stroke-threshold", 24),
      8
    );
    this.#listenTail();
    this.#listenPress();
  }

  #onMouseMove(event) {
    if (!this.#tracking || this.#spent) {
      return;
    }
    let travelled = Math.max(
      Math.abs(event.screenX - this.#startX),
      Math.abs(event.screenY - this.#startY)
    );
    if (travelled >= this.#threshold) {
      this.#spent = true;
    }
  }

  #onMouseUp(event) {
    if (this.#swallow.has(event.button)) {
      this.#consume(event);
    }
    if (!event.buttons) {
      this.#tracking = false;
      this.#unlistenPress();
    }
  }

  #onWheel(event) {
    if (
      !this.#tracking ||
      !Services.prefs.getBoolPref("mizu.gestures.wheel", true)
    ) {
      return;
    }
    // A wheel gesture is still a gesture, so the release owes no context menu
    // either.
    this.#spent = true;
    this.#consume(event);
  }

  #onContextMenu(event) {
    if (!this.#spent) {
      return;
    }
    this.#spent = false;
    this.#consume(event);
  }

  #onClick(event) {
    if (!this.#swallow.delete(event.button)) {
      return;
    }
    this.#consume(event);
  }

  /**
   * Takes an event away from the page.
   *
   * stopPropagation keeps the page's own listeners from running at all, which
   * is what a page-drawn context menu needs; preventDefault covers the parts
   * Gecko itself would do, such as following the link a click landed on.
   * Neither reaches the system group, so Firefox's own context menu actor still
   * sees the event -- and turns itself off, because it checks defaultPrevented.
   *
   * @param {Event} event The event a gesture has spent.
   */
  #consume(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  #listenTail() {
    if (this.#tailListening) {
      return;
    }
    let win = this.contentWindow;
    if (!win) {
      return;
    }
    this.#tailListening = true;
    // These outlive the press. The context menu arrives after the button is
    // released, and dropping the listener at that release is what would let it
    // through.
    for (let type of TAIL_EVENTS) {
      win.addEventListener(type, this, { capture: true });
    }
  }

  #listenPress() {
    if (this.#pressListening) {
      return;
    }
    let win = this.contentWindow;
    if (!win) {
      return;
    }
    this.#pressListening = true;
    for (let type of PRESS_EVENTS) {
      // Not passive: a passive wheel listener cannot refuse the scroll, which
      // is the entire reason this one is here.
      win.addEventListener(type, this, { capture: true, passive: false });
    }
  }

  #unlistenPress() {
    if (!this.#pressListening) {
      return;
    }
    this.#pressListening = false;
    let win = this.contentWindow;
    for (let type of PRESS_EVENTS) {
      win?.removeEventListener(type, this, { capture: true });
    }
  }

  #unlisten() {
    this.#unlistenPress();
    if (!this.#tailListening) {
      return;
    }
    this.#tailListening = false;
    let win = this.contentWindow;
    for (let type of TAIL_EVENTS) {
      win?.removeEventListener(type, this, { capture: true });
    }
  }
}
