# Mizu branding overlay

The sync script first copies `browser/branding/unofficial` from the pinned
Firefox checkout, then copies this directory over it. This guarantees that all
platform-specific artwork expected by the current Firefox revision exists.

The inherited artwork is for local development only. Before distribution,
replace the PNG, ICO, ICNS, macOS asset catalog, Windows installer bitmaps, and
private-browsing artwork using the same relative paths as Firefox's unofficial
branding directory. Keep `moz.build` and platform manifests in sync with
upstream when updating the pin.

