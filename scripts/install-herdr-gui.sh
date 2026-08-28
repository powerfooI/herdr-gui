#!/bin/sh
set -eu

github_repository="powerfooI/herdr-studio"
custom_release_base="${HERDR_GUI_RELEASE_BASE_URL:-}"
install_dir="${HERDR_GUI_INSTALL_DIR:-$HOME/.local/bin}"
requested_version="${HERDR_GUI_VERSION:-}"

fail() {
  printf 'herdr-gui installer: %s\n' "$*" >&2
  exit 1
}

for command in curl tar install uname awk cat mktemp; do
  command -v "$command" >/dev/null 2>&1 ||
    fail "required command not found: $command"
done
if command -v shasum >/dev/null 2>&1; then
  checksum_tool="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  checksum_tool="sha256sum"
else
  fail "required command not found: shasum or sha256sum"
fi

case "$(uname -s):$(uname -m)" in
  Darwin:arm64 | Darwin:aarch64)
    platform="darwin-arm64"
    ;;
  Darwin:x86_64 | Darwin:amd64)
    platform="darwin-x64"
    ;;
  Linux:x86_64 | Linux:amd64)
    platform="linux-x64"
    ;;
  Linux:arm64 | Linux:aarch64)
    platform="linux-arm64"
    ;;
  *)
    fail "unsupported platform: $(uname -s) $(uname -m)"
    ;;
esac

if [ -n "$requested_version" ]; then
  case "$requested_version" in
    *[!0-9A-Za-z._-]*)
      fail "invalid HERDR_GUI_VERSION: $requested_version"
      ;;
  esac
  archive_name="herdr-gui-v${requested_version}-${platform}.tar.xz"
else
  archive_name="herdr-gui-${platform}.tar.xz"
fi

# GitHub uses a different asset directory for latest and versioned releases.
# Custom mirrors keep the existing flat-directory contract.
if [ -n "$custom_release_base" ]; then
  release_base="$custom_release_base"
elif [ -n "$requested_version" ]; then
  release_base="https://github.com/$github_repository/releases/download/v${requested_version}"
else
  release_base="https://github.com/$github_repository/releases/latest/download"
fi
while [ "${release_base%/}" != "$release_base" ]; do
  release_base="${release_base%/}"
done
case "$release_base" in
  *\?* | *\#*)
    fail "release base URL must not contain a query or fragment"
    ;;
esac
release_authority="${release_base#*://}"
release_authority="${release_authority%%/*}"
[ -n "$release_authority" ] || fail "invalid release base URL"
case "$release_authority" in
  *@*) fail "release base URL must not contain credentials" ;;
esac
case "$release_base" in
  https://*)
    curl_protocol="=https"
    ;;
  http://*)
    case "$release_authority" in
      localhost | localhost:* | 127.0.0.1 | 127.0.0.1:* | "[::1]" | "[::1]":*) ;;
      *) fail "release base URL must use HTTPS unless the mirror is loopback" ;;
    esac
    curl_protocol="=http"
    ;;
  *) fail "release base URL must be an HTTP(S) URL" ;;
esac
package_dir="herdr-gui-${platform}"
mkdir -p "$install_dir"
target="$install_dir/herdr-gui"
if { [ -e "$target" ] || [ -L "$target" ]; } && \
   { [ ! -f "$target" ] || [ -L "$target" ]; }; then
  fail "install target exists but is not a regular file"
fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/herdr-gui-install.XXXXXX")"
target_tmp=""
backup_tmp=""

cleanup() {
  rm -rf "$tmp"
  if [ -n "${target_tmp:-}" ]; then
    rm -f "$target_tmp"
  fi
  if [ -n "${backup_tmp:-}" ]; then
    rm -f "$backup_tmp"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

archive="$tmp/$archive_name"
checksum="$archive.sha256"
printf 'Downloading herdr-gui for %s...\n' "$platform"
curl --proto "$curl_protocol" --proto-redir "$curl_protocol" \
  -fsSL "$release_base/$archive_name" -o "$archive"
curl --proto "$curl_protocol" --proto-redir "$curl_protocol" \
  --max-filesize 4096 -fsSL \
  "$release_base/$archive_name.sha256" -o "$checksum"
checksum_line="$(cat "$checksum")" || fail "unable to read package checksum"
set -f
set -- $checksum_line
set +f
[ "$#" -eq 2 ] || fail "invalid package checksum file"
expected_checksum="$1"
checksum_name="$2"
[ "${#expected_checksum}" -eq 64 ] || fail "invalid package checksum file"
case "$expected_checksum" in
  *[!0-9A-Fa-f]*) fail "invalid package checksum file" ;;
esac
expected_checksum="$(printf '%s\n' "$expected_checksum" | awk '{ print tolower($0) }')"
[ "$checksum_name" = "$archive_name" ] || fail "invalid package checksum file"
if [ "$checksum_tool" = "shasum" ]; then
  actual_checksum="$(shasum -a 256 "$archive" | awk 'NR == 1 { print $1 }')"
else
  actual_checksum="$(sha256sum "$archive" | awk 'NR == 1 { print $1 }')"
fi
[ "$actual_checksum" = "$expected_checksum" ] || fail "package checksum mismatch"

tar -xJf "$archive" -C "$tmp" \
  "$package_dir/VERSION" \
  "$package_dir/herdr-gui"

extracted_package_dir="$tmp/$package_dir"
version_file="$extracted_package_dir/VERSION"
binary="$extracted_package_dir/herdr-gui"
[ -d "$extracted_package_dir" ] && [ ! -L "$extracted_package_dir" ] ||
  fail "package directory is invalid"
[ -f "$version_file" ] && [ ! -L "$version_file" ] ||
  fail "package VERSION file is missing or invalid"
[ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] ||
  fail "package binary is missing, invalid, or not executable"

package_name=""
package_version=""
package_platform=""
extra_version_field=""
read -r package_name package_version package_platform extra_version_field \
  < "$version_file" || fail "invalid package VERSION file"
[ "$package_name" = "herdr-gui" ] || fail "invalid package VERSION file"
[ -z "$extra_version_field" ] || fail "invalid package VERSION file"
[ -n "$package_version" ] || fail "package version is missing"
[ "$package_platform" = "$platform" ] ||
  fail "package platform is $package_platform, expected $platform"
[ -z "$requested_version" ] || [ "$package_version" = "$requested_version" ] ||
  fail "package version is $package_version, expected $requested_version"

binary_version="$("$binary" --version)"
[ "$binary_version" = "herdr-gui $package_version" ] ||
  fail "binary version does not match package VERSION"

if { [ -e "$target" ] || [ -L "$target" ]; } && \
   { [ ! -f "$target" ] || [ -L "$target" ]; }; then
  fail "install target changed during installation"
fi
target_tmp="$(mktemp "$install_dir/.herdr-gui.new.XXXXXX")"
install -m 0755 "$binary" "$target_tmp"
backup=""
if [ -f "$target" ] && [ ! -L "$target" ]; then
  backup="$target.previous"
  backup_tmp="$(mktemp "$install_dir/.herdr-gui.previous.XXXXXX")"
  install -m 0755 "$target" "$backup_tmp"
  mv -f "$backup_tmp" "$backup"
  backup_tmp=""
fi
mv -f "$target_tmp" "$target"
target_tmp=""

printf 'Installed herdr-gui %s to %s\n' "$package_version" "$target"
if [ -n "$backup" ]; then
  printf 'Previous binary saved to %s\n' "$backup"
fi
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *)
    printf 'Add %s to PATH to run herdr-gui directly.\n' "$install_dir"
    ;;
esac
