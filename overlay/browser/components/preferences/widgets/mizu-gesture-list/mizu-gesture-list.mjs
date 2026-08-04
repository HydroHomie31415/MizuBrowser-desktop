/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";

const { MIZU_GESTURE_ACTIONS, mizuGestureArrows, mizuGestureLabel } =
  ChromeUtils.importESModule("resource:///modules/MizuGestureActions.sys.mjs");

const PATTERN_BRANCH = "mizu.gestures.pattern.";
const RECORDING_PREF = "mizu.gestures.recording";
const RECORDED_PREF = "mizu.gestures.recorded";

/** The bindings that always exist and are named rather than drawn. */
const FIXED_BINDINGS = [
  { pref: "mizu.gestures.rocker.back", l10nId: "mizu-gestures-rocker-back" },
  {
    pref: "mizu.gestures.rocker.forward",
    l10nId: "mizu-gestures-rocker-forward",
  },
  { pref: "mizu.gestures.wheel.up", l10nId: "mizu-gestures-wheel-up" },
  { pref: "mizu.gestures.wheel.down", l10nId: "mizu-gestures-wheel-down" },
];

/**
 * The gesture editor in Mizu's settings.
 *
 * Every row is a preference and nothing else: the list is read from the
 * mizu.gestures.pattern. branch on every change, and editing a row writes
 * straight back to it. There is no separate model to fall out of step, so a
 * gesture added here and one added in about:config are the same thing, and a
 * change made in either shows up in the other.
 *
 * Recording is done by the browser rather than here. Pressing Record sets
 * mizu.gestures.recording, which makes the window's gesture handler hand the
 * next stroke over through mizu.gestures.recorded instead of acting on it. The
 * stroke is therefore read by the same code that will interpret it later, at
 * the same threshold, so a gesture cannot be recorded in a form that the
 * browser goes on to read as something else.
 */
export default class MizuGestureList extends MozLitElement {
  static properties = {
    strokes: { state: true },
    recording: { state: true },
    pending: { state: true },
  };

  constructor() {
    super();
    /** @type {{code: string, command: string}[]} */
    this.strokes = [];
    this.recording = false;
    /** @type {string} The stroke just recorded and not yet given an action. */
    this.pending = "";

    // The preference service will not take a DOM element as an observer --
    // XPConnect cannot present one as an nsIObserver -- so the registration
    // goes through a plain object that forwards back here.
    this.prefObserver = {
      observe: (subject, topic, data) => this.observe(subject, topic, data),
    };
  }

  connectedCallback() {
    super.connectedCallback();
    Services.prefs.addObserver("mizu.gestures.", this.prefObserver);
    this.refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    Services.prefs.removeObserver("mizu.gestures.", this.prefObserver);
    // Leaving the browser armed after the pane is closed would swallow the
    // next stroke the user drew for real.
    this.stopRecording();
  }

  observe(subject, topic, data) {
    if (data == RECORDED_PREF) {
      this.onRecorded();
      return;
    }
    if (data == RECORDING_PREF) {
      this.recording = Services.prefs.getBoolPref(RECORDING_PREF, false);
      return;
    }
    if (data.startsWith(PATTERN_BRANCH)) {
      this.refresh();
    }
  }

  /** Rereads every bound stroke from the preference branch. */
  refresh() {
    let strokes = [];
    for (let pref of Services.prefs.getChildList(PATTERN_BRANCH)) {
      let command = Services.prefs.getStringPref(pref, "").trim();
      if (!command) {
        continue;
      }
      strokes.push({ code: pref.slice(PATTERN_BRANCH.length), command });
    }
    // Shortest first, then alphabetically, so the one- and two-stroke gestures
    // people actually use are not buried under longer ones.
    strokes.sort(
      (a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code)
    );
    this.strokes = strokes;
  }

  startRecording() {
    this.pending = "";
    Services.prefs.setStringPref(RECORDED_PREF, "");
    Services.prefs.setBoolPref(RECORDING_PREF, true);
  }

  stopRecording() {
    if (Services.prefs.getBoolPref(RECORDING_PREF, false)) {
      Services.prefs.setBoolPref(RECORDING_PREF, false);
    }
  }

  onRecorded() {
    let code = Services.prefs.getStringPref(RECORDED_PREF, "");
    if (!code) {
      return;
    }
    this.recording = false;
    // An already-bound stroke is offered for rebinding rather than duplicated,
    // since two preferences cannot share a name anyway.
    this.pending = code;
  }

  /**
   * Binds a stroke, or unbinds it when the command is empty.
   *
   * @param {string} code The stroke, spelled with U, D, L and R.
   * @param {string} command The command to run, or "" to remove the gesture.
   */
  setStroke(code, command) {
    let pref = PATTERN_BRANCH + code;
    if (command) {
      Services.prefs.setStringPref(pref, command);
    } else if (Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    } else {
      // A default Mizu ships cannot be cleared away, only emptied.
      Services.prefs.setStringPref(pref, "");
    }
    this.pending = "";
    this.refresh();
  }

  actionMenuTemplate(selected, onChange) {
    // A command Mizu does not offer is still listed, and stays selected, so
    // opening this pane cannot quietly rewrite a gesture that was set up by
    // hand to run something the menu has never heard of.
    let known = MIZU_GESTURE_ACTIONS.some(action => action.command == selected);
    return html`<moz-select
      class="mizu-gesture-action"
      value=${selected}
      @change=${event => onChange(event.target.value)}
    >
      <moz-option value="" label="—"></moz-option>
      ${!known && selected
        ? html`<moz-option
            value=${selected}
            label=${mizuGestureLabel(selected)}
          ></moz-option>`
        : ""}
      ${repeat(
        MIZU_GESTURE_ACTIONS,
        action => action.command,
        action =>
          html`<moz-option
            value=${action.command}
            label=${action.label}
          ></moz-option>`
      )}
    </moz-select>`;
  }

  strokeRowTemplate(stroke) {
    return html`<div class="mizu-gesture-row">
      <span class="mizu-gesture-stroke" aria-hidden="true"
        >${mizuGestureArrows(stroke.code)}</span
      >
      <code class="mizu-gesture-code">${stroke.code}</code>
      ${this.actionMenuTemplate(stroke.command, command =>
        this.setStroke(stroke.code, command)
      )}
      <moz-button
        type="ghost"
        iconsrc="chrome://global/skin/icons/delete.svg"
        data-l10n-id="mizu-gestures-remove"
        data-l10n-attrs="title"
        @click=${() => this.setStroke(stroke.code, "")}
      ></moz-button>
    </div>`;
  }

  fixedRowTemplate(binding) {
    let command = Services.prefs.getStringPref(binding.pref, "").trim();
    return html`<div class="mizu-gesture-row">
      <span class="mizu-gesture-fixed" data-l10n-id=${binding.l10nId}></span>
      ${this.actionMenuTemplate(command, value =>
        Services.prefs.setStringPref(binding.pref, value)
      )}
      <span class="mizu-gesture-spacer"></span>
    </div>`;
  }

  pendingTemplate() {
    if (this.recording) {
      return html`<div class="mizu-gesture-recording">
        <span data-l10n-id="mizu-gestures-recording"></span>
        <moz-button
          data-l10n-id="mizu-gestures-cancel"
          @click=${() => this.stopRecording()}
        ></moz-button>
      </div>`;
    }

    if (!this.pending) {
      return html`<moz-button
        data-l10n-id="mizu-gestures-record"
        @click=${() => this.startRecording()}
      ></moz-button>`;
    }

    return html`<div class="mizu-gesture-row mizu-gesture-pending">
      <span class="mizu-gesture-stroke" aria-hidden="true"
        >${mizuGestureArrows(this.pending)}</span
      >
      <code class="mizu-gesture-code">${this.pending}</code>
      ${this.actionMenuTemplate("", command =>
        command ? this.setStroke(this.pending, command) : null
      )}
      <moz-button
        type="ghost"
        data-l10n-id="mizu-gestures-cancel"
        @click=${() => (this.pending = "")}
      ></moz-button>
    </div>`;
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/preferences/widgets/mizu-gesture-list.css"
      />
      <div class="mizu-gesture-list">
        ${repeat(
          this.strokes,
          stroke => stroke.code,
          stroke => this.strokeRowTemplate(stroke)
        )}
        ${repeat(
          FIXED_BINDINGS,
          binding => binding.pref,
          binding => this.fixedRowTemplate(binding)
        )}
        ${this.pendingTemplate()}
      </div>
    `;
  }
}

customElements.define("mizu-gesture-list", MizuGestureList);
