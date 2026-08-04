/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

// mizu-gesture-list is registered by the module script preferences.xhtml
// loads, the same way every other pane widget is.

Preferences.addAll([
  { id: "mizu.gestures.enabled", type: "bool" },
  { id: "mizu.gestures.rocker", type: "bool" },
  { id: "mizu.gestures.wheel", type: "bool" },
  { id: "mizu.gestures.trail", type: "bool" },
  { id: "mizu.gestures.status", type: "bool" },
  { id: "mizu.gestures.stroke-threshold", type: "int" },
]);

for (let [id, pref] of [
  ["mizuGesturesEnabled", "mizu.gestures.enabled"],
  ["mizuGesturesRocker", "mizu.gestures.rocker"],
  ["mizuGesturesWheel", "mizu.gestures.wheel"],
  ["mizuGesturesTrail", "mizu.gestures.trail"],
  ["mizuGesturesStatus", "mizu.gestures.status"],
  ["mizuGesturesThreshold", "mizu.gestures.stroke-threshold"],
]) {
  let master = id == "mizuGesturesEnabled";
  Preferences.addSetting({
    id,
    pref,
    // Everything below the master switch is inert while gestures are off, and
    // greying it out beats letting someone change a setting that does nothing.
    // The dependency is what re-evaluates this when the switch is thrown,
    // rather than only when the pane is next built.
    deps: master ? undefined : ["mizuGesturesEnabled"],
    disabled: master
      ? undefined
      : ({ mizuGesturesEnabled }) => !mizuGesturesEnabled.value,
  });
}

// The editor keeps no state of its own -- it reads and writes the gesture
// preferences directly -- so it needs a setting only to be given a place.
Preferences.addSetting({ id: "mizuGestureList" });

SettingGroupManager.registerGroups({
  mizuGestures: {
    l10nId: "mizu-gestures-group",
    headingLevel: 2,
    items: [
      { id: "mizuGesturesEnabled", l10nId: "mizu-gestures-enabled" },
      { id: "mizuGesturesRocker", l10nId: "mizu-gestures-rocker" },
      { id: "mizuGesturesWheel", l10nId: "mizu-gestures-wheel" },
      { id: "mizuGesturesTrail", l10nId: "mizu-gestures-trail" },
      { id: "mizuGesturesStatus", l10nId: "mizu-gestures-status" },
      {
        id: "mizuGesturesThreshold",
        l10nId: "mizu-gestures-threshold",
        control: "moz-select",
        options: [
          {
            control: "moz-option",
            value: 12,
            l10nId: "mizu-gestures-threshold-short",
          },
          {
            control: "moz-option",
            value: 24,
            l10nId: "mizu-gestures-threshold-medium",
          },
          {
            control: "moz-option",
            value: 40,
            l10nId: "mizu-gestures-threshold-long",
          },
        ],
      },
    ],
  },
  mizuGestureBindings: {
    l10nId: "mizu-gestures-bindings-group",
    headingLevel: 2,
    items: [{ id: "mizuGestureList", control: "mizu-gesture-list" }],
  },
});
