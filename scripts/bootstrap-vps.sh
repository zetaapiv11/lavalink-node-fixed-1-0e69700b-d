#!/usr/bin/env bash
# Download to a file, then execute with sudo bash. No Discord token is needed here.
set -Eeuo pipefail
set +x
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Jalankan dengan sudo bash.'
[[ -r /etc/os-release ]] || fail 'Sistem operasi tidak dikenali.'
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;;
  *) fail 'Bootstrap mendukung Ubuntu 22.04/24.04/26.04 dan Debian 12/13. Untuk OS lain, pasang Docker lalu gunakan install-vps.sh.' ;;
esac
repo_url=https://github.com/zetaapiv11/lavalink-node-fixed-1-0e69700b-d.git
repo_branch=coderabbit/build-public-lavalink-service/63eaecea
install_dir=/opt/resonance
# Refuse unrelated directories before installing packages.
if [[ -e $install_dir ]]; then
  [[ ! -L $install_dir && -d $install_dir/.git ]] || fail '/opt/resonance sudah ada dan bukan checkout installer. Tidak diubah.'
  command -v git >/dev/null || fail 'Checkout sudah ada tetapi git belum terpasang.'
  [[ $(git -C "$install_dir" remote get-url origin) == "$repo_url" ]] || fail 'Repository /opt/resonance berbeda. Tidak diubah.'
  [[ -f $install_dir/install-vps.sh ]] || fail 'Installer tidak ditemukan dalam checkout.'
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssl util-linux
exec 8>/run/lock/resonance-bootstrap.lock
flock -n 8 || fail 'Bootstrap lain sedang berjalan.'
if ! command -v docker >/dev/null; then
  # Do not remove an existing container runtime or replace its data.
  for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      fail "Paket $package sudah terpasang. Siapkan Docker Engine/Compose yang kompatibel sebelum mengulang."
    fi
  done
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location --proto '=https' "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod 644 /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<APT
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
APT
  chmod 644 /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker compose version >/dev/null || fail 'Docker ada, tetapi Compose v2 belum tersedia. Pasang plugin Compose untuk instalasi Docker ini.'
systemctl enable --now docker
for attempt in {1..15}; do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 2
done
docker info >/dev/null 2>&1 || fail 'Docker daemon belum siap.'
if [[ ! -e $install_dir ]]; then
  # Clone into a private temporary directory; failed downloads leave no partial install.
  staging=$(mktemp -d /opt/.resonance-install.XXXXXX)
  trap 'rm -rf -- "$staging"' EXIT
  # Source must remain readable by the unprivileged node user after Docker COPY.
  (umask 022; git clone --single-branch --branch "$repo_branch" "$repo_url" "$staging/repo")
  mv -- "$staging/repo" "$install_dir"
fi
# Re-runs use the installed revision, without resetting edits or rotating credentials.
bash "$install_dir/install-vps.sh"
