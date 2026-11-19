// emailLayout.ts — satu tata letak untuk semua email SurePath.
//
// Kenapa ada: sebelum ini setiap email menulis HTML-nya sendiri. Hasilnya
// empat gaya berbeda (header oranye, header ungu, header hijau, tanpa header),
// dan satu di antaranya memakai gradient yang memang dilarang pada arahan
// desain 19 Nov 2026. Ketika desain hanya hidup di dalam string template
// masing-masing, tidak ada cara memperbaikinya serentak.
//
// Kontrak modul ini:
//   - tidak ada gradient, gambar eksternal, atau <script>; klien email
//     memblokirnya dan hasilnya terlihat rusak;
//   - lebar 560 px, tabel + inline CSS, satu kolom — aman di Gmail/Outlook;
//   - SEMUA nilai teks dari pemanggil sudah di-escape (`escapeHtml` di
//     _shared/email.ts). Modul ini tidak meng-escape ulang supaya tidak
//     mengubah entitas yang sengaja dikirim.
//
// Variabel Go template (`{{ .ConfirmationURL }}`) tidak dipakai di sini —
// email transaksional SurePath dirakit di server, bukan oleh Supabase Auth.

const BRAND = '#059669';
const INK = '#0f172a';
const BODY = '#475569';
const MUTED = '#94a3b8';
const LINE = '#eef0f2';

export interface EmailLayoutOptions {
  title: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  intro: string;
  blocks?: string[];
  note?: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

/** Kerangka email: header merek, kartu putih, footer perusahaan. */
export function renderEmail(o: EmailLayoutOptions): string {
  const blocks = (o.blocks ?? []).join('');
  const note = o.note
    ? `<p style="margin:22px 0 0;font-size:12px;line-height:1.7;color:${MUTED};border-top:1px solid ${LINE};padding-top:16px;">${o.note}</p>`
    : '';

  return `<!doctype html>
<html lang="id" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${o.title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${o.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;padding:32px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e6e8eb;border-radius:14px;font-family:${FONT};">
        <tr>
          <td style="padding:24px 28px;border-bottom:1px solid ${LINE};">
            <span style="font-size:18px;font-weight:800;letter-spacing:-0.4px;color:${INK};">Sure<span style="color:${BRAND};">Path</span></span>
            <span style="display:block;margin-top:4px;font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${MUTED};">${o.eyebrow}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:800;color:${INK};letter-spacing:-0.4px;">${o.heading}</h1>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.65;color:${BODY};">${o.intro}</p>
${blocks}
${note}
          </td>
        </tr>
        <tr>
          <td style="padding:18px 28px;background:#fafbfc;border-top:1px solid ${LINE};">
            <p style="margin:0;font-size:11px;line-height:1.6;color:${MUTED};">PT Ruang Proteksi Indonesia · myinsurepath.com</p>
            <p style="margin:6px 0 0;font-size:11px;line-height:1.6;color:#b0b8c4;">Email otomatis. Balasan ke alamat ini tidak dibaca.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Satu ajakan bertindak. `url` dan `label` sudah di-escape pemanggil. */
export function buttonBlock(url: string, label: string): string {
  return `            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
              <tr>
                <td style="border-radius:10px;background:${BRAND};">
                  <a href="${url}" style="display:inline-block;padding:13px 22px;font-size:14px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>
                </td>
              </tr>
            </table>
`;
}

/** Kode OTP besar dan mudah dibaca. */
export function tokenBlock(token: string): string {
  return `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
              <tr>
                <td align="center" style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;font-family:${MONO};font-size:28px;letter-spacing:8px;font-weight:700;color:${INK};">${token}</td>
              </tr>
            </table>
`;
}

/** Catatan kecil beraksen kiri, untuk konteks atau peringatan ringan. */
export function calloutBlock(html: string): string {
  return `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
              <tr>
                <td style="padding:12px 14px;background:#f8fafc;border-left:3px solid ${BRAND};border-radius:0 8px 8px 0;font-size:12px;line-height:1.6;color:${BODY};">${html}</td>
              </tr>
            </table>
`;
}

export function paragraphBlock(html: string): string {
  return `            <p style="margin:0 0 18px;font-size:13px;line-height:1.65;color:${BODY};">${html}</p>
`;
}

/**
 * Tabel data dua kolom (label → nilai). Nilai uang/angka di kanan, tebal bila
 * `emphasis` menyala — dipakai untuk total premi.
 */
export function dataTableBlock(
  rows: Array<{ label: string; value: string; emphasis?: boolean }>,
): string {
  const body = rows.map((r, i) => {
    const border = i === 0 ? '' : `border-top:1px solid ${LINE};`;
    const size = r.emphasis ? '16px' : '13px';
    const weight = r.emphasis ? '800' : '700';
    const color = r.emphasis ? BRAND : INK;
    return `              <tr>
                <td style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${MUTED};${border}">${r.label}</td>
                <td align="right" style="padding:8px 0;font-size:${size};font-weight:${weight};color:${color};${border}">${r.value}</td>
              </tr>`;
  }).join('\n');

  return `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin:0 0 20px;">
              <tr>
                <td style="padding:14px 18px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${body}
                  </table>
                </td>
              </tr>
            </table>
`;
}
