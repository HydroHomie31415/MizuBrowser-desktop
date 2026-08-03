# Mizu branding overlay

The sync script first copies `browser/branding/unofficial` from the pinned
Firefox checkout, then copies this directory over it. This guarantees that all
platform-specific artwork expected by the current Firefox revision exists.

Mizu provides original application icons and wordmarks for Linux releases.
Windows and macOS still inherit local-development assets; replace their ICO,
ICNS, installer, and asset-catalog files before distributing those platforms.
Keep `moz.build` and platform manifests in sync when updating the Firefox pin.
