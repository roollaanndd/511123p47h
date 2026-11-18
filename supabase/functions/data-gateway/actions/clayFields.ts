// clayFields.ts — validasi bersama untuk field tampilan clay B2B.
// Dipakai insurers.ts dan b2bSettings.ts supaya aturan warna/ikon/bullet
// identik di seluruh aksi gateway. Semua nilai mentah dari klien ditolak
// sebelum masuk ke PostgREST.

export const CLAY_ICON_KEYS = new Set([
  'building', 'shield', 'shield-check', 'landmark', 'umbrella',
  'star', 'award', 'sparkles', 'zap', 'circle-dot',
]);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface ClayParse<T> {
  ok: boolean;
  value: T;
}

/** null/'' = bukan warna kustom (klien memakai netral). Hex lain ditolak. */
export function parseClayAccent(input: unknown): ClayParse<string | null> {
  if (input == null || input === '') return { ok: true, value: null };
  const value = String(input).trim();
  return HEX_RE.test(value) ? { ok: true, value } : { ok: false, value: null };
}

export function parseClayIcon(input: unknown, fallback: string): ClayParse<string> {
  if (input == null || input === '') return { ok: true, value: fallback };
  const value = String(input).trim();
  return CLAY_ICON_KEYS.has(value) ? { ok: true, value } : { ok: false, value: fallback };
}

/** Admin mengirim string[]; JSON string diterima juga untuk kompatibilitas. */
export function parseHighlightBullets(input: unknown): ClayParse<string[]> {
  if (input == null || input === '') return { ok: true, value: [] };
  let raw: unknown = input;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('[')) return { ok: false, value: [] };
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return { ok: false, value: [] };
    }
  }
  if (!Array.isArray(raw)) return { ok: false, value: [] };
  const value = raw
    .map(x => String(x ?? '').trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 5);
  return { ok: true, value };
}

/** Bangun patch hanya untuk kunci yang benar-benar dikirim klien. Ini penting
 *  supaya aksi seperti toggle is_active tidak mengosongkan kustomisasi. */
export function clayPatch(
  params: Record<string, unknown>,
  defaults: { icon: string },
): { ok: boolean; error?: string; patch: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};
  if ('accent_color' in params) {
    const parsed = parseClayAccent(params.accent_color);
    if (!parsed.ok) return { ok: false, error: 'accent_color harus #RRGGBB', patch };
    patch.accent_color = parsed.value;
  }
  if ('icon' in params) {
    const parsed = parseClayIcon(params.icon, defaults.icon);
    if (!parsed.ok) return { ok: false, error: 'icon tidak dikenal', patch };
    patch.icon = parsed.value;
  }
  if ('featured' in params) patch.featured = params.featured === true;
  return { ok: true, patch };
}
