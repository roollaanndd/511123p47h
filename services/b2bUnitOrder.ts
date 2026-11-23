// b2bUnitOrder — aturan & adapter untuk order unit B2B (v2.9.13).
//
// Dua tanggung jawab:
//   1. Validasi lokal yang mencerminkan aturan server (kondisi BARU/BEKAS,
//      lampiran wajib, copy polis masih berlaku). Server tetap memvalidasi
//      ulang — ini hanya supaya klien mendapat pesan yang jujur sebelum kirim.
//   2. Mapping data order B2B ke `QuotationSlipData` milik aplikasi agent.
//      Dengan memakai `generateQuotationSlipPDF` + `publishAndDownloadQuotation`,
//      PDF B2B identik (judul, kop, QR e-quotation, 4 halaman US Letter) dengan
//      PDF yang diterbitkan agent — bukan format A4 terpisah lagi.

import type { BuiltLineItem, FleetAddOns, FleetCoverage, VehicleClass } from './b2bFleetRating';
import type { QuotationSlipData } from './quotationSlipPdf';

export type VehicleCondition = 'BARU' | 'BEKAS';

export interface B2BAttachment {
  slot: string;
  /** Label tampilan; opsional karena lampiran juga datang dari penyimpanan. */
  label?: string;
  url: string;
  size_bytes: number;
}

export const NEW_VEHICLE_DOC_SLOTS = ['bstk', 'faktur'] as const;
export const POLICY_COPY_SLOT = 'copy-polis';
export const USED_VEHICLE_MIN_PHOTOS = 3;
const PHOTO_SLOT_PREFIXES = ['depan', 'belakang', 'samping-', 'rangka'];

const fmtIDR = (n: number): string =>
  new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

const fmtDateID = (iso: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || '—';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
};

const fmtDateShortID = (iso: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || '—';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
};

const plus30DaysISO = (): string => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

const quoteNumber = (): string => {
  const now = new Date();
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'][now.getMonth()];
  const seq = String(Math.floor(Math.random() * 9000) + 1000);
  return `QS/B2B/${now.getFullYear()}/${roman}/${seq}`;
};

const insurerShortName = (name: string): string =>
  name.replace(/^PT\.?\s*/i, '').replace(/\s+(Asuransi|Tbk|Indonesia).*$/i, '').trim() || 'Insurer';

/** Tanggal berlaku copy polis masih ≥ hari ini (perbandingan ISO aman). */
export const isPolicyCopyStillValid = (expiryISO: string, todayISO: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(expiryISO || '') && /^\d{4}-\d{2}-\d{2}$/.test(todayISO || '') && expiryISO >= todayISO;

export const hasNewVehicleDocument = (attachments: B2BAttachment[]): boolean =>
  attachments.some(a => (NEW_VEHICLE_DOC_SLOTS as readonly string[]).includes(a.slot));

export const hasEnoughUsedVehiclePhotos = (attachments: B2BAttachment[]): boolean =>
  attachments.filter(a => PHOTO_SLOT_PREFIXES.some(prefix => a.slot.startsWith(prefix))).length >= USED_VEHICLE_MIN_PHOTOS;

export interface B2BUnitOrderValidationInput {
  t: (en: string, id: string) => string;
  isCar: boolean;
  isHeavy: boolean;
  nasabahName: string;
  make: string;
  model: string;
  modelYear: string;
  financingValue: string;
  otr: string;
  commercialBody: boolean;
  startDate: string;
  discountPct: string;
  discountCapPct: number;
  vehicleCondition: VehicleCondition;
  attachments: B2BAttachment[];
  policyCopyEnabled: boolean;
  policyCopyExpiry: string;
  today: string;
}

/** Validasi arab sebelum submit/unduh PDF. Pesan memakai bahasa UI yang aktif. */
export function validateB2BUnitOrder(v: B2BUnitOrderValidationInput): string | null {
  const { t } = v;
  if (!v.nasabahName.trim()) return t('Customer name is required.', 'Nama nasabah wajib diisi.');
  if (!v.isHeavy && !v.make.trim()) return t('Choose the vehicle brand.', 'Pilih merk kendaraan.');
  if (!v.isHeavy && !v.model.trim()) return t('Choose the vehicle type.', 'Pilih tipe kendaraan.');
  if (!v.financingValue || Number(v.financingValue) <= 0) {
    return t('Sum insured must be greater than zero.', 'Nilai pertanggungan (TSI) harus lebih dari nol.');
  }
  if (v.isCar && !v.commercialBody && (!v.otr || Number(v.otr) <= 0)) {
    return t('Passenger car needs OTR price for rate banding.', 'Mobil penumpang perlu harga OTR untuk penentuan kategori tarif.');
  }
  if (v.modelYear && (Number(v.modelYear) < 1950 || Number(v.modelYear) > 2100)) {
    return t('Year looks wrong.', 'Tahun kendaraan tidak masuk akal.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.startDate) || v.startDate < v.today || v.startDate > shiftDays(v.today, 60)) {
    return t('Effective date must be between today and 60 days ahead.', 'Tanggal efektif harus antara hari ini dan 60 hari ke depan.');
  }
  if (v.discountPct.trim() !== '') {
    const d = Number(v.discountPct.replace(',', '.'));
    if (!Number.isFinite(d) || d < 0 || d > v.discountCapPct) {
      return t(`Discount must be between 0 and ${v.discountCapPct}%.`, `Diskon harus antara 0 dan ${v.discountCapPct}%.`);
    }
  }
  if (!v.isHeavy && v.vehicleCondition === 'BARU' && !hasNewVehicleDocument(v.attachments)) {
    return t(
      'A new vehicle needs a BSTK or vehicle invoice attachment (photos are not required).',
      'Mobil baru wajib melampirkan BSTK atau faktur kendaraan (foto tidak diperlukan).',
    );
  }
  if (!v.isHeavy && v.vehicleCondition === 'BEKAS' && !hasEnoughUsedVehiclePhotos(v.attachments)) {
    return t(
      `Upload at least ${USED_VEHICLE_MIN_PHOTOS} vehicle photos (front, back, chassis number).`,
      `Unggah minimal ${USED_VEHICLE_MIN_PHOTOS} foto kendaraan (depan, belakang, nomor rangka).`,
    );
  }
  if (v.policyCopyEnabled) {
    if (!v.attachments.some(a => a.slot === POLICY_COPY_SLOT)) {
      return t('Attach a copy of the policy when you enable that option.', 'Lampirkan copy polis bila opsi tersebut diaktifkan.');
    }
    if (!isPolicyCopyStillValid(v.policyCopyExpiry, v.today)) {
      return t(
        'The attached policy copy must still be valid (expiry date today or later).',
        'Copy polis yang dilampirkan harus masih berlaku (tanggal berlaku hari ini atau setelahnya).',
      );
    }
  }
  return null;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Adapter: order unit B2B → format PDF aplikasi agent ────────────────────
export interface B2BUnitQuoteSource {
  companyName: string;
  nasabahName: string;
  nasabahPhone?: string;
  nasabahAddress?: string;
  contractNo?: string;
  vehicleClass: VehicleClass;
  vehicleCondition: VehicleCondition;
  make?: string;
  model?: string;
  modelYear?: number;
  plateNo?: string;
  engineNo?: string;
  chassisNo?: string;
  color?: string;
  financingValue: number;
  otr?: number;
  tenorMonths: number;
  coverageStartDate: string;
  coverageEndDate: string;
  insurerName?: string;
  insurerLogoUrl?: string;
  addons?: FleetAddOns;
  planName?: string;
  /** Nominal loading paket dalam RUPIAH (BuiltLineItem.planLoading), bukan loading_rate. */
  planLoading?: number;
  discountShown?: boolean;
  line: BuiltLineItem;
  attachments?: B2BAttachment[];
}

const ADDON_NAMES: Array<[keyof FleetAddOns, string]> = [
  ['flood', 'Banjir'],
  ['earthquake', 'Gempa Bumi'],
  ['srcc', 'Huru-hara / SRCC'],
  ['terrorism', 'Terorisme & Sabotase'],
  ['authorizedWorkshop', 'Bengkel Resmi / ATPM'],
  ['paDriver', 'PA Pengemudi'],
];

/**
 * Mapping ke struktur `QuotationSlipData` yang dipakai `generateQuotationSlipPDF`.
 * Karena generator/QR/publish-nya sama dengan agent, hasil PDF B2B pun identik.
 */
export function fromB2BUnitOrder(o: B2BUnitQuoteSource): QuotationSlipData {
  const isMotor = o.vehicleClass !== 'HEAVY_EQUIPMENT';
  const coverage: FleetCoverage = o.line.coverage;
  const insurerName = o.insurerName || 'PT Zurich Asuransi Indonesia Tbk';
  const insurerShort = insurerShortName(insurerName);
  const productName = isMotor
    ? `Asuransi Kendaraan Bermotor — ${coverage === 'TLO' ? 'TLO' : 'Comprehensive'}`
    : 'Asuransi Alat Berat — TLO';
  const addonLabels = ADDON_NAMES.filter(([key]) => Boolean(o.addons?.[key])).map(([, label]) => label);
  if ((o.addons?.tplLimit ?? 0) > 0) addonLabels.push('TPL');
  if ((o.addons?.paPassengerSeats ?? 0) > 0) addonLabels.push('PA Penumpang');
  if (o.planName) addonLabels.push(`Paket ${o.planName}`);
  // BuiltLineItem sudah memuat premi perluasan; loading paket dikirim terpisah
  // sebagai NOMINAL rupiah (bukan persentase loading_rate dari sp_b2b_plans).
  const addonPremium = o.line.addonPremium + (o.planLoading || 0);
  const extrasPremium = addonPremium;
  const rate = o.line.rate > 0 ? `${(o.line.rate * 100).toFixed(2).replace('.', ',')}%` : '-';
  const vehicleSummary = [o.make, o.model, o.modelYear].filter(Boolean).join(' ') || productName;
  const coverPhoto = o.attachments?.find(a => a.slot === 'depan' || a.slot === 'bstk' || a.slot === 'faktur')?.url;

  return {
    quotationNumber: quoteNumber(),
    slipType: 'PENUTUPAN ASURANSI',
    issueDate: fmtDateID(o.coverageStartDate),
    yearTag: String(new Date().getFullYear()),
    validUntil: plus30DaysISO(),

    productType: isMotor ? 'MOTOR' : 'OTHER',
    productName,
    objectSummary: vehicleSummary,
    ...(coverPhoto ? { coverPhotoUrl: coverPhoto } : {}),

    preparedForCompany: o.companyName,
    preparedForPerson: [o.nasabahName, o.nasabahPhone].filter(Boolean).join(' · '),
    previousPolicyNumber: o.contractNo || '-',
    insurer: insurerName,
    insurerShort,
    ...(o.insurerLogoUrl ? { insurerLogoUrl: o.insurerLogoUrl } : {}),

    agentName: 'Tim B2B SurePath',
    agentCode: 'B2B',

    periodStart: fmtDateID(o.coverageStartDate),
    periodEnd: fmtDateID(o.coverageEndDate),
    periodStartShort: fmtDateShortID(o.coverageStartDate),
    periodEndShort: fmtDateShortID(o.coverageEndDate),

    titleMain: 'Penawaran',
    titleMid: 'Asuransi',
    titleAccent: isMotor ? 'Kendaraan.' : 'Alat Berat.',
    ledeHtml: isMotor
      ? `Asuransi Kendaraan Bermotor — ${coverage === 'TLO' ? 'TLO' : 'Comprehensive'}. Penawaran proteksi kendaraan ${vehicleSummary} untuk ${o.nasabahName}, disiapkan oleh Tim B2B SurePath untuk ${o.companyName}.`
      : `Asuransi Alat Berat — TLO. Penawaran proteksi unit ${vehicleSummary} untuk ${o.nasabahName}, disiapkan oleh Tim B2B SurePath untuk ${o.companyName}.`,

    insuredName: o.nasabahName,
    insuredAddress: o.nasabahAddress || '-',
    vehicleBrand: o.make || '-',
    vehicleType: o.model || '-',
    vehicleYear: o.modelYear ? String(o.modelYear) : '-',
    engineNumber: o.engineNo || '-',
    chassisNumber: o.chassisNo || '-',
    plateNumber: o.plateNo || 'TBA',
    seats: o.vehicleClass === 'MOTORCYCLE' ? '2' : o.vehicleClass === 'HEAVY_EQUIPMENT' ? '1' : '5',
    color: o.color || '-',
    usage: o.vehicleClass === 'HEAVY_EQUIPMENT' ? 'Komersial / Alat Berat' : o.vehicleClass === 'MOTORCYCLE' ? 'Pribadi / Operasional' : 'Komersial / Operasional Perusahaan',

    coverageCondition: `${coverage === 'TLO' ? 'TLO (Total Loss Only)' : 'Comprehensive'} — menjamin kerugian/kerusakan sebagian maupun total akibat tabrakan, benturan, terbalik, tergelincir, perbuatan jahat, pencurian, dan kebakaran, sesuai Polis Standar Asuransi Kendaraan Bermotor Indonesia (PSAKBI).`,
    additionalCoverage: addonLabels.length > 0 ? addonLabels.join(', ') : 'Sesuai penutupan yang disepakati',
    deductible: coverage === 'TLO' ? 'Total Loss Only (TLO): 10% dari nilai klaim yang disetujui' : o.vehicleClass === 'MOTORCYCLE' ? 'Comprehensive Roda 2: Rp150.000 per kejadian' : o.vehicleClass === 'HEAVY_EQUIPMENT' ? 'Alat Berat: sesuai ketentuan polis' : 'Comprehensive: Rp300.000 per kejadian',
    klausulList: [
      'Klausul Penggantian Suku Cadang',
      'Klausul Bengkel Authorized',
      `Kondisi unit: ${o.vehicleCondition === 'BARU' ? 'Baru (BSTK/faktur)' : 'Bekas (foto & survey)'}`,
    ],

    sumInsuredItems: [
      { no: '1', desc: `Casco — ${vehicleSummary}`, amount: fmtIDR(o.financingValue) },
      { no: '2', desc: 'Tanggung Jawab Hukum Pihak Ketiga (TPL)', amount: fmtIDR(o.addons?.tplLimit ?? 0) },
    ],
    totalSumInsured: fmtIDR(Math.round(o.financingValue)),

    premiumComponents: [
      { component: `Casco — ${coverage}`, basis: `IDR ${fmtIDR(o.financingValue)}`, rate, premium: fmtIDR(o.line.premiumGross) },
      ...(extrasPremium > 0
        ? [{ component: 'Tambahan Jaminan & Paket', basis: `IDR ${fmtIDR(o.financingValue)}`, rate: '—', premium: fmtIDR(extrasPremium) }]
        : []),
    ],
    subtotalPremium: fmtIDR(o.line.premiumGross + extrasPremium),
    discountLabel: o.line.discountAmount > 0 ? 'Diskon Penawaran' : 'Diskon Penawaran 0%',
    discountAmount: o.line.discountAmount > 0 ? `(${fmtIDR(o.line.discountAmount)})` : '(0,00)',
    premiumAfterDiscount: fmtIDR(o.line.premiumAfterDiscount + extrasPremium),
    policyFee: fmtIDR(o.line.adminFee),
    // Mesin fleet B2B tidak memungut materai di total tagihan — jangan
    // menampilkan angka yang tidak ikut dihitung (agent memang memakai 10rb).
    stampDuty: '0,00',
    totalPremium: fmtIDR(o.line.totalPremium),

    subjectivityList: [
      o.vehicleCondition === 'BARU'
        ? 'BSTK/faktur kendaraan baru telah dilampirkan; foto kendaraan tidak diperlukan.'
        : 'Foto kendaraan terkini (tampak depan, belakang, samping kiri-kanan, interior, odometer, dan nomor rangka/mesin).',
      'Tidak ada kerugian/klaim yang diketahui atau dilaporkan (no known or reported losses) hingga tanggal mulai pertanggungan.',
      'SPPA (Surat Permintaan Penutupan Asuransi) diisi lengkap dan ditandatangani, dilampiri fotokopi STNK & KTP Tertanggung.',
      `Penutupan tunduk pada akseptasi dan persetujuan penuh dari Penanggung (subject to insurer's acceptance). Zone: ${o.line.zone}.`,
    ],

    termsList: [
      `Penawaran ini untuk penutupan asuransi atas kendaraan ${vehicleSummary} dengan penempatan pada ${insurerName}, mengikuti syarat dan kondisi Polis Standar Asuransi Kendaraan Bermotor Indonesia beserta klausul terlampir.`,
      'Penawaran berlaku selama 30 (tiga puluh) hari sejak tanggal penerbitan. Untuk menghindari terputusnya jaminan, konfirmasi dan pembayaran disarankan sebelum tanggal mulai pertanggungan.',
      `Rate premi menggunakan acuan tarif OJK (SEOJK 6/2017); rate ${rate}, band ${o.line.category ?? '-'}, zone ${o.line.zone}. Premi final mengikuti konfirmasi tertulis dari Penanggung.`,
      'Polis diterbitkan setelah subjectivity terpenuhi, konfirmasi penutupan, dan pembayaran premi diterima.',
      'Dokumen ini bukan surat konfirmasi penutupan; seluruh konfirmasi dan akseptasi merupakan kewenangan penuh Penanggung.',
    ],

    closingTitle: 'Lindungi Kendaraan Anda,',
    closingAccent: 'Sekarang Juga.',
    closingDesc: 'Konfirmasi penutupan ke Tim B2B SurePath, lengkapi dokumen, dan lakukan pembayaran sebelum tanggal mulai pertanggungan agar perlindungan berjalan tanpa terputus.',

    bankName: 'BANK BCA',
    bankNameShort: 'BCA',
    bankAccount: '5730 - 807 - 807',
    bankAccountName: 'PT. Ruang Proteksi Indonesia',
    paymentDueDate: fmtDateShortID(o.coverageStartDate),
    transferMemo: `${o.contractNo || 'QS/B2B'} — ${vehicleSummary} ${o.nasabahName}`.trim(),
  };
}
