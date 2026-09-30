// Only fixed, allowlisted messages may reach an operator's terminal.
// PostgreSQL error messages/details can contain credentials, URLs, and user data.
export function databaseDiagnostic(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const code = typeof value.code === 'string' ? value.code : '';
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
  if (code === 'ERR_INVALID_URL' || message === 'invalid_database_url' || message === 'database_unconfigured') {
    return '[DB_URL] URL database tidak valid. Salin External Database URL dari Render; gunakan bash install-vps.sh --database-url untuk memasukkan ulang tanpa editor.';
  }
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return '[DB_DNS] Host database tidak dapat ditemukan. Pastikan memakai External Database URL, bukan Internal URL Render; periksa DNS keluar dari Docker.';
  }
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET', '57P03'].includes(code) || /timeout|timed out|connection terminated unexpectedly/.test(message)) {
    return '[DB_NETWORK] Koneksi database gagal atau timeout. Pastikan database Render aktif, IP publik keluar VPS diizinkan pada Networking, dan koneksi keluar TCP 5432 tersedia.';
  }
  if (['28P01', '28000'].includes(code)) {
    return '[DB_AUTH] Akses PostgreSQL ditolak. Periksa kredensial External Database URL terbaru dan allowlist IP VPS di Render. Jangan membagikan URL/password.';
  }
  if (code === '3D000') return '[DB_NAME] Nama database tidak ditemukan. Salin ulang External Database URL dari database Render yang benar.';
  if (['42P01', '42703', 'DB_NODE_MISSING'].includes(code)) {
    return '[DB_MIGRATION] Skema atau identitas node VPS belum siap. Jalankan npm run migrate di Shell layanan website Render yang memakai database ini, lalu ulangi installer.';
  }
  if (code === '42501') return '[DB_PERMISSION] Akun database tidak memiliki izin yang diperlukan. Gunakan role aplikasi yang sesuai untuk database Render ini.';
  if (['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code) || /certificate|does not support ssl|ssl connection|tls handshake/.test(message)) {
    return '[DB_TLS] Verifikasi TLS database gagal. Periksa External URL, jam VPS, dan rantai sertifikat; jangan menonaktifkan verifikasi TLS.';
  }
  return '[DB_UNKNOWN] Pemeriksaan database gagal dengan penyebab yang belum dikenali. Periksa status PostgreSQL Render; jangan kirim URL/password atau log mentah.';
}
