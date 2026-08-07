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

From a repository checkout, build and install its current state with one
command:

```bash
./install.sh
```

The equivalent `./mizu install` command follows the same pipeline. Every run
syncs the overlay, rebuilds the browser, refreshes the bundled extensions,
creates a uniquely versioned package in `dist/`, validates it, and asks pacman
to install that exact build. If the Firefox checkout does not exist yet, the
installer bootstraps it first.

Desktop launches use a persistent profile at
`~/.config/mizu-browser/profile`, separate from Firefox and from the temporary
development profile used by `./mizu run`. Set `MIZU_PROFILE=/path/to/profile`
when launching from a terminal to choose another location.

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
| `./mizu install` | Build and install the latest state of this checkout |
| `./mizu extensions` | Install the bundled extensions into the build |
| `./mizu run [args...]` | Run with a separate development profile |
| `./mizu package` | Produce a release-style archive |
| `./mizu arch-package VERSION` | Produce a pacman-installable Arch package |
| `./mizu clobber` | Clean the selected object directory |
| `./mizu upstream-check` | Compare the pin with upstream `FIREFOX_BRANCH` |
| `./mizu auto-update` | Rebuild against the newest upstream commit and stage a package |
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

The downloads button is placed in the icon row and kept there. Firefox keeps a
separate, much shorter set of default toolbar contents for vertical tabs which
leaves that button out, and Mizu turns vertical tabs on before a profile is ever
built — so left alone, no profile ever gets one, and the download progress
indicator and the downloads panel's anchor go with it. Mizu places it once per
profile and records that it has done so, so moving or removing it afterwards
sticks. It is also not auto-hidden until the first download of the session, the
way it is upstream: the column is off screen for most of the browser's life, so
a button that only exists while it is hidden is never seen.

A panel anchored inside the column reveals it, which is what puts the downloads
panel in the right place when a download starts while the column is away — arrow
panels follow their anchor, so it slides in with the column rather than hanging
off a point a column-width off screen.

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
| `mizu.chrome.downloads-button-placed` | `false` | Set once the downloads button has been placed; clear it to place it again |

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

## Same-network tab sync

Mizu keeps **one set of tabs** across this desktop and the companion mobile
browser while both devices are on the same private network. A tab from the
phone is an ordinary tab here, in the tab strip, in the command palette and in
the session that is restored at startup; a tab opened here is an ordinary tab
there. Closing one closes it on both devices, and navigating one moves the
other copy with it. There is no separate list of the other device's tabs,
because there is no other device's tabs.

What is not shared: private-window tabs, and pages that only mean something on
one device — `about:` pages, `file:` paths and extension URLs. A tab showing one
of those is simply not part of the set.

To pair the devices:

1. On desktop, press `Ctrl+Space`, search for **Pair a phone for tab sync**, and
   run it. Tab sync turns on and a pairing code appears, with the address, port
   and profile-specific token printed underneath it.
2. On mobile, open **Settings → Tab sync → Scan code** and point the camera at
   the desktop screen. The desktop dialog reports the device as soon as it syncs.
3. The two tab sets merge. Neither device's tabs are discarded to make room for
   the other's; from then on the set is shared.

Tabs that arrive from the other device are created unloaded, the way session
restore creates them: a phone with forty tabs costs this desktop forty rows in
the tab strip rather than forty page loads, and each one loads when it is first
selected.

Two rules cover the cases where "one shared tab" and "two devices" disagree:

- **A close outranks an edit.** A tab closed on the phone while the desktop was
  navigating it stays closed, rather than coming back on the next sync. Closing
  a *window* closes its tabs everywhere; quitting Mizu does not, so the phone
  keeps them and session restore brings them back here.
- **The page in front of you is never pulled out from under you.** If a tab is
  selected in the focused window, a navigation arriving for it from the other
  device is declined, and this device's URL for that tab wins instead.

The devices exchange the whole set and merge it, rather than sending changes,
so a phone that was out of range or switched off converges as soon as it is
back. Each tab carries a revision counter rather than a timestamp, because two
devices do not share a clock and a phone whose clock is a minute fast must not
win every conflict for a minute. Closed tabs are remembered for seven days, long
enough that the other device cannot reintroduce one it has not heard about yet.

The pairing code carries a `mizu://tabsync` URL, and nothing beyond it is needed
to connect:

```
mizu://tabsync?v=1&server=192.168.1.20%3A8765&token=<token>&name=<desktop>&alt=<host%3Aport,...>
```

`server` is the desktop's best address and `alt` carries the rest, so a phone
that cannot reach the first one tries the others before anyone types an address
in. The addresses come from the desktop's own network interfaces as well as from
resolving its host name: on a machine running Docker or a virtual machine, that
name frequently resolves to the bridge interface, which answers on the desktop
and nowhere else. Container and virtual-machine ranges are therefore ranked
behind ordinary LAN addresses, and IPv6 behind IPv4. A device that cannot scan can still be paired
by hand: the same address and token are on screen, and **Settings → Tab sync**
accepts them typed. Use **New token** in the pairing dialog to retire the
current token; every device paired with it stops syncing until it scans again.

The desktop listener is off by default, accepts only private/link-local source
addresses, and requires the pairing token on every request. The mobile client
also resolves and rejects non-private server addresses before sending that
token. The transport is local HTTP rather than Internet sync, so use it only on
a network you trust. Because the code is the credential, treat a photograph of
it the way you would treat the token itself.

The phone is the client and the desktop is the listener, so it is the phone that
connects. A phone with nothing to report and nothing to hear is left holding an
open request for up to 25 seconds rather than asking again every few seconds,
which is what makes a tab closed on one device disappear from the other as it
happens instead of on the next poll.

| Preference | Default | Purpose |
| --- | --- | --- |
| `mizu.tabsync.enabled` | `false` | Listen for paired devices on the LAN |
| `mizu.tabsync.port` | `8765` | LAN listener port |
| `mizu.tabsync.token` | generated | Long shared pairing credential |

The shared set lives in `mizu-tabsync.json` in the profile, so a tab closed on
the phone while Mizu was shut down is still closed when it starts again.

Commands include creating and restoring tabs, opening windows, pinning,
muting, bookmarking, opening the Places libraries, settings and fullscreen.
Selecting a tab in another window focuses that existing window instead of
opening a duplicate.

| Preference | Default | Purpose |
| --- | --- | --- |
| `mizu.palette.enabled` | `true` | Enable the palette and its shortcut |
| `mizu.palette.max-results` | `14` | Maximum number of visible search results |
| `mizu.palette.open-on-new-tab` | `true` | Open the palette on a newly selected new-tab page |

## Mouse gestures

Hold the right button over a page and draw. The stroke is drawn back over the
content and the action it resolved to is named underneath it; releasing the
button runs it, and the context menu that would have followed is withheld. A
stroke that matches nothing still shows what Mizu read, so a gesture that does
nothing is visibly a gesture that is not bound rather than one that failed.

| Stroke | Action | Stroke | Action |
| --- | --- | --- | --- |
| ← | Back | ↑ | Scroll to top |
| → | Forward | ↓ | Scroll to bottom |
| ↑↓ | Reload | ↓↑ | New tab |
| ↓→ | Close tab | ↓← | Reopen closed tab |
| ↑← | Previous tab | ↑→ | Next tab |
| →↑ | Duplicate tab | →↓ | Bookmark page |

Two gestures need no drawing. Holding one button and clicking the other is a
rocker: right-then-left goes back, left-then-right goes forward. Holding the
right button and turning the wheel moves through the tabs.

Recognition happens in the chrome process rather than in the page, which is
what an add-on cannot do. A stroke is one stroke even when it crosses a
cross-origin frame, a scrollbar or a page that swallows mouse events, the trail
is drawn on chrome the page cannot style or cover, and gestures keep working
where extension content scripts are not allowed to run.

Actions are command names, and they are the same names Firefox's own touchpad
gestures use: the id of a XUL `<command>` such as `cmd_close` or
`Browser:NextTab`, or a controller command such as `cmd_scrollTop`. So any
gesture can be pointed at anything either mechanism can reach, whether or not
Mizu ships a default for it. A stroke is spelled with `U`, `D`, `L` and `R` in
the order it is drawn, up to eight directions, so creating the string
preference `mizu.gestures.pattern.ULD` adds that gesture. Setting one to an
empty string removes it.

### Changing them

Settings has a Mouse gestures section listing every gesture with a menu of
actions beside it. **Record a gesture** arms the browser and takes the next
stroke you draw; give it an action and it is bound. Setting a gesture's action
to a dash removes it.

Recording is done by the browser rather than by the settings page, so the
stroke is read by the same recogniser that will interpret it later, at the same
threshold. A gesture therefore cannot be recorded in a form the browser goes on
to read as something else.

The pane is a view onto the preferences and nothing more, so `about:config`
remains an equal way in and the two never disagree. To bind a stroke by hand,
draw it first: one that nothing is bound to shows its own code rather than an
action name, and that code is exactly what goes after `mizu.gestures.pattern.`
— so drawing up, left, down reads `↑←↓  ULD`, and creating the string
preference `mizu.gestures.pattern.ULD` with a value of `Browser:Screenshot`
binds it. That is also the way to reach a command the menu does not offer; the
pane keeps such a gesture listed and selected rather than rewriting it. New
bindings take effect on the next gesture, and nothing needs restarting.

| Preference | Default | Purpose |
| --- | --- | --- |
| `mizu.gestures.enabled` | `true` | Enable gestures, in both processes |
| `mizu.gestures.button` | `2` | Which button draws, as a `MouseEvent` button |
| `mizu.gestures.stroke-threshold` | `24` | Travel in pixels before a direction joins the stroke |
| `mizu.gestures.rocker` | `true` | Hold one button and click the other |
| `mizu.gestures.wheel` | `true` | Hold the gesture button and turn the wheel |
| `mizu.gestures.trail` | `true` | Draw the stroke over the page |
| `mizu.gestures.trail-width` | `3` | Trail width in pixels |
| `mizu.gestures.trail-colour` | `#5ab9e0` | Trail colour |
| `mizu.gestures.status` | `true` | Name the action the stroke resolved to |
| `mizu.gestures.pattern.*` | see above | Command run by one stroke |
| `mizu.gestures.rocker.back` | `Browser:BackOrBackDuplicate` | Right held, left clicked |
| `mizu.gestures.rocker.forward` | `Browser:ForwardOrForwardDuplicate` | Left held, right clicked |
| `mizu.gestures.wheel.up` | `Browser:PrevTab` | Gesture button held, wheel up |
| `mizu.gestures.wheel.down` | `Browser:NextTab` | Gesture button held, wheel down |

`mizu.gestures.recording` and `mizu.gestures.recorded` are how the settings
pane asks for a stroke and is handed one; they are not settings.

Mizu also defaults `ui.context_menus.after_mouseup` to `true`, so the context
menu opens when the right button is released rather than when it is pressed.
That is already how Windows behaves; without it, Linux and macOS open the menu
under the pointer before a stroke can begin, and gestures cannot work at all.
The cost is that a menu can no longer be used in one press-drag-release motion.

One thing a page can still take: gestures are recognised anywhere in the
content area, but the input a gesture consumes is only withheld from the frame
the button was pressed in. A stroke begun in the page and released over an
embedded frame still runs its command, and Firefox's context menu is still
withheld, but that frame's own `contextmenu` handler may draw a menu of its
own.

## Video player

Mizu detects HTML video in the selected tab, including videos in site frames,
and opens a playing video in Mizu Video Player automatically. Automatic opening
is disabled on YouTube, Netflix and Prime Video/Amazon video pages so those
services retain their own players. When a video is present, the video-player
toolbar button becomes active; while it is playing, the icon uses the attention
colour. Click the button, press `Alt+Shift+V`, or right-click a video to toggle
Mizu Video Player manually, including on an automatically excluded site.
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
| `mizu.video.auto-open` | `true` | Open playing videos automatically, except on excluded services |
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

Mizu also ships SponsorBlock, DeArrow and YouTube Anti Translate as pinned,
Mozilla-hosted add-ons. SponsorBlock skips community-reported sponsors, intros,
outros and other configured segment categories. DeArrow replaces sensational
titles and thumbnails with community-written alternatives. YouTube Anti
Translate restores original titles, descriptions, chapters, thumbnails and
audio tracks instead of YouTube's automatically translated or dubbed versions.
All three remain ordinary add-ons and can be configured or disabled from
`about:addons`.

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

## Continue watching

After 15 seconds of a video that is at least one minute long, Mizu records its
page, title, thumbnail, duration and current position in the local profile. The
Mizu start page presents the eight most recent unfinished videos as a
**Continue watching** shelf with progress bars and elapsed times. YouTube cards
resume at the saved timestamp; other sites reopen their video page and can use
their own resume mechanism.

Completed videos disappear when playback reaches the final 5% or last 30
seconds. Private windows neither read nor write the list. Set
`mizu.continue-watching.enabled` to `false` to disable collection and the shelf,
or change `mizu.continue-watching.max-items` to keep between one and 24 cards.

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
track carries no cues the player mirrors that renderer into its own overlay.
The live element stays in the site player that owns it while its rendered lines
and offsets are copied over the video. Canvas-based ASS renderers cannot be
mirrored, so their canvas wrapper is adopted instead. The subtitle menu says
which path is in use, or that nothing was found at all, so a site keeping its
subtitles out of reach is visible rather than silent.

Taking the video over also leaves nothing selected, because the site's UI was
what had the track switched on. `mizu.video.subtitles-auto` turns one back on,
preferring `mizu.video.subtitle-language`.

Cues are drawn by the player rather than by the video element. When a native
text track exists, the chosen track is switched to `hidden` -- which still fires
`cuechange` -- and its cues are rendered into the player's own overlay through
`getCueAsHTML`. That is what makes the size, colour, background, edge, typeface
and position settings possible. Players that never create a text track at all
are handled through the mirrored DOM or adopted canvas path described above.
JW Player is a special case: its caption renderer freezes when its video leaves
the JW container even if the caption element stays there. Mizu therefore fetches
JW's selected WebVTT file with a size limit, exposes it to Gecko through a
short-lived blob-backed `<track>`, and uses Gecko's cue timing instead.

Selecting a track asks the site's player first, since only it can fetch a
rendition that has not loaded yet, and then maps the same choice onto the text
tracks by language, or by position when both lists describe the same set. The
site's answer is never assumed to arrive. DOM renderers remain connected to the
site and are mirrored with a mutation observer. Blob-backed JW tracks are
removed and their URLs revoked as soon as Mizu closes.

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

Mizu ships uBlock Origin, Bitwarden Password Manager, SponsorBlock, DeArrow and
YouTube Anti Translate. They are pinned in `config/extensions.env` by version and SHA-256, the same way
`config/upstream.env` pins Firefox, and downloaded during `./mizu build` rather
than committed — so this repository stays source-only and the build stays
reproducible. `./mizu extensions` installs them on its own if you only want to
refresh the add-ons and browser policies.

The pinned file is the **Mozilla-signed** build published by the extension's
author. That matters: it installs with `xpinstall.signatures.required` left at
its default, so bundling an extension does not mean weakening signature
enforcement. Repackaging or modifying the XPI would break the signature — and
redistributing a modified add-on under its original name is a trademark problem
on top of a technical one.

Each XPI is copied to `distribution/extensions/<add-on id>.xpi` in the build.
Firefox installs add-ons found there into each new profile at first run, so the
bundled extensions arrive **enabled** but stay ordinary add-ons: they appear in
`about:addons`, update themselves from addons.mozilla.org, and can be disabled
or removed. Once removed, Firefox records that in
`extensions.installedDistroAddon.<id>` and will not reinstall it.

`config/policies.json` disables Firefox's built-in password manager so it does
not compete with Bitwarden, and suppresses the automatic translation panel.
Translation itself remains available from the address bar and application menu.

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

uBlock Origin is licensed GPL-3.0-or-later, Bitwarden is GPL-3.0-only,
SponsorBlock and DeArrow are LGPL-3.0-only, and YouTube Anti Translate is MIT.
They can be redistributed alongside an MPL-2.0 browser as separate, unmodified
programs. A public Mizu release must ship their license texts and satisfy each
add-on's corresponding-source obligations.

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

### Unattended updates

Mizu is a source fork, so there is no binary update to download. Mozilla's
signed MAR updates carry stock Firefox binaries and would overwrite every Mizu
patch, which is why the in-tree updater stays disabled. Staying current instead
means re-pinning, re-applying the patches, and rebuilding.

```bash
./mizu auto-update
```

`auto-update` resolves the newest commit on `FIREFOX_BRANCH`, builds it in a
throwaway checkout under `.cache/auto-update/`, and stages a verified package in
`dist/`. It never touches the installed browser or the interactive `firefox/`
checkout, and it stops at the first failure:

1. **Patch gate.** Every patch must apply to the candidate revision. This is the
   expected failure as upstream drifts, and it is reported as patches needing a
   rebase rather than as a crash. Nothing is built until it passes.
2. **Smoke test.** The new binary must report its version and paint a headless
   screenshot, so a build that cannot start never reaches `dist/`.
3. **Staging.** On success the pin is rewritten (`--no-pin` skips this) and the
   two newest packages are kept, so the previous build stays available to roll
   back to.

Install the staged package yourself:

```bash
sudo pacman -U dist/mizu-browser-*.pkg.tar.zst
```

Run it daily with the bundled user timer:

```bash
install -Dm644 -t ~/.config/systemd/user packaging/systemd/mizu-auto-update.*
systemctl --user daemon-reload
systemctl --user enable --now mizu-auto-update.timer
```

Check on it with `./mizu status`, `systemctl --user list-timers`, or the logs in
`.cache/auto-update/logs/`.

**Choosing a branch.** `FIREFOX_BRANCH` defaults to `release`, the stabilized
line Mozilla's security advisories map to. `main` is mozilla-central (Nightly):
newer code, but unreviewed and not a security-patch stream. Artifact builds
support both — `releases/mozilla-release` is the default artifact tree — so the
daily cadence is affordable either way. Patches are written against whichever
branch you develop on, and will not apply to the other until rebased.

## Distribution checklist

1. Replace placeholder icons and installer artwork with original Mizu art.
2. Configure and sign a Mizu-owned update service; updates start disabled.
3. Add code signing and notarization for each target platform.
4. Review Mozilla's trademark policy and MPL-2.0 source obligations.
5. Ship every bundled add-on's license text and provide corresponding source
   where its license requires it.
6. Publish the exact source revision, overlay, patches, and build config.
7. Add automated browser tests and a rapid security-update process.

Firefox build documentation is at
<https://firefox-source-docs.mozilla.org/setup/>.

## License

Mizu files in this repository are licensed under the Mozilla Public License
2.0. Firefox remains copyright its respective contributors and is also made
available under MPL-2.0. See [LICENSE](LICENSE).
