// clayTheme.ts — konfigurasi tampilan clay yang dipakai bersama admin dan
// picker B2B. Kunci ikon harus sama dengan daftar di gateway/migrasi.

export const CLAY_ICON_OPTIONS = [
  { value: 'building', label: 'Gedung' },
  { value: 'shield', label: 'Perisai' },
  { value: 'shield-check', label: 'Perisai centang' },
  { value: 'landmark', label: 'Lembaga' },
  { value: 'umbrella', label: 'Payung' },
  { value: 'star', label: 'Bintang' },
  { value: 'award', label: 'Penghargaan' },
  { value: 'sparkles', label: 'Cahaya' },
  { value: 'zap', label: 'Cepat' },
  { value: 'circle-dot', label: 'Titik' },
] as const;

export const CLAY_ICON_KEYS: string[] = CLAY_ICON_OPTIONS.map(o => o.value);
export const CLAY_ACCENT_DEFAULT = '#64748B';

export function normalizeAccent(value: unknown, fallback = CLAY_ACCENT_DEFAULT): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : fallback;
}

export function normalizeIcon(value: unknown, fallback = 'building'): string {
  return typeof value === 'string' && CLAY_ICON_KEYS.includes(value) ? value : fallback;
}

export function normalizeBullets(value: unknown, max = 5): string[] {
  if (Array.isArray(value)) {
    return value.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, max);
  }
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeBullets(parsed, max);
    } catch { /* abaikan: admin form selalu mengirim array */ }
  }
  return [];
}
