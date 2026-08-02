# Mizu Browser

Mizu is a desktop browser built from Mozilla Firefox. This repository is a
small, reviewable product layer: it pins Firefox upstream, carries Mizu's
branding and defaults, and provides one command for the usual development
tasks. The generated Firefox checkout and its build artifacts are deliberately
not committed here.

> [!IMPORTANT]
> Mizu is an independent project. Do not ship Mozilla trademarks or connect a
> public release to Mozilla's update infrastructure. The initial icon set is
> copied from Firefox's **unofficial local-build branding** as a placeholder;
> replace it before distributing Mizu.

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
