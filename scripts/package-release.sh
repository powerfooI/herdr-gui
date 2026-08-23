#!/usr/bin/env bash
set -euo pipefail

platform="${1:-linux-x64}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(
  cd "$root_dir"
  bun -e 'console.log(require("./package.json").version)'
)"

binary_name="herdr-gui"
case "$platform" in
  darwin-arm64)
    build_script="build:darwin-arm64"
    binary="$root_dir/server/herdr-gui-darwin-arm64"
    ;;
  darwin-x64)
    build_script="build:darwin-x64"
    binary="$root_dir/server/herdr-gui-darwin-x64"
    ;;
  linux-x64)
    build_script="build:linux-x64"
    binary="$root_dir/server/herdr-gui-linux-x64"
    ;;
  linux-arm64)
    build_script="build:linux-arm64"
    binary="$root_dir/server/herdr-gui-linux-arm64"
    ;;
  windows-x64)
    build_script="build:windows-x64"
    binary="$root_dir/server/herdr-gui-windows-x64.exe"
    binary_name="herdr-gui.exe"
    ;;
  *)
    echo "unsupported platform: $platform" >&2
    echo "supported platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64" >&2
    exit 2
    ;;
esac

package_dir_name="herdr-gui-$platform"
package_dir="$root_dir/dist/$package_dir_name"
versioned_archive="$root_dir/dist/herdr-gui-v$version-$platform.tar.xz"
latest_archive="$root_dir/dist/herdr-gui-$platform.tar.xz"
versioned_checksum="$versioned_archive.sha256"
latest_checksum="$latest_archive.sha256"
update_manifest="$root_dir/dist/herdr-gui-$platform.update.json"

cd "$root_dir"
bun run "$build_script"

rm -rf "$package_dir"
mkdir -p "$package_dir"
cp "$binary" "$package_dir/$binary_name"
chmod 755 "$package_dir/$binary_name"
printf 'herdr-gui %s %s\n' "$version" "$platform" > "$package_dir/VERSION"

rm -f \
  "$versioned_archive" \
  "$latest_archive" \
  "$versioned_checksum" \
  "$latest_checksum" \
  "$update_manifest"

# Avoid macOS extended headers without passing bsdtar-only flags on Linux.
tar_options=()
if [[ "$(uname -s)" == "Darwin" ]]; then
  tar_options+=(--no-xattrs --no-mac-metadata)
elif tar --help 2>&1 | grep -- "--no-xattrs" >/dev/null; then
  tar_options+=(--no-xattrs)
fi
COPYFILE_DISABLE=1 tar "${tar_options[@]}" \
  -C "$root_dir/dist" \
  -cJf "$versioned_archive" \
  "$package_dir_name"

cp "$versioned_archive" "$latest_archive"

digest_for() {
  archive="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$archive" | awk '{ print $1 }'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$archive" | awk '{ print $1 }'
  else
    echo "shasum or sha256sum is required" >&2
    exit 1
  fi
}

archive_digest="$(digest_for "$versioned_archive")"
printf '%s  %s\n' \
  "$archive_digest" \
  "$(basename "$versioned_archive")" > "$versioned_checksum"
printf '%s  %s\n' \
  "$archive_digest" \
  "$(basename "$latest_archive")" > "$latest_checksum"
printf '%s\n' \
  "{\"schema\":1,\"name\":\"herdr-gui\",\"version\":\"$version\",\"platform\":\"$platform\",\"archive\":\"$(basename "$latest_archive")\",\"sha256\":\"$archive_digest\"}" \
  > "$update_manifest"

cat "$versioned_checksum" "$latest_checksum" "$update_manifest"
ls -lh \
  "$versioned_archive" \
  "$versioned_checksum" \
  "$latest_archive" \
  "$latest_checksum" \
  "$update_manifest"
