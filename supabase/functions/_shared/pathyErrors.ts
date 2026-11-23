// _shared/pathyErrors.ts — jejak kegagalan Pathy, ditulis service_role.
//
// Kenapa ada: keluhan "Pathy sering error" tidak bisa ditelusuri karena
// kegagalan hanya ditulis ke console. Tabel `sp_pathy_errors` (migrasi
// 20261123100000) menyimpan kode/status, bukan isi percakapan.
//
// Aturan modul ini:
//   • tidak pernah melempar — logging tidak boleh menggagalkan jawaban;
//   • tidak menyimpan prompt/jawaban pengguna, hanya pesan galat terpotong;
//   • aman dipanggil walau tabel belum ada (mis. migrasi belum diterapkan):
//     kegagalannya hanya muncul di console.

export type PathyErrorSource = 'client' | 'agent' | 'proxy' | 'ai-proxy';

export interface PathyErrorEntry {
  source: PathyErrorSource;
  code: string;
  httpStatus?: number | null;
  route?: string | null;
  detail?: string | null;
  userId?: string | null;
  userEmail?: string | null;
}

/** Potong pesan galat agar tabel tidak berubah jadi salinan log mentah. */
function clip(value: unknown, max: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.slice(0, max);
}

// deno-lint-ignore no-explicit-any
export async function logPathyError(db: any, entry: PathyErrorEntry): Promise<void> {
  const code = clip(entry.code, 32) ?? 'UNKNOWN';
  const httpStatus = typeof entry.httpStatus === 'number' ? entry.httpStatus : null;
  const detail = clip(entry.detail, 500);
  try {
    const { error } = await db.from('sp_pathy_errors').insert({
      source: entry.source,
      code,
      http_status: httpStatus,
      route: clip(entry.route, 60),
      detail,
      user_id: entry.userId ?? null,
      user_email: clip(entry.userEmail, 200),
    });
    if (error) {
      // Tabel diagnosa belum ada (migrasi belum diterapkan)? Jejaknya tidak
      // boleh hilang: sp_activity_log sudah ada dan dibaca CMS (Jejak
      // Aktivitas), jadi dipakai sebagai sink cadangan.
      const fallback = await db.from('sp_activity_log').insert({
        actor_id: entry.userId ?? null,
        actor_email: clip(entry.userEmail, 200),
        action: 'PATHY_ERROR',
        status: 'ERROR',
        http_status: httpStatus,
        detail: `[${entry.source}] ${code}${detail ? ': ' + detail : ''}`.slice(0, 500),
        param_keys: ['source', 'code', 'route'],
      });
      if (fallback?.error) console.error('logPathyError fallback:', fallback.error.message);
    }
  } catch (e) {
    console.error('logPathyError threw:', e);
  }
}
