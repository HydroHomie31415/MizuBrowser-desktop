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

// YouTube. Remove Shorts shelves and links, and open direct Shorts URLs in the
// standard watch page so they get the full Mizu player experience.
pref("mizu.youtube.remove-shorts", true);
// Keep the same bare-arrow seeking available in Firefox's floating PiP player.
pref("media.videocontrols.picture-in-picture.keyboard-controls.enabled", true);

// Mizu Video Player. These preferences are also editable from the settings
// panel inside the player, and apply to the next player that is opened.
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
