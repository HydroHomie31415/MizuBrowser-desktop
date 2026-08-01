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
| `./mizu run [args...]` | Run with a separate development profile |
| `./mizu package` | Produce a release-style archive |
| `./mizu clobber` | Clean the selected object directory |
| `./mizu upstream-check` | Compare the pin with upstream `main` |
| `./mizu status` | Show configuration, checkout, and source changes |
| `./mizu test` | Validate this repository without downloading Firefox |

Set `MIZU_BUILD_MODE` to `artifact` (default) or `full`. Set
`MIZU_DEV_PROFILE` to use a different development profile directory.

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
5. Publish the exact source revision, overlay, patches, and build config.
6. Add automated browser tests and a rapid security-update process.

Firefox build documentation is at
<https://firefox-source-docs.mozilla.org/setup/>.

## License

Mizu files in this repository are licensed under the Mozilla Public License
2.0. Firefox remains copyright its respective contributors and is also made
available under MPL-2.0. See [LICENSE](LICENSE).
