// services/uploadGuard.ts — client-side file upload validation
//
// Audit #18 (upload limits): the `accept="image/*"` attribute pada <input
// type=file> adalah petunjuk UX, bukan penjaga keamanan. Browser modern
// akan tetap mengizinkan user memilih file apapun via "All files" picker,
// dan path mobile Capacitor sering bypass accept sepenuhnya. Supabase
// Storage juga mengizinkan unggahan sampai 50 MB per file secara default,
// yang terlalu longgar untuk foto profil atau KTP.
//
// Helper ini menolak file secara DI KLIEN sebelum fetch — ini mengurangi
// bandwidth terbuang dan memberi pesan kesalahan yang segera. Server-side,
// Supabase Storage bucket seharusnya juga punya policy size limit sebagai
// defense-in-depth; helper ini bukan satu-satunya garis.
//
// Dipakai di: components/agent/AgentProfile.tsx (avatar + KTP),
// components/ClaimManager.tsx (foto klaim), dan upload admin.

export interface UploadRule {
  /** Maksimum ukuran file dalam bytes. */
  maxBytes: number;
  /** MIME types yang diperbolehkan (prefix match: 'image/' cocok semua gambar). */
  allowedMimePrefixes: string[];
  /** Pesan kesalahan ramah pengguna. Diisi otomatis bila kosong. */
  label?: string;
}

export interface UploadValidationResult {
  ok: boolean;
  reason?: string;
}

const KB = 1024;
const MB = 1024 * KB;

/** Preset umum. Nilai dipilih konservatif tetapi cukup untuk kasus nyata. */
export const UPLOAD_RULES = {
  // Foto profil: kompresi JPEG 1000×1000 biasanya di bawah 500 KB; 2 MB
  // memberi cukup ruang untuk PNG dengan alfa tanpa menerima raw DSLR.
  avatar: { maxBytes: 2 * MB, allowedMimePrefixes: ['image/'], label: 'Foto profil' } satisfies UploadRule,

  // Foto KTP: 5 MB cukup untuk foto HP modern tanpa kompresi, sekaligus
  // mencegah user mengunggah scan 300 DPI yang bisa sampai 20 MB.
  ktp: { maxBytes: 5 * MB, allowedMimePrefixes: ['image/', 'application/pdf'], label: 'Dokumen KTP' } satisfies UploadRule,

  // Foto klaim: lebih longgar karena mungkin perlu detail. 8 MB per foto,
  // sudah termasuk video short (gambar JPEG 12 MP ~ 5 MB).
  claimPhoto: { maxBytes: 8 * MB, allowedMimePrefixes: ['image/'], label: 'Foto klaim' } satisfies UploadRule,

  // Logo situs admin: 1 MB cukup untuk SVG/PNG optimal; menolak file
  // besar yang akan membebani setiap pemuatan situs.
  siteLogo: { maxBytes: 1 * MB, allowedMimePrefixes: ['image/'], label: 'Logo situs' } satisfies UploadRule,

  // Dokumen kebijakan / polis: PDF biasanya di bawah 5 MB; 10 MB
  // memberi ruang untuk polis multi-halaman besar.
  policyDocument: { maxBytes: 10 * MB, allowedMimePrefixes: ['application/pdf'], label: 'Dokumen polis' } satisfies UploadRule,

  // Impor massal B2B (Excel): file 50 MB terlalu besar bahkan untuk 10K
  // baris; 15 MB adalah batas realistis tertinggi yang diobservasi.
  bulkImportExcel: { maxBytes: 15 * MB, allowedMimePrefixes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'], label: 'File Excel impor massal' } satisfies UploadRule,
} as const;

/**
 * Validate a file against a rule. Returns `{ ok: true }` to upload,
 * or `{ ok: false, reason }` with a human-readable error to display.
 *
 * Caller biasanya menampilkan `reason` sebagai toast atau inline error dan
 * SKIP panggilan upload. Tidak melempar — pemanggil memutuskan UX-nya.
 */
export function validateUpload(file: File | null | undefined, rule: UploadRule): UploadValidationResult {
  if (!file) {
    return { ok: false, reason: 'Tidak ada file dipilih.' };
  }

  if (file.size <= 0) {
    return { ok: false, reason: `${rule.label ?? 'File'} tampak kosong (0 bytes).` };
  }

  if (file.size > rule.maxBytes) {
    const maxMb = (rule.maxBytes / MB).toFixed(rule.maxBytes < MB ? 1 : 0);
    const gotMb = (file.size / MB).toFixed(2);
    return {
      ok: false,
      reason: `${rule.label ?? 'File'} terlalu besar (${gotMb} MB). Maksimum ${maxMb} MB.`,
    };
  }

  // Beberapa browser mengirim `file.type` kosong — toleransi, jangan tolak
  // hanya karena atribut hilang. Tapi bila ada, cek prefix.
  if (file.type) {
    const allowed = rule.allowedMimePrefixes.some(prefix =>
      prefix.endsWith('/') ? file.type.startsWith(prefix) : file.type === prefix,
    );
    if (!allowed) {
      return {
        ok: false,
        reason: `${rule.label ?? 'File'} tipe "${file.type}" tidak didukung. Gunakan ${rule.allowedMimePrefixes.join(' atau ')}.`,
      };
    }
  }

  return { ok: true };
}
