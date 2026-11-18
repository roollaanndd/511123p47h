# Flow Pengajuan Polis B2B (Bulk Fleet) & Output Artifacts

> Status per v2.9.12. Dokumen ini mendesain alur pengajuan polis klien B2B
> (impor massal armada) end-to-end, dan mendaftar output file selain Excel
> yang bisa dipakai untuk pengajuan polis — sebagian sudah ada, sebagian
> dirancang sebagai roadmap.

## 1. Ringkasan state machine batch

Satu batch (`sp_b2b_batches`, satu nomor batch seperti `SPB2B-…`) bergerak:

```
SUBMITTED ──► INVOICED ──► PAID ──► ISSUED
   ▲            │
   └────────────┘  (invoice kadaluarsa → kembali SUBMITTED, webhook Xendit)
DRAFT (dihapus — tidak dipakai lagi)
CANCELLED (oleh admin)
```

- **SUBMITTED** — klien menyelesaikan wizard 4 langkah (`B2BBulkImport`):
  upload → pemetaan kolom → review/recompute → submit. Premi dihitung ulang
  otoritatif oleh gateway (`b2b_bulk_create_batch`), file asli diunggah dan
  PATH-nya disimpan (`source_file_path`).
- **INVOICED** — invoice agregat Xendit dibuat (`create-b2b-bulk-invoice`);
  nominal selalu dari DB, bukan request body.
- **PAID** — webhook Xendit memverifikasi nominal (toleransi Rp 100), batch
  lunas, admin dinotifikasi.
- **ISSUED** — admin menugaskan insurer → insurer mengunggah polis induk
  (PDF) ke `b2b-documents` via token → admin menerbitkan
  (`admin_issue_b2b_bulk_batch`) dengan nomor polis induk.

## 2. Output file per tahap (yang ADA sekarang)

| Tahap | Output | Format | Pembuat | Lokasi |
|---|---|---|---|---|
| Review (SUBMITTED) | Quotation Excel — kolom uang terisi per baris + total | `.xlsx` | `b2bBulkQuoteExcel.ts` (klien) | unduhan langsung |
| Review (SUBMITTED) | File sumber asli klien | `.xlsx/.xls/.csv` | klien | `b2b-documents/{clientId}/bulk-source/…` (privat, path disimpan) |
| PAID→ISSUED | Polis induk (master policy) batch | PDF | insurer (upload) | `b2b-documents/…/master-policy…` (privat, signed URL 300s) |
| Semua | Log aktivitas batch | tabel JSON | gateway/webhook | `sp_b2b_activity_log` (deny-all RLS) |

## 3. Output file tambahan yang MUNGKIN dibutuhkan pengajuan polis (roadmap)

Urutan prioritas disusun dari kebutuhan insurer saat memproses pengajuan
blok (semua bisa dibangun dari data yang SUDAH tersimpan — tidak perlu
migrasi skema besar):

1. **Surat pengajuan / proposal PDF per batch (tahap SUBMITTED→PAID)** —
   ringkasan resmi: nama perusahaan, jumlah unit, cakupan TLO, premi total,
   tanggal periode, daftar ringkas unit (atau lampiran). Insurer multifinance
   lazimnya minta "penawaran resmi ber-KOP" selain Excel. Bisa dibuat dari
   `sp_b2b_batches` + `sp_b2b_batch_items` (pola PDF yang sudah dipakai
   Pathy: `pathyQuotationPdf`).
2. **Schedule PDF (lampiran polis induk, tahap ISSUED)** — daftar unit
   berhalaman (plat, chassis, TSI, premi, periode) yang lazim ditempel di
   belakang polis induk. Data identik dengan `Detail Unit` di admin; pola
   render sama dengan proposal di poin 1.
3. **Sertifikat per unit (tahap ISSUED, opsional)** — beberapa insurer
   menuntut satu sertifikat per nasabah unit. Mahal di-generate untuk 253
   unit — disarankan template Word/PDF yang diisi insurer sendiri, bukan
   sistem meng-generate semuanya.
4. **Payload JSON untuk API insurer (roadmap integrasi)** — bila insurer
   punya endpoint pengajuan, satu batch = satu payload: header + items.
   Struktur sudah cocok dengan `sp_b2b_batch_items` (tanpa PII sensitif
   melebihi kebutuhan polis).

## 4. Peran aktor

- **Klien B2B** (`B2B_CLIENT`): membuat batch, membayar, melihat status +
  quotation Excel + (setelah ISSUED) polis induk via signed URL.
- **Admin** (`MASTER_ADMIN`): melihat semua batch, mengunduh file sumber
  (audit ditulis), menugaskan insurer, menerbitkan polis, membaca log
  aktivitas (tab Aktivitas).
- **Insurer**: dashboard token-nya sendiri; mengunggah polis induk.
- **Sistem** (webhook Xendit): PAID / EXPIRED — masuk log dengan aktor
  `SYSTEM`.

## 5. Jejak audit (siapa menulis apa)

- `sp_b2b_activity_log` — ditulis helper `logB2BActivity` dari: gateway
  (create/view/assign/issue/source-url), `create-b2b-bulk-invoice`,
  `xendit-webhook` (PAID/EXPIRED). RLS deny-all; hanya service-role.
- `sp_audit_log` — trigger DB `trg_audit_b2b_batch_update/delete` menangkap
  UPDATE kolom kritis (status, insurer, polis, nominal, path) dan DELETE,
  apa pun yang menulis — pertahanan terhadap tampering di luar gateway.
- Unduhan file sumber oleh admin selalu menulis entri
  `bulk_source_file_downloaded` (siapa, kapan, file mana).
