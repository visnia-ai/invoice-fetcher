#!/bin/sh

set -eu

repository="https://github.com/visnia-ai/invoice-fetcher"
install_directory="${INSTALL_DIR:-/usr/local/bin}"

fail() {
  printf 'invoice-fetcher: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v install >/dev/null 2>&1 || fail "install is required."

case "$(uname -s)" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  *) fail "only macOS and Linux are supported by this installer." ;;
esac

case "$(uname -m)" in
  x86_64|amd64) architecture="x64" ;;
  arm64|aarch64) architecture="arm64" ;;
  *) fail "unsupported architecture: $(uname -m)." ;;
esac

latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$repository/releases/latest")
tag=${latest_url##*/}
case "$tag" in
  v[0-9]*) ;;
  *) fail "could not determine the latest release." ;;
esac

version=${tag#v}
archive="invoice-fetcher-${version}-${platform}-${architecture}.tar.gz"
download_url="$repository/releases/download/${tag}"
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

curl -fsSL --retry 3 -o "$temporary_directory/$archive" "$download_url/$archive"
curl -fsSL --retry 3 -o "$temporary_directory/$archive.sha256" "$download_url/$archive.sha256"

(
  cd "$temporary_directory"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$archive.sha256"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$archive.sha256"
  else
    fail "shasum or sha256sum is required to verify the download."
  fi
)

tar -xzf "$temporary_directory/$archive" -C "$temporary_directory" invoice-fetcher

if [ ! -d "$install_directory" ]; then
  mkdir -p "$install_directory" 2>/dev/null || true
fi

if [ -d "$install_directory" ] && [ -w "$install_directory" ]; then
  install -m 755 "$temporary_directory/invoice-fetcher" "$install_directory/invoice-fetcher"
elif command -v sudo >/dev/null 2>&1; then
  sudo mkdir -p "$install_directory"
  sudo install -m 755 "$temporary_directory/invoice-fetcher" "$install_directory/invoice-fetcher"
else
  fail "cannot write to $install_directory; set INSTALL_DIR to a writable directory."
fi

printf 'Installed invoice-fetcher to %s/invoice-fetcher\n' "$install_directory"
