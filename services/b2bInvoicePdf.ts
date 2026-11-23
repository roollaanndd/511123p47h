import type { QuotationSlipData } from './quotationSlipPdf';

export interface B2BInvoiceOptions {
  mode?: 'INVOICE' | 'QUOTATION';
  outputAction?: 'save' | 'print';
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  filename?: string;
}

const EMERALD: [number, number, number] = [13, 105, 56]; // #0D6938
const LIME: [number, number, number] = [112, 201, 58]; // #70C93A
const DARK: [number, number, number] = [24, 34, 46];
const MUTED: [number, number, number] = [100, 116, 139];
const BORDER: [number, number, number] = [214, 224, 218];
const SOFT_BG: [number, number, number] = [244, 249, 246];
const WHITE: [number, number, number] = [255, 255, 255];

async function loadLogoDataUrl(src = '/surepath-logo.png'): Promise<string | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function safeText(val?: string | null, fallback = '-'): string {
  const s = (val ?? '').trim();
  return s.length > 0 ? s : fallback;
}

export async function generateB2BInvoicePDF(
  data: QuotationSlipData,
  options: B2BInvoiceOptions = {},
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const mode = options.mode ?? 'INVOICE';
  const outputAction = options.outputAction ?? 'save';
  const isInvoice = mode === 'INVOICE';

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageW = 210;
  const pageH = 297;
  const margin = 12;
  const contentW = pageW - margin * 2;

  // Top accent bar
  doc.setFillColor(...EMERALD);
  doc.rect(0, 0, pageW, 3.5, 'F');
  doc.setFillColor(...LIME);
  doc.rect(pageW * 0.62, 0, pageW * 0.38, 3.5, 'F');

  // Header
  let y = 10;
  const logoDataUrl = await loadLogoDataUrl('/surepath-logo.png');
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, 'PNG', margin, y, 34, 11);
    } catch {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.setTextColor(...EMERALD);
      doc.text('SUREPATH', margin, y + 7);
    }
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...EMERALD);
    doc.text('SUREPATH', margin, y + 7);
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...DARK);
  doc.text('PT RUANG PROTEKSI INDONESIA', margin, y + 14.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.2);
  doc.setTextColor(...MUTED);
  doc.text('SurePath B2B Automotive & Fleet Protection Platform', margin, y + 18.2);

  // Title Badge Right
  const badgeW = 54;
  const badgeX = pageW - margin - badgeW;
  doc.setFillColor(...EMERALD);
  doc.roundedRect(badgeX, y, badgeW, 13, 2, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...WHITE);
  doc.text(isInvoice ? 'INVOICE' : 'QUOTATION', badgeX + badgeW / 2, y + 7.2, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(220, 248, 230);
  doc.text(isInvoice ? 'TAGIHAN PREMI ASURANSI' : 'PENAWARAN PREMI ASURANSI', badgeX + badgeW / 2, y + 11.2, {
    align: 'center',
  });

  y += 22;
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.35);
  doc.line(margin, y, pageW - margin, y);

  // Recipient Block
  y += 4;
  doc.setFillColor(...SOFT_BG);
  doc.setDrawColor(...BORDER);
  doc.roundedRect(margin, y, contentW, 20, 1.8, 1.8, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...EMERALD);
  doc.text('KEPADA YTH. / TERTANGGUNG', margin + 3.5, y + 4.8);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(...DARK);
  const recipientTitle = safeText(data.preparedForCompany || data.insuredName);
  doc.text(recipientTitle, margin + 3.5, y + 9.6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(...MUTED);
  const attn = data.preparedForPerson ? `Up: ${data.preparedForPerson}` : `Tertanggung: ${safeText(data.insuredName)}`;
  doc.text(attn, margin + 3.5, y + 13.8);
  const addrLines = doc.splitTextToSize(safeText(data.insuredAddress, 'Indonesia'), contentW - 75);
  doc.text(addrLines.slice(0, 2), margin + 3.5, y + 17.6);

  // Insurer Info on right side of recipient block
  const rightInfoX = pageW - margin - 66;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.3);
  doc.setTextColor(...EMERALD);
  doc.text('PENANGGUNG / INSURER', rightInfoX, y + 4.8);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...DARK);
  doc.text(safeText(data.insurerShort || data.insurer), rightInfoX, y + 9.6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text(`Periode: ${safeText(data.periodStart)} - ${safeText(data.periodEnd)}`, rightInfoX, y + 13.8);

  // 4 Meta Cards
  y += 23.5;
  const cardGap = 3;
  const cardW = (contentW - cardGap * 3) / 4;
  const cardH = 14.5;
  const metaCards = [
    {
      label: isInvoice ? 'No. Invoice' : 'No. Quotation',
      value: safeText(options.invoiceNumber || data.quotationNumber),
    },
    {
      label: isInvoice ? 'Tanggal Invoice' : 'Tanggal Terbit',
      value: safeText(options.invoiceDate || data.issueDate),
    },
    {
      label: 'Jatuh Tempo',
      value: safeText(options.dueDate || data.validUntil || data.issueDate),
    },
    {
      label: 'Jenis Pertanggungan',
      value: safeText(data.coverageCondition),
    },
  ];

  metaCards.forEach((card, idx) => {
    const cx = margin + idx * (cardW + cardGap);
    doc.setFillColor(...WHITE);
    doc.setDrawColor(...BORDER);
    doc.roundedRect(cx, y, cardW, cardH, 1.5, 1.5, 'FD');
    doc.setFillColor(...LIME);
    doc.rect(cx, y, cardW, 1.4, 'F');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(...MUTED);
    doc.text(card.label, cx + 2.5, y + 5.4);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.8);
    doc.setTextColor(...DARK);
    const valText = doc.splitTextToSize(card.value, cardW - 5);
    doc.text(valText[0] ?? '-', cx + 2.5, y + 10.8);
  });

  // 2-Column Section: Detail Kendaraan & Perhitungan Premi
  y += cardH + 4;
  const colGap = 4;
  const leftW = contentW * 0.48;
  const rightW = contentW - leftW - colGap;
  const leftX = margin;
  const rightX = margin + leftW + colGap;
  const tableH = 74;

  // Left Card: Detail Kendaraan
  doc.setFillColor(...WHITE);
  doc.setDrawColor(...BORDER);
  doc.roundedRect(leftX, y, leftW, tableH, 1.5, 1.5, 'FD');
  doc.setFillColor(...EMERALD);
  doc.roundedRect(leftX, y, leftW, 7, 1.5, 1.5, 'F');
  doc.rect(leftX, y + 4, leftW, 3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...WHITE);
  doc.text('DETAIL KENDARAAN & OBJEK', leftX + 3, y + 4.8);

  const vehicleRows: [string, string][] = [
    ['Merk / Tipe', `${safeText(data.vehicleBrand, '')} ${safeText(data.vehicleType, '')}`.trim() || '-'],
    ['Tahun Pembuatan', safeText(data.vehicleYear)],
    ['No. Polisi', safeText(data.plateNumber)],
    ['No. Rangka', safeText(data.chassisNumber)],
    ['No. Mesin', safeText(data.engineNumber)],
    ['Warna / Kursi', `${safeText(data.color)} / ${safeText(data.seats)}`],
    ['Penggunaan', safeText(data.usage)],
    ['Harga Pertanggungan', safeText(data.totalSumInsured)],
  ];

  let vy = y + 11.5;
  vehicleRows.forEach(([k, v], idx) => {
    if (idx % 2 === 1) {
      doc.setFillColor(248, 251, 249);
      doc.rect(leftX + 1, vy - 3.5, leftW - 2, 7.2, 'F');
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(...MUTED);
    doc.text(k, leftX + 3, vy);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.3);
    doc.setTextColor(...DARK);
    const wrapped = doc.splitTextToSize(v, leftW - 36);
    doc.text(wrapped[0] ?? '-', leftX + leftW - 3, vy, { align: 'right' });
    vy += 7.5;
  });

  // Right Card: Perhitungan Premi
  doc.setFillColor(...WHITE);
  doc.setDrawColor(...BORDER);
  doc.roundedRect(rightX, y, rightW, tableH, 1.5, 1.5, 'FD');
  doc.setFillColor(...EMERALD);
  doc.roundedRect(rightX, y, rightW, 7, 1.5, 1.5, 'F');
  doc.rect(rightX, y + 4, rightW, 3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...WHITE);
  doc.text('PERHITUNGAN PREMI', rightX + 3, y + 4.8);

  let py = y + 11.5;
  const maxComp = data.premiumComponents.slice(0, 6);
  maxComp.forEach((comp, idx) => {
    if (idx % 2 === 1) {
      doc.setFillColor(248, 251, 249);
      doc.rect(rightX + 1, py - 3.5, rightW - 2, 6.8, 'F');
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.1);
    doc.setTextColor(...DARK);
    const labelStr = comp.rate ? `${comp.component} (${comp.rate})` : comp.component;
    const clipped = doc.splitTextToSize(labelStr, rightW - 34);
    doc.text(clipped[0] ?? '-', rightX + 3, py);

    doc.setFont('helvetica', 'bold');
    doc.text(safeText(comp.premium), rightX + rightW - 3, py, { align: 'right' });
    py += 6.6;
  });

  // Summary rows at bottom of Perhitungan Premi
  const sumStartY = y + tableH - 21;
  doc.setDrawColor(...BORDER);
  doc.line(rightX + 2.5, sumStartY - 3, rightX + rightW - 2.5, sumStartY - 3);

  const summaryRows: [string, string][] = [
    ['Subtotal Premi', safeText(data.subtotalPremium)],
    [safeText(data.discountLabel, 'Diskon'), safeText(data.discountAmount, 'Rp 0')],
    ['Biaya Polis & Materai', `${safeText(data.policyFee, 'Rp 0')} + ${safeText(data.stampDuty, 'Rp 0')}`],
  ];
  let sy = sumStartY + 1;
  summaryRows.forEach(([label, val]) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(...MUTED);
    doc.text(label, rightX + 3, sy);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK);
    doc.text(val, rightX + rightW - 3, sy, { align: 'right' });
    sy += 5.8;
  });

  // Total Premi Pembayaran Banner
  y += tableH + 4;
  doc.setFillColor(...EMERALD);
  doc.roundedRect(margin, y, contentW, 13.5, 2, 2, 'F');
  doc.setFillColor(...LIME);
  doc.roundedRect(margin, y, 3.5, 13.5, 1, 1, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(220, 248, 230);
  doc.text('TOTAL PREMI PEMBAYARAN', margin + 7, y + 8.3);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13.5);
  doc.setTextColor(...WHITE);
  doc.text(safeText(data.totalPremium), pageW - margin - 5, y + 8.8, { align: 'right' });

  // Cakupan Jaminan & Perluasan + Keterangan Cards
  y += 17;
  const infoH = 44;
  doc.setFillColor(...WHITE);
  doc.setDrawColor(...BORDER);
  doc.roundedRect(leftX, y, leftW, infoH, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.8);
  doc.setTextColor(...EMERALD);
  doc.text('CAKUPAN JAMINAN & PERLUASAN', leftX + 3, y + 5.2);
  doc.setDrawColor(...BORDER);
  doc.line(leftX + 3, y + 7, leftX + leftW - 3, y + 7);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(...DARK);
  doc.text(`Kondisi: ${safeText(data.coverageCondition)}`, leftX + 3, y + 11.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  const addLines = doc.splitTextToSize(`Perluasan: ${safeText(data.additionalCoverage, 'Standar')}`, leftW - 6);
  doc.text(addLines.slice(0, 3), leftX + 3, y + 16);
  const dedLines = doc.splitTextToSize(`Risiko Sendiri (OR): ${safeText(data.deductible)}`, leftW - 6);
  doc.text(dedLines.slice(0, 3), leftX + 3, y + 29);

  doc.setFillColor(...WHITE);
  doc.setDrawColor(...BORDER);
  doc.roundedRect(rightX, y, rightW, infoH, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.8);
  doc.setTextColor(...EMERALD);
  doc.text('KETERANGAN & KLAUSULA', rightX + 3, y + 5.2);
  doc.setDrawColor(...BORDER);
  doc.line(rightX + 3, y + 7, rightX + rightW - 3, y + 7);

  const notes = [
    ...(data.klausulList ?? []).slice(0, 3),
    ...(data.subjectivityList ?? []).slice(0, 2),
  ].slice(0, 4);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.9);
  doc.setTextColor(...DARK);
  let ny = y + 11.5;
  if (notes.length === 0) {
    doc.text('• Syarat dan ketentuan polis standar asuransi berlaku.', rightX + 3, ny);
  } else {
    notes.forEach((n) => {
      const nLines = doc.splitTextToSize(`• ${n}`, rightW - 6);
      doc.text(nLines[0] ?? '', rightX + 3, ny);
      ny += 6.8;
    });
  }

  // Cara Pembayaran BCA Box
  y += infoH + 4;
  doc.setFillColor(...SOFT_BG);
  doc.setDrawColor(...EMERALD);
  doc.setLineWidth(0.45);
  doc.roundedRect(margin, y, contentW, 25, 1.8, 1.8, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...EMERALD);
  doc.text('CARA PEMBAYARAN (TRANSFER BANK)', margin + 4, y + 5.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.6);
  doc.setTextColor(...DARK);
  doc.text('Bank Transfer ke Rekening Resmi:', margin + 4, y + 10.8);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(...DARK);
  doc.text('PT RUANG PROTEKSI INDONESIA', margin + 4, y + 16);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...EMERALD);
  doc.text('BCA 5730-807-807', margin + 4, y + 21.2);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.6);
  doc.setTextColor(...MUTED);
  doc.text('BCA KCU Sudirman, Jakarta', margin + 52, y + 21.2);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.1);
  doc.setTextColor(...MUTED);
  doc.text(
    `Mohon cantumkan No. ${isInvoice ? 'Invoice' : 'Quotation'} (${safeText(options.invoiceNumber || data.quotationNumber)}) pada berita transfer.`,
    pageW - margin - 4,
    y + 16,
    { align: 'right' },
  );

  // Contact Footer
  const footerY = pageH - 12;
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);
  doc.line(margin, footerY - 3.5, pageW - margin, footerY - 3.5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(...EMERALD);
  doc.text('SurePath — PT Ruang Proteksi Indonesia', margin, footerY);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(...MUTED);
  doc.text(
    'surepath.id  |  support@surepath.id  |  Dokumen ini diterbitkan secara elektronik dan sah tanpa tanda tangan basah.',
    margin,
    footerY + 3.8,
  );
  doc.text('Halaman 1 dari 1', pageW - margin, footerY + 3.8, { align: 'right' });

  const defaultName = `${isInvoice ? 'SurePath-Invoice' : 'SurePath-Quotation'}-${safeText(
    options.invoiceNumber || data.quotationNumber,
    'document',
  ).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
  const filename = options.filename || defaultName;

  if (outputAction === 'print') {
    doc.autoPrint();
    const blobUrl = doc.output('bloburl');
    const win = typeof window !== 'undefined' ? window.open(blobUrl, '_blank') : null;
    if (!win) {
      doc.save(filename);
    }
  } else {
    doc.save(filename);
  }
}
