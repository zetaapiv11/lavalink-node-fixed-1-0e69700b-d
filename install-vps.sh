#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
fail() { printf '%s\n' "$*" >&2; exit 1; }
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash install-vps.sh [--configure-only | --check-database | --database-url]'
  echo 'Meminta domain, email, dan URL PostgreSQL jika .env belum ada. Rahasia dibuat otomatis; konfigurasi lama dipertahankan.'
  exit 0
fi
[[ $# == 0 || ( $# == 1 && ( $1 == --configure-only || $1 == --check-database || $1 == --database-url ) ) ]] || fail 'Argumen tidak dikenal. Gunakan --help.'
for tool in docker openssl curl flock; do
  command -v "$tool" >/dev/null || fail "Perlu $tool. Gunakan scripts/bootstrap-vps.sh untuk VPS Ubuntu/Debian baru."
done
docker compose version >/dev/null
# Serialise creation/build/start, including concurrent installer runs.
exec 9>deploy/vps/.install.lock
flock -n 9 || fail 'Installer lain sedang berjalan.'
config=deploy/vps/.env
[[ ! -L $config ]] || fail 'File konfigurasi berupa symlink; tidak diubah.'
read_value() {
  local prompt=$1 secret=${2:-false}
  printf '%s' "$prompt" >&2
  if [[ $secret == true ]]; then
    IFS= read -r -s REPLY || fail 'Input terputus. Jalankan dari terminal interaktif.'
    printf '\n' >&2
  else
    IFS= read -r REPLY || fail 'Input terputus. Jalankan dari terminal interaktif.'
  fi
}
valid_domain() {
  local label
  [[ ${#1} -le 253 && $1 == *.* && $1 != *[!a-zA-Z0-9.-]* && $1 != *..* && $1 != .* && $1 != *. && ! $1 =~ ^[0-9.]+$ ]] || return 1
  local -a labels
  IFS=. read -r -a labels <<< "$1"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && $label != -* && $label != *- ]] || return 1
  done
}
read_database_url() {
  while :; do
    read_value 'External Database URL Render (input disembunyikan): ' true
    database_url=$REPLY
    # URI reserved characters in credentials must be percent-encoded.
    # Single quotes prevent Compose interpolation of literal dollar signs.
    if [[ $database_url =~ ^postgres(ql)?://[^/]+/[^/?]+(\?.*)?$ && $database_url != *[[:space:][:cntrl:]]* && $database_url != *"'"* && $database_url != *'\'* ]]; then break; fi
    echo 'Gunakan URL postgres:// atau postgresql:// lengkap; percent-encode karakter khusus dalam kredensial.' >&2
  done
}
if [[ ! -e $config ]]; then
  echo 'Siapkan DNS domain ke IP VPS, port 80/443, dan PostgreSQL Render yang sudah dimigrasi serta mengizinkan IP VPS.'
  while :; do
    read_value 'Domain audio (contoh audio.domainkamu.com): '
    domain=${REPLY,,}
    valid_domain "$domain" && break
    echo 'Masukkan hostname lengkap tanpa https://, port, atau path.' >&2
  done
  while :; do
    read_value 'Email sertifikat HTTPS: '
    email=$REPLY
    [[ $email =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] && break
    echo 'Format email tidak valid.' >&2
  done
  read_database_url
  node_password=$(openssl rand -hex 32)
  monitor_token=$(openssl rand -hex 32)
  temp_config=$(mktemp deploy/vps/.env.tmp.XXXXXX)
  trap 'rm -f -- "${temp_config:-}"' EXIT
  {
    printf 'VPS_DOMAIN=%s\nACME_EMAIL=%s\n' "$domain" "$email"
    printf "DATABASE_URL='%s'\n" "$database_url"
    printf 'DATABASE_SSL=true\nLAVALINK_SERVER_PASSWORD=%s\nMONITOR_TOKEN=%s\nLAVALINK_HTTP_ENABLED=false\n' "$node_password" "$monitor_token"
  } > "$temp_config"
  chmod 600 "$temp_config"
  mv -- "$temp_config" "$config"
  unset database_url REPLY node_password monitor_token
  echo 'Konfigurasi privat dibuat. Tidak ada password yang ditampilkan.'
else
  [[ -f $config && -s $config ]] || fail 'Konfigurasi lama kosong/tidak valid. File dipertahankan; pulihkan dari backup.'
  echo 'Menggunakan konfigurasi yang sudah ada; password tidak dirotasi.'
  if [[ ${1:-} == --database-url ]]; then
    read_database_url
    temp_config=$(mktemp deploy/vps/.env.tmp.XXXXXX)
    trap 'rm -f -- "${temp_config:-}"' EXIT
    # Replace only the database URL; never execute config or rotate node secrets.
    while IFS= read -r line || [[ -n $line ]]; do
      [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*= ]] && continue
      printf '%s\n' "$line"
    done < "$config" > "$temp_config"
    printf "DATABASE_URL='%s'\n" "$database_url" >> "$temp_config"
    chmod 600 "$temp_config"
    mv -- "$temp_config" "$config"
    unset database_url REPLY line
    echo 'URL database diperbarui; password node dan token monitoring tetap sama.'
  fi
fi
chmod 600 "$config"
# Never source .env as shell code.
domain=$(sed -n 's/^VPS_DOMAIN=//p' "$config")
domain=${domain#\'}; domain=${domain%\'}
domain=${domain#\"}; domain=${domain%\"}
valid_domain "$domain" || fail 'Domain dalam konfigurasi lama tidak valid.'
compose=(docker compose --env-file "$config" -f deploy/vps/compose.yaml)
"${compose[@]}" config --quiet
[[ ${1:-} != --configure-only ]] || { echo 'Konfigurasi siap; deployment belum dijalankan.'; exit 0; }
docker info >/dev/null 2>&1 || fail 'Docker daemon tidak dapat diakses. Jalankan dengan sudo atau periksa layanan Docker.'
"${compose[@]}" build --pull
# Use the shipped database TLS policy; fail without printing a DB URL or raw errors.
"${compose[@]}" run --rm --no-deps --entrypoint node audio --import tsx --input-type=module -e '
import { database } from "./lib/db.ts";
import { databaseDiagnostic } from "./lib/database-diagnostics.ts";
let db;
try {
 db = database();
 const result = await db.query({text: "SELECT id FROM nodes WHERE id = $1", values: ["vps"], query_timeout: 10000});
 if (!result.rowCount) throw Object.assign(new Error(), {code: "DB_NODE_MISSING"});
 console.log("Database TLS dan migrasi: OK");
} catch (error) {
 console.error(databaseDiagnostic(error));
 process.exitCode = 1;
} finally { if (db) await db.end(); }
' || fail 'Deployment dihentikan sebelum startup: pemeriksaan database gagal.'
[[ ${1:-} != --check-database ]] || { echo 'Pemeriksaan database selesai; layanan tidak dijalankan oleh perintah ini.'; exit 0; }
"${compose[@]}" up -d --wait --wait-timeout 300
# Verify the public TLS entry point, not only the container health check.
ready=false
for attempt in {1..24}; do
  if curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "https://$domain/healthz" >/dev/null 2>&1; then ready=true; break; fi
  sleep 5
done
[[ $ready == true ]] || fail 'Container berjalan tetapi HTTPS publik belum siap. Periksa DNS, firewall 80/443, dan log Caddy; ulangi perintah installer setelah diperbaiki.'
printf '\nNode VPS merespons melalui HTTPS: https://%s (port 443, secure=true)\n' "$domain"
printf 'Rahasia tersimpan di %s/%s (mode 600).\n' "$PWD" "$config"
echo 'Monitoring Render: NODE_VPS_URL adalah URL di atas; MONITOR_VPS_TOKEN harus sama dengan MONITOR_TOKEN dalam file privat tersebut.'
echo 'Kunci client bot dibuat melalui dashboard setelah akses disetujui. Token Discord diperoleh di Developer Portal, bukan dibuat installer.'
echo 'HTTPS sehat belum membuktikan audio. Jalankan pengujian Discord voice dan konfirmasi audio terdengar.'
