/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public builds need a Mizu-owned and signed update service before enabling
// application updates. Extension and blocklist updates remain separate.
pref("app.update.enabled", false);
pref("app.update.auto", false);
pref("app.update.url.manual", "");
pref("app.update.url.details", "");

pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");

// Mizu's default layout: tabs live in the sidebar, and the navigation toolbar
// and sidebar both auto-hide so the content area keeps the whole window.
pref("sidebar.revamp", true);
pref("sidebar.verticalTabs", true);
// Mizu hides the sidebar itself, so leave Firefox's own visibility handling on
// its always-show path rather than having two things fight over it.
pref("sidebar.visibility", "always-show");

// Chrome column. See browser/base/content/browser-mizu-autohide.js.
// Stack the navigation toolbar on top of the vertical tabs as one column.
pref("mizu.chrome.column", true);
// Slide that column off-screen until the pointer reaches its window edge.
pref("mizu.chrome.autohide", true);
// Column width in pixels. The toolbar inside it is intrinsically much wider
// than a sidebar, so the column has to be told how wide to be.
pref("mizu.chrome.column-width", 320);
// Expand the address bar into a panel centred over the content when focused,
// instead of leaving it at the column's width.
pref("mizu.chrome.urlbar-float", true);
// Width, in pixels, of the window-edge strip that reveals the column.
pref("mizu.chrome.trigger-size", 4);
// Grace period before a column the pointer has left slides away again.
pref("mizu.chrome.hide-delay-ms", 120);

// Unified command palette. Ctrl+Space opens it from any browser window.
pref("mizu.palette.enabled", true);
pref("mizu.palette.max-results", 14);
pref("mizu.palette.open-on-new-tab", true);

// Link hints. Ctrl+G labels every clickable element in the tab; typing a label
// activates it, and Ctrl+Shift+G opens links in a background tab instead.
pref("mizu.hints.enabled", true);
// The alphabet labels are drawn from, home row first so the common hints are
// the ones the fingers are already resting on. Duplicates are ignored.
pref("mizu.hints.characters", "sadfjklewcmpgh");
// Ctrl+G is find-again upstream; F3 still does that. Set any KeyboardEvent
// code here to move the shortcut, e.g. "KeyF".
pref("mizu.hints.key-code", "KeyG");
// Also hint elements that are only clickable because a script attached a
// listener to them, which is most controls a modern site builds out of divs.
// Turn off if a very large page takes too long to label.
pref("mizu.hints.detect-listeners", true);
// Send the activation click through the widget layer so the page receives a
// trusted event. Off until the widget coordinate mapping has been confirmed
// against a scrolled root frame; see MizuHintsChild's #click.
pref("mizu.hints.trusted-click", false);

// Mouse gestures. Hold the right button over a page and draw a stroke to run a
// command. See browser/base/content/browser-mizu-gestures.js.
pref("mizu.gestures.enabled", true);
// Which button draws, as a MouseEvent button value: 2 is the right button.
pref("mizu.gestures.button", 2);
// How far the pointer has to travel along one axis before that direction joins
// the stroke. Small values turn an unsteady hand into extra directions.
pref("mizu.gestures.stroke-threshold", 24);
// Rocker gestures: hold one button and click the other. Wheel gestures: hold
// the gesture button and turn the wheel.
pref("mizu.gestures.rocker", true);
pref("mizu.gestures.wheel", true);
// Draw the stroke over the page, and name the action it resolved to.
pref("mizu.gestures.trail", true);
pref("mizu.gestures.trail-width", 3);
pref("mizu.gestures.trail-colour", "#5ab9e0");
pref("mizu.gestures.status", true);

// What each gesture runs. The value is a command: the id of a XUL <command> in
// browser-sets.inc.xhtml, or the name of a controller command such as
// cmd_scrollTop, which is the same vocabulary Firefox's own touchpad gestures
// use. Any stroke of up to eight directions works, spelled with U, D, L and R
// in the order they were drawn, so adding mizu.gestures.pattern.ULD adds a
// gesture. An empty value unbinds one.
pref("mizu.gestures.pattern.L", "Browser:BackOrBackDuplicate");
pref("mizu.gestures.pattern.R", "Browser:ForwardOrForwardDuplicate");
pref("mizu.gestures.pattern.U", "cmd_scrollTop");
pref("mizu.gestures.pattern.D", "cmd_scrollBottom");
pref("mizu.gestures.pattern.UD", "Browser:ReloadOrDuplicate");
pref("mizu.gestures.pattern.DU", "cmd_newNavigatorTab");
pref("mizu.gestures.pattern.DR", "cmd_close");
pref("mizu.gestures.pattern.DL", "History:UndoCloseTab");
pref("mizu.gestures.pattern.UL", "Browser:PrevTab");
pref("mizu.gestures.pattern.UR", "Browser:NextTab");
pref("mizu.gestures.pattern.RU", "Browser:DuplicateTab");
pref("mizu.gestures.pattern.RD", "Browser:AddBookmarkAs");
pref("mizu.gestures.rocker.back", "Browser:BackOrBackDuplicate");
pref("mizu.gestures.rocker.forward", "Browser:ForwardOrForwardDuplicate");
pref("mizu.gestures.wheel.up", "Browser:PrevTab");
pref("mizu.gestures.wheel.down", "Browser:NextTab");

// Set by the settings pane while it waits to be handed a stroke. The window's
// gesture handler then records the next one instead of acting on it, and
// writes it here. Both are internal to that exchange.
pref("mizu.gestures.recording", false);
pref("mizu.gestures.recorded", "");

// Open the context menu when the right button is released rather than when it
// is pressed, which is what leaves the press free to be drawn with. This is
// already the behaviour on Windows; on Linux and macOS the menu would
// otherwise open under the pointer before a gesture could start.
pref("ui.context_menus.after_mouseup", true);

// Middle button. Upstream leaves autoscroll off on Linux and gives the button
// to X11 primary-selection paste instead; Mizu takes the Windows and macOS
// behaviour on every platform, so the button scrolls. The paste has to go with
// it: while middlemouse.paste is on it consumes the press and autoscroll never
// starts.
pref("general.autoScroll", true);
pref("middlemouse.paste", false);

// YouTube. Remove Shorts shelves and links, and open direct Shorts URLs in the
// standard watch page so they get the full Mizu player experience.
pref("mizu.youtube.remove-shorts", true);
// Activity Stream shows locally recorded, non-private video progress. The
// entry payload itself is stored in a user pref only after playback begins.
pref("mizu.continue-watching.enabled", true);
pref("mizu.continue-watching.max-items", 8);
// Keep the same bare-arrow seeking available in Firefox's floating PiP player.
pref("media.videocontrols.picture-in-picture.keyboard-controls.enabled", true);

// Mizu Video Player. These preferences are also editable from the settings
// panel inside the player, and apply to the next player that is opened.
pref("mizu.video.auto-open", true);
pref("mizu.video.seek-backward-seconds", 10);
pref("mizu.video.seek-forward-seconds", 10);
pref("mizu.video.volume-step-percent", 5);
pref("mizu.video.controls-timeout-ms", 2500);
pref("mizu.video.arrow-keys", true);
pref("mizu.video.space-key", true);
pref("mizu.video.media-keys", true);
pref("mizu.video.capture-keys", true);

// Subtitles and quality. The player reads both from the site's own media stack,
// because an adaptive stream keeps them in the manifest rather than in the
// video element. Preferred quality is a ceiling, not a demand: the closest
// rendition at or below it is chosen, and 0 leaves the site on automatic.
pref("mizu.video.preferred-quality", 1080);
pref("mizu.video.subtitle-scale-percent", 100);
pref("mizu.video.subtitle-colour", "white");
pref("mizu.video.subtitle-background", "soft");
pref("mizu.video.subtitle-edge", "outline");
pref("mizu.video.subtitle-font", "sans");
pref("mizu.video.subtitle-position-percent", 8);
// Turn a subtitle track on when the site handed over the video with none
// selected, preferring this language.
pref("mizu.video.subtitles-auto", true);
pref("mizu.video.subtitle-language", "en");

// Anime4K. The mode and quality names come from the upstream preset table:
// a, b, c, aa, bb, ca or dog, and S, M or L.
pref("mizu.video.anime4k-enabled", false);
pref("mizu.video.anime4k-mode", "a");
pref("mizu.video.anime4k-quality", "M");
pref("mizu.video.anime4k-strength-percent", 100);
pref("mizu.video.anime4k-max-source-height", 1080);
pref("mizu.video.anime4k-max-output-scale", 4);
pref("mizu.video.anime4k-frame-rate-limit", 0);
pref("mizu.video.anime4k-adaptive", true);
pref("mizu.video.anime4k-stats", false);
pref("mizu.video.anime4k-extras", "");

// The toolbar is taken out of layout flow, so it can no longer double as the
// window titlebar; drawing in the titlebar would leave an undraggable window.
pref("browser.tabs.inTitlebar", 0);
