/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The actions Mizu offers mouse gestures, and how a stroke is spelled.
 *
 * This is shared rather than duplicated because two places need the same
 * answers and would drift apart: the gesture handler in each browser window,
 * which turns a stroke into a command and names it on screen, and the settings
 * pane, which offers the same commands in a menu and shows the same names for
 * the ones already bound.
 *
 * An action is only a command name. Nothing here is an allow-list: a gesture
 * preference may name any XUL <command> or controller command, and one that is
 * not listed still runs. Listing it only gives it a readable name and a place
 * in the settings menu.
 */

/** How each stroke direction is drawn. */
export const MIZU_GESTURE_DIRECTIONS = {
  L: "←",
  R: "→",
  U: "↑",
  D: "↓",
};

/**
 * The actions the settings pane offers, in the order it offers them.
 *
 * Grouped by what they act on rather than sorted, because the menu is read by
 * someone deciding what a gesture should do, not looking up a name they have.
 */
export const MIZU_GESTURE_ACTIONS = [
  { command: "Browser:BackOrBackDuplicate", label: "Back" },
  { command: "Browser:ForwardOrForwardDuplicate", label: "Forward" },
  { command: "Browser:ReloadOrDuplicate", label: "Reload" },
  { command: "Browser:ReloadSkipCache", label: "Reload, ignoring cache" },
  { command: "Browser:Stop", label: "Stop" },
  { command: "cmd_scrollTop", label: "Scroll to top" },
  { command: "cmd_scrollBottom", label: "Scroll to bottom" },
  { command: "cmd_scrollPageUp", label: "Page up" },
  { command: "cmd_scrollPageDown", label: "Page down" },
  { command: "cmd_newNavigatorTab", label: "New tab" },
  { command: "cmd_close", label: "Close tab" },
  { command: "History:UndoCloseTab", label: "Reopen closed tab" },
  { command: "Browser:DuplicateTab", label: "Duplicate tab" },
  { command: "Browser:NextTab", label: "Next tab" },
  { command: "Browser:PrevTab", label: "Previous tab" },
  { command: "Browser:ShowAllTabs", label: "Show all tabs" },
  { command: "cmd_toggleMute", label: "Toggle mute" },
  { command: "cmd_newNavigator", label: "New window" },
  { command: "Tools:PrivateBrowsing", label: "New private window" },
  { command: "cmd_closeWindow", label: "Close window" },
  { command: "cmd_minimizeWindow", label: "Minimise window" },
  { command: "cmd_maximizeWindow", label: "Maximise window" },
  { command: "View:FullScreen", label: "Toggle fullscreen" },
  { command: "cmd_fullZoomEnlarge", label: "Zoom in" },
  { command: "cmd_fullZoomReduce", label: "Zoom out" },
  { command: "cmd_fullZoomReset", label: "Reset zoom" },
  { command: "Browser:AddBookmarkAs", label: "Bookmark page" },
  { command: "Browser:Screenshot", label: "Take a screenshot" },
  { command: "View:PictureInPicture", label: "Picture-in-Picture" },
  { command: "View:ReaderView", label: "Reader view" },
  { command: "View:PageSource", label: "View page source" },
  { command: "Browser:OpenLocation", label: "Focus the address bar" },
  { command: "Tools:Downloads", label: "Show downloads" },
  { command: "cmd_find", label: "Find in page" },
  { command: "cmd_print", label: "Print" },
];

/**
 * Names for commands that are not offered but may already be bound.
 *
 * Firefox has several near-duplicate commands where only one belongs in a
 * menu -- Browser:Back and Browser:BackOrBackDuplicate differ only in whether
 * a modifier can open the result in a new tab, and offering both would be a
 * choice with no meaning. The unoffered one still needs a name for a profile
 * that has it bound.
 */
const MIZU_GESTURE_ALIASES = new Map([
  ["Browser:Back", "Back"],
  ["Browser:Forward", "Forward"],
  ["Browser:Reload", "Reload"],
  ["History:UndoCloseWindow", "Reopen closed window"],
]);

const MIZU_GESTURE_LABELS = new Map([
  ...MIZU_GESTURE_ACTIONS.map(action => [action.command, action.label]),
  ...MIZU_GESTURE_ALIASES,
]);

/**
 * The readable name of a command.
 *
 * @param {string} command A XUL command id or a controller command name.
 * @returns {string} Its name, or the command itself when it has none.
 */
export function mizuGestureLabel(command) {
  return MIZU_GESTURE_LABELS.get(command) ?? command;
}

/**
 * Draws a stroke code as arrows.
 *
 * @param {string} code A stroke spelled with U, D, L and R.
 * @returns {string} The same stroke as arrows.
 */
export function mizuGestureArrows(code) {
  return [...code].map(step => MIZU_GESTURE_DIRECTIONS[step] ?? step).join("");
}
