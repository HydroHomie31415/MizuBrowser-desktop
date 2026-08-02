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

// The toolbar is taken out of layout flow, so it can no longer double as the
// window titlebar; drawing in the titlebar would leave an undraggable window.
pref("browser.tabs.inTitlebar", 0);

