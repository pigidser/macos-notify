#!/bin/sh
# Build a separate sender: macOS uses the sending app's icon, not a per-message icon.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest=${1:-"$HOME/Applications/Codex Notifier.app"}
test ! -e "$dest" && test ! -L "$dest" || { printf 'Already exists: %s\n' "$dest" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
app="$work/Codex Notifier.app"
/usr/bin/ditto "$root/vendor/Pi Notifier.app" "$app"
res="$app/Contents/Resources"
iconset="$work/Codex.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" "$root/vendor/codex/codex.svg" -o "$iconset/icon_${size}x${size}.png"
  double=$((size * 2))
  rsvg-convert -w "$double" -h "$double" "$root/vendor/codex/codex.svg" -o "$iconset/icon_${size}x${size}@2x.png"
done
/usr/bin/iconutil -c icns "$iconset" -o "$res/Codex.icns"
rm "$res/Pi.icns"
plist="$app/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleIdentifier -string fr.julienxx.oss.terminal-notifier.codex-notifier "$plist"
/usr/bin/plutil -replace CFBundleName -string 'Codex Notifier' "$plist"
/usr/bin/plutil -replace CFBundleDisplayName -string 'Codex Notifier' "$plist"
/usr/bin/plutil -replace CFBundleIconFile -string Codex "$plist"
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --strict "$app"
mkdir -p "$(dirname -- "$dest")"
/usr/bin/ditto "$app" "$dest"
/usr/bin/codesign --verify --strict "$dest"
printf '%s\n' "$dest"
