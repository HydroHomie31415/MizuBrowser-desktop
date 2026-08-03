# Mizu Browser

Mizu is a desktop browser built from Mozilla Firefox. This repository is a
small, reviewable product layer: it pins Firefox upstream, carries Mizu's
branding and defaults, and provides one command for the usual development
tasks. The generated Firefox checkout and its build artifacts are deliberately
not committed here.

> [!IMPORTANT]
> Mizu is an independent project. Do not ship Mozilla trademarks or connect a
> public release to Mozilla's update infrastructure. Mizu's Linux artwork is
> original to this project; Windows and macOS releases still need replacement
> installer and application artwork before distribution.

## Requirements

- A 64-bit Linux, macOS, or Windows environment supported by Firefox
- Git, Bash, Python 3.9+, and `pip3`
- At least 30 GB free disk space and 8 GB RAM recommended
- A fast connection; the Firefox checkout and build dependencies are large

On this Arch Linux host, install the currently missing Python package tool with
`sudo pacman -S python-pip` before running `bootstrap`.

On Windows, run these commands in MozillaBuild rather than PowerShell. WSL can
build the Linux version, not a native Windows installer.

## Quick start

```bash
./mizu doctor
./mizu bootstrap
./mizu build
./mizu run
```

`bootstrap` downloads the Firefox revision in `config/upstream.env`, installs
Mozilla's build prerequisites (it may prompt for elevated privileges), and
installs the Mizu product files into the generated checkout.

The default is an artifact build. It reuses Mozilla's precompiled Gecko and is
usually the right mode for UI, JavaScript, CSS, preferences, and branding work.
Because it also reuses Mozilla's native launcher, the executable basename stays
`firefox` in this mode even though the browser uses Mizu branding and its own
profile and application ID. A full build produces the renamed `mizu` executable.
Use a full build when changing C++, Rust, WebIDL, or low-level build files:

```bash
MIZU_BUILD_MODE=full ./mizu bootstrap
MIZU_BUILD_MODE=full ./mizu build
MIZU_BUILD_MODE=full ./mizu run
```

## Install on Arch Linux

Tagged releases include a native pacman package for x86-64 Arch Linux. Install
or upgrade the latest release with:

```bash
sudo pacman -U https://github.com/HydroHomie31415/MizuBrowser-desktop/releases/latest/download/mizu-browser-x86_64.pkg.tar.zst
```

To publish a release, push a version tag such as `v0.1.0`. GitHub Actions builds
Mizu, creates the Arch package, publishes its SHA-256 checksum, and attaches both
the versioned package and the stable `mizu-browser-x86_64.pkg.tar.zst` download
to the GitHub release. The workflow can also be run manually to test packaging
without publishing a release.

To package an existing local build instead, run `./mizu arch-package 0.1.0`.
The resulting package is written to `dist/` and can be installed with
`sudo pacman -U dist/mizu-browser-0.1.0-1-x86_64.pkg.tar.zst`.

## Commands

| Command | Purpose |
| --- | --- |
| `./mizu doctor` | Check prerequisites and available disk space |
| `./mizu fetch` | Download pinned Firefox source without installing tools |
| `./mizu bootstrap` | Fetch source and run Mozilla's prerequisite installer |
| `./mizu sync` | Reinstall Mizu's overlay into the Firefox checkout |
| `./mizu build` | Sync and build Mizu |
| `./mizu extensions` | Install the bundled extensions into the build |
| `./mizu run [args...]` | Run with a separate development profile |
| `./mizu package` | Produce a release-style archive |
| `./mizu arch-package VERSION` | Produce a pacman-installable Arch package |
| `./mizu clobber` | Clean the selected object directory |
| `./mizu upstream-check` | Compare the pin with upstream `main` |
| `./mizu status` | Show configuration, checkout, and source changes |
| `./mizu test` | Validate this repository without downloading Firefox |

Set `MIZU_BUILD_MODE` to `artifact` (default) or `full`. Set
`MIZU_DEV_PROFILE` to use a different development profile directory.

## The chrome column

Mizu's default layout is a single vertical column: the address bar sits at the
top of the tab sidebar rather than in a toolbar spanning the window, and the
column is docked to one window edge. The column is taken out of layout flow and
slid off-screen, so the content area keeps the whole window; it slides back in,
floating over the page, while the pointer is near its edge. The page never
reflows, so nothing shifts when chrome appears.

The column also reveals itself whenever it takes focus, so `Ctrl+L`, `F6` and
keyboard navigation work as usual, and it stays put while it holds focus or has
a panel anchored to it. Mizu stands down inside native fullscreen, which has
Firefox's own auto-hide, and in customize mode.

The column has three rows: the toolbar buttons, then the address bar, then the
tabs. It is built by moving `#navigator-toolbox` into `#sidebar-container`, and
`#urlbar-container` up one level from `#nav-bar-customization-target` into
`#nav-bar`. Both moves are deliberately small, because three things depend on
the tree staying intact:

- `navigator-toolbox.js` delegates `mousedown` **from `#navigator-toolbox`** to
  drive the extensions, account, library, downloads, page-action, firefox-view
  and all-tabs buttons. Anything moved out of the toolbox stops receiving that
  event and silently does nothing — no error, the button just dies.
- The address bar only gets its breakout popover — the focused state the
  floating panel is built on — when `closest("toolbar")` finds an ancestor. It
  therefore has to stay inside `#nav-bar`.
- It still has to leave `#nav-bar-customization-target`, which is only as wide
  as the overflow and menu buttons leave it, to get a full-width row.

Positioning separate elements to *look* like one column instead means competing
with upstream's sidebar layout rules on every Firefox update, and losing; the
rows are arranged with `flex-wrap` and `order` inside the real toolbar instead.
Both nodes are moved back before customize mode, which needs the real layout,
and the restore is exact — each remembers its original parent and next sibling,
and they are reinserted in reverse order so those siblings are already in place.

Focusing the address bar expands it into a panel centred over the content
rather than a 320px slot. Firefox already promotes the focused address bar to a
popover, which puts it in the top layer, so it is laid out against the viewport
and is neither clipped nor shifted by the column it lives in — Mizu only says
where. Note that `UrlbarInput` assigns `style.top` inline to pin that popover
over the address bar's slot, so overriding the position needs `!important`; no
selector can outrank an inline style.

Back, forward and stop/reload are hidden, since the icon row is narrow and they
have the most alternatives: `Alt+Left`/`Alt+Right`, the mouse side buttons, the
touchpad swipe and the content context menu. To get them back, delete that rule
from `browser-mizu-autohide.css`.

Vertical tabs are Firefox's own feature; the column and the hiding are Mizu's.
They live in `overlay/browser/base/content/browser-mizu-autohide.js` and
`overlay/browser/themes/shared/browser-mizu-autohide.css`, with
`patches/0002-add-mizu-autohide-chrome.patch` packaging and loading them.
Pointer tracking goes through Firefox's `MousePosTracker` because `:hover` does
not fire while the pointer is over web content.

| Preference | Default | Purpose |
| --- | --- | --- |
| `mizu.chrome.column` | `true` | Stack the address bar on top of the vertical tabs |
| `mizu.chrome.autohide` | `true` | Slide the column away until the pointer reaches its edge |
| `mizu.chrome.column-width` | `320` | Column width in pixels |
| `mizu.chrome.urlbar-float` | `true` | Expand the focused address bar into a centred panel |
| `mizu.chrome.trigger-size` | `4` | Width in pixels of the reveal strip at the window edge |
| `mizu.chrome.hide-delay-ms` | `120` | Grace period before the column slides away again |

Changes take effect immediately in open windows. Set `mizu.chrome.autohide` to
`false` to keep the column permanently on screen, or `mizu.chrome.column` to
`false` to get stock Firefox layout back.

## Unified command palette

Press `Ctrl+Space` from any browser window to search and operate Mizu
without opening its chrome column. The palette searches recently used tabs in
every Mizu window, browsing history, bookmarks and browser commands. A normal
query also offers a web search through the current default search engine.

The result list is fully keyboard navigable with the arrow, Home, End, Page Up,
Page Down, Enter and Escape keys. Prefix a query to restrict its source:

| Prefix | Results |
| --- | --- |
| `>` | Browser commands |
| `@` | Open tabs across all Mizu windows |
| `^` | History and bookmarks |

Commands include creating and restoring tabs, opening windows, pinning,
muting, bookmarking, opening the Places libraries, settings and fullscreen.
Selecting a tab in another window focuses that existing window instead of
opening a duplicate.

| Preference | Default | Purpose |
| --- | --- | --- |
| `mizu.palette.enabled` | `true` | Enable the palette and its shortcut |
| `mizu.palette.max-results` | `14` | Maximum number of visible search results |
| `mizu.palette.open-on-new-tab` | `true` | Open the palette on a newly selected new-tab page |

## Video player

Mizu detects HTML video in the selected tab, including videos in site frames.
When a video is present, the video-player toolbar button becomes active; while
it is playing, the icon uses the attention colour. Click the button, press
`Alt+Shift+V`, or right-click a video and choose **Open in Mizu Video Player**.
The player reuses the page's live video element instead of reopening its URL,
so authenticated streams, site-selected quality, subtitles and DRM playback
keep working. Closing the player returns the element to its exact old position.

The player follows Firefox's dark control styling and includes timeline,
volume, captions, playback speed, Picture-in-Picture, fullscreen and keyboard
controls. Its settings panel changes seek distances, volume increments, control
timeout, keyboard handling, and Anime4K defaults. The settings are persisted as
preferences and used by later player sessions.

| Preference | Default | Purpose |
| --- | --- | --- |
| `mizu.video.seek-backward-seconds` | `10` | Left-arrow/back button seek distance |
| `mizu.video.seek-forward-seconds` | `10` | Right-arrow/forward button seek distance |
| `mizu.video.volume-step-percent` | `5` | Up/down-arrow volume increment |
| `mizu.video.controls-timeout-ms` | `2500` | Delay before idle controls fade |
| `mizu.video.arrow-keys` | `true` | Let left/right arrows seek |
| `mizu.video.space-key` | `true` | Let Space play and pause |
| `mizu.video.media-keys` | `true` | Handle media play and track keys |
| `mizu.video.capture-keys` | `true` | Stop the site seeing keys the player handled |
| `mizu.video.anime4k-enabled` | `false` | Start GPU upscaling automatically |

The player has to coexist with the site's own player. Those players bind
handlers to the document, so Mizu keeps its own fullscreen changes and
keystrokes from reaching them, and puts the video back if the page re-parents or
hides it. Fullscreen targets the player's own host rather than "whatever is
fullscreen", and when the video sits in an embed whose iframe was never marked
`allowfullscreen`, the chrome process promotes the embedding frame instead.

Silencing one document is not enough when the video is in a third-party embed.
Gecko makes the embedding `<iframe>` the fullscreen element of every ancestor
document as well, and the streaming sites built around the MegaPlay embed watch
for exactly that: on seeing it, they move fullscreen onto a wrapper of their
own a moment later. The embed then stops being the fullscreen element while the
player inside it still believes it is, which is what produced a black screen.
So a player running in a subframe asks the chrome process to install the same
event guard in every ancestor document, for as long as the player is open --
lazily installing it on entering fullscreen would lose the race against the
page's own handler.

## YouTube core

Mizu removes Shorts from YouTube's home, search, subscription, channel and
navigation surfaces. Opening a direct `/shorts/` link redirects to the normal
watch page, preserving the video id and URL parameters, so the video has a
timeline and can be opened in Mizu Video Player. Set
`mizu.youtube.remove-shorts` to `false` to restore Shorts.

When YouTube's in-page miniplayer is active, bare `Left` and `Right` arrows seek
backward and forward using Mizu's configured seek intervals. The same shortcuts
remain enabled in Firefox's floating Picture-in-Picture player. Text fields and
modified arrow combinations keep their normal behaviour.

The media bridge talks directly to YouTube's live player when Mizu Video Player
is open. Quality and caption menus use YouTube's current renditions, chapter
buttons seek through creator or automatic chapters, and playlist buttons move
between videos without rebuilding the stream. YouTube's playback shortcuts are
also available inside Mizu's player:

| Shortcut | Action |
| --- | --- |
| `J` / `L` | Seek backward or forward 10 seconds |
| `K` or `Space` | Play or pause |
| `0`-`9` | Seek to 0%-90% |
| `,` / `.` | Step one frame while paused |
| `<` / `>` | Decrease or increase playback speed |
| `Ctrl+Left` / `Ctrl+Right` | Previous or next chapter |
| `Shift+P` / `Shift+N` | Previous or next playlist video |
| `C` | Toggle captions |
| `I` | Toggle Picture-in-Picture |
| `F` | Toggle fullscreen |

### Subtitles and quality

A plain `<video>` has no notion of quality, and an adaptive stream keeps its
subtitles in the manifest rather than in the element, so neither is the player's
to read directly. `MizuMediaBridge.sys.mjs` asks the site's own media stack
instead -- JW Player's API, an hls.js instance, then the element's text tracks --
and everything it reads back is treated as untrusted: only primitives cross in
either direction, and every call is wrapped so that a site throwing from a
getter cannot take the player with it. Page objects are reached through waived
Xrays, which is the only way an instance a site hung off its video element is
visible at all.

Not every player leaves anything to read. Some parse the subtitle file
themselves and draw into a div beside the video's container, so when the text
track carries no cues the player adopts that element instead, slotting it over
the video and leaving its own offsets alone -- a caption layer positions itself,
and overriding that stacks every line at the top of the frame. The subtitle menu
says which of the two is in use, or that nothing was found at all, so a site
keeping its subtitles out of reach is visible rather than silent.

Taking the video over also leaves nothing selected, because the site's UI was
what had the track switched on. `mizu.video.subtitles-auto` turns one back on,
preferring `mizu.video.subtitle-language`.

Cues are drawn by the player rather than by the video element. The element now
belongs to the player, and the site's caption layer was left behind in the page
where nothing can see it, so the chosen track is switched to `hidden` -- which
still fires `cuechange` -- and its cues are rendered into the player's own
overlay through `getCueAsHTML`. That is what makes the size, colour, background,
edge, typeface and position settings possible. Players that never create a text
track at all, because they parse the subtitle file themselves, are handled by
adopting their caption element into the player instead.

Selecting a track asks the site's player first, since only it can fetch a
rendition that has not loaded yet, and then maps the same choice onto the text
tracks by language, or by position when both lists describe the same set. The
site's answer is never assumed to arrive.

Preferred quality is a ceiling rather than a demand: the closest rendition at or
below it is selected once per source, so playback does not spend its first
seconds climbing up from the lowest rendition. `0` leaves the site on automatic.

## Anime4K

Anime4K runs as a full mpv-shader pipeline rather than a single hardcoded model.
`Anime4KProgram.sys.mjs` translates the upstream `.glsl` hook syntax (`//!HOOK`,
`//!BIND`, `//!SAVE`, `//!WIDTH`, `//!WHEN` and the reverse-polish size
expressions) into WebGL2 programs, and works out per frame which passes run and
how large each render target is. That is what makes `//!WHEN`-gated behaviour
such as `AutoDownscalePre` work: a 720p source shown on a 4K display upscales
x2, downscales to half the display size, then upscales x2 again, exactly as mpv
would. Dropping another Anime4K `.glsl` into `browser/actors/anime4k/` and naming
it in `Anime4KLibrary.sys.mjs` is all that adding a model takes.

| Setting | Default | Purpose |
| --- | --- | --- |
| `mizu.video.anime4k-mode` | `a` | `a`, `b`, `c`, `aa`, `bb`, `ca` or `dog` |
| `mizu.video.anime4k-quality` | `M` | Model size: `S`, `M` or `L` |
| `mizu.video.anime4k-strength-percent` | `100` | Blend back towards the untouched frame |
| `mizu.video.anime4k-max-source-height` | `1080` | Leave higher-resolution sources alone |
| `mizu.video.anime4k-max-output-scale` | `4` | Upper bound on the upscale factor |
| `mizu.video.anime4k-frame-rate-limit` | `0` | Process at most this many frames a second |
| `mizu.video.anime4k-adaptive` | `true` | Step down a quality tier when frames run late |
| `mizu.video.anime4k-stats` | `false` | Show the performance overlay |
| `mizu.video.anime4k-extras` | `""` | Extra passes: `clamp`, `deblur`, `thin`, `darken` |

The modes are upstream's: A restores then upscales, B uses the softer restore
model for blurry sources, C denoises while upscaling, and A+A, B+B and C+A add
the second restore pass. `dog` is the non-neural fallback for weak GPUs.

Two failure modes are handled rather than reported. A lost WebGL context (which
a fullscreen transition can cause) hides the canvas and rebuilds the pipeline,
so the untouched video keeps playing instead of leaving a black screen; the same
happens while shader programs are still compiling. Protected media and
cross-origin video without CORS permission cannot be copied into a GPU texture
at all, and playback falls back rather than being interrupted.

The vendored Anime4K models keep their own upstream copyright and licence
notices and are pinned to a single upstream revision, checked by `./mizu test`.
Mizu's WebGL2 adapter is covered by this repository's MPL-2.0 license.

Two performance rules matter when changing this code, because both failures are
invisible on a fast machine and felt everywhere on a slow one. `MousePosTracker`
calls `getMouseTargetRect` on every mouse move, so nothing on that path may
flush layout — `window.innerWidth` and `innerHeight` do, which is why all
geometry is cached and refreshed only on resize and reveal. And only `transform`
and `opacity` are ever transitioned; animating a layout property such as
`inset-block-start` reflows the window every frame.

Because the toolbar no longer occupies the top of the window, Mizu also sets
`browser.tabs.inTitlebar` to `0` — drawing tabs into the titlebar would leave
the window with no draggable region.

## Bundled extensions

Mizu ships uBlock Origin. It is pinned in `config/extensions.env` by version and
SHA-256, the same way `config/upstream.env` pins Firefox, and downloaded during
`./mizu build` rather than committed — so this repository stays source-only and
the build stays reproducible. `./mizu extensions` installs it on its own if you
only want to refresh the add-ons.

The pinned file is the **Mozilla-signed** build published by the extension's
author. That matters: it installs with `xpinstall.signatures.required` left at
its default, so bundling an extension does not mean weakening signature
enforcement. Repackaging or modifying the XPI would break the signature — and
redistributing a modified add-on under its original name is a trademark problem
on top of a technical one.

The XPI is copied to `distribution/extensions/<add-on id>.xpi` in the build.
Firefox installs add-ons found there into each new profile at first run, so
uBlock Origin arrives **enabled** but stays an ordinary add-on: it appears in
`about:addons`, updates itself from addons.mozilla.org, and can be disabled or
removed. Once removed, Firefox records that in
`extensions.installedDistroAddon.<id>` and will not reinstall it.

Two consequences worth knowing:

- Distribution add-ons are only installed when the add-on manager checks for
  changes, which means a **new profile or a changed build**. An existing profile
  will not pick up a newly bundled extension until the next build; verified by
  running the same build against a fresh and a pre-existing profile.
- The add-on ID in the config must match the ID inside the XPI, because Firefox
  identifies these by filename. `./mizu extensions` reads the ID out of the
  XPI's own `manifest.json` and fails if the two disagree, rather than silently
  installing a second copy under the wrong ID.

To update a pinned extension, change its version, run
`./mizu extensions --update-checksum` to print the new digest, paste it into
`config/extensions.env`, and commit both.

uBlock Origin is licensed GPL-3.0-or-later, which is compatible with
redistributing it alongside an MPL-2.0 browser as a separate, unmodified
program. Distributing Mizu with it bundled carries the GPL's obligations for
that add-on: ship its license text and make its corresponding source available.
Add both to the distribution checklist below before any public release.

## Repository layout

```text
config/                pinned upstream and mozconfig files
overlay/               files copied over the generated Firefox checkout
patches/               reviewed patches for changes that cannot be overlaid
scripts/               fetch, build, update, and validation tooling
firefox/               generated upstream checkout (ignored)
mizu                   command entrypoint
```

Brand strings and product defaults live under
`overlay/browser/branding/mizu`. During `sync`, the scripts first copy
Firefox's unofficial branding directory so every platform-specific asset is
present, then apply the tracked Mizu files. Put replacement icons at matching
paths in the overlay to override the placeholders.

For changes to existing Firefox files, generate a patch from the checkout and
place it in `patches/`:

```bash
git -C firefox diff -- path/to/file > patches/0001-description.patch
./mizu sync
```

Patches are applied in filename order and skipped when already applied.

## Updating Firefox

```bash
./mizu upstream-check
```

After reviewing Firefox release and security notes, replace
`FIREFOX_REVISION` in `config/upstream.env` with the reported commit, then run
`./mizu fetch` and `./mizu build`. Fetch will not switch revisions while
tracked upstream files have local changes.

## Distribution checklist

1. Replace placeholder icons and installer artwork with original Mizu art.
2. Configure and sign a Mizu-owned update service; updates start disabled.
3. Add code signing and notarization for each target platform.
4. Review Mozilla's trademark policy and MPL-2.0 source obligations.
5. Ship uBlock Origin's GPL-3.0 license text and offer its corresponding source.
6. Publish the exact source revision, overlay, patches, and build config.
7. Add automated browser tests and a rapid security-update process.

Firefox build documentation is at
<https://firefox-source-docs.mozilla.org/setup/>.

## License

Mizu files in this repository are licensed under the Mozilla Public License
2.0. Firefox remains copyright its respective contributors and is also made
available under MPL-2.0. See [LICENSE](LICENSE).
