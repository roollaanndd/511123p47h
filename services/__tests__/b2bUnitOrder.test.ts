// v2.9.13 — aturan lampiran order unit B2B & adapter PDF agent.
import { describe, it, expect } from 'vitest';
import {
  fromB2BUnitOrder, hasEnoughUsedVehiclePhotos, hasNewVehicleDocument,
  isPolicyCopyStillValid, validateB2BUnitOrder,
  type B2BAttachment, type B2BUnitOrderValidationInput,
} from '../b2bUnitOrder';
import type { BuiltLineItem } from '../b2bFleetRating';

const t = (en: string, _id: string) => en;
const today = '2026-11-18';

const attachment = (slot: string): B2BAttachment => ({
  slot, label: slot, url: `https://storage.example.com/${slot}`, size_bytes: 1024,
});

const baseValidation = (): B2BUnitOrderValidationInput => ({
  t,
  isCar: true,
  isHeavy: false,
  nasabahName: 'PT Debitur',
  make: 'Toyota',
  model: 'Avanza',
  modelYear: '2024',
  financingValue: '250000000',
  otr: '280000000',
  commercialBody: false,
  startDate: today,
  discountPct: '',
  discountCapPct: 15,
  vehicleCondition: 'BARU',
  attachments: [],
  policyCopyEnabled: false,
  policyCopyExpiry: '',
  today,
});

const line = {
  rowNo: 1,
  vehicleClass: 'CAR',
  zone: 2,
  zoneSource: 'plate' as const,
  flags: [],
  rate: 0.0025,
  category: 'MV',
  commercialBody: false,
  premiumGross: 625000,
  discountRate: 0.1,
  discountAmount: 62500,
  premiumAfterDiscount: 562500,
  adminFee: 50000,
  totalPremium: 637500,
  coverage: 'COMPREHENSIVE' as const,
  depreciationRate: 0,
  schedule: [],
  addonPremium: 25000,
  addonsDetail: { flood: 25000 },
  planLoading: 0,
} as unknown as BuiltLineItem;

describe('b2bUnitOrder — validasi lampiran', () => {
  it('menerima unit BARU dengan BSTK atau faktur tanpa foto', () => {
    expect(validateB2BUnitOrder(baseValidation())).toMatch(/BSTK or vehicle invoice/);
    expect(hasNewVehicleDocument([attachment('bstk')])).toBe(true);
    expect(hasNewVehicleDocument([attachment('faktur')])).toBe(true);
    expect(validateB2BUnitOrder({ ...baseValidation(), attachments: [attachment('bstk')] })).toBeNull();
  });

  it('menolak unit BEKAS sampai ada minimal 3 foto berlabel', () => {
    const input = { ...baseValidation(), vehicleCondition: 'BEKAS' as const };
    expect(validateB2BUnitOrder(input)).toMatch(/at least 3 vehicle photos/);
    expect(hasEnoughUsedVehiclePhotos([
      attachment('depan'), attachment('belakang'), attachment('stnk'),
    ])).toBe(false);
    expect(validateB2BUnitOrder({
      ...input,
      attachments: [attachment('depan'), attachment('belakang'), attachment('rangka')],
    })).toBeNull();
  });

  it('copy polis hanya boleh bila masih berlaku dan filenya dilampirkan', () => {
    expect(isPolicyCopyStillValid(today, today)).toBe(true);
    expect(isPolicyCopyStillValid('2026-11-17', today)).toBe(false);
    expect(isPolicyCopyStillValid('2026-11-19', today)).toBe(true);

    const base = {
      ...baseValidation(),
      attachments: [attachment('bstk')],
      policyCopyEnabled: true,
    };
    expect(validateB2BUnitOrder({ ...base, policyCopyExpiry: '2026-12-31' })).toMatch(/Attach a copy/);
    expect(validateB2BUnitOrder({
      ...base,
      attachments: [...base.attachments, attachment('copy-polis')],
      policyCopyExpiry: '2026-11-17',
    })).toMatch(/still be valid/);
    expect(validateB2BUnitOrder({
      ...base,
      attachments: [...base.attachments, attachment('copy-polis')],
      policyCopyExpiry: '2026-12-31',
    })).toBeNull();
  });
});

describe('b2bUnitOrder — adapter PDF agent', () => {
  it('memetakan order B2B ke format QuotationSlipData yang sama dengan agent', () => {
    const data = fromB2BUnitOrder({
      companyName: 'PT Contoh',
      nasabahName: 'Budi',
      vehicleClass: 'CAR',
      vehicleCondition: 'BARU',
      make: 'Toyota',
      model: 'Avanza',
      modelYear: 2024,
      plateNo: 'B 1234 XYZ',
      engineNo: '4A92-1',
      chassisNo: 'MHKFS4',
      color: 'Silver',
      financingValue: 250000000,
      otr: 280000000,
      tenorMonths: 12,
      coverageStartDate: '2026-11-18',
      coverageEndDate: '2027-11-18',
      insurerName: 'PT Zurich Asuransi Indonesia Tbk',
      planName: 'Standard',
      planLoading: 0,
      line,
      attachments: [attachment('bstk')],
    });

    expect(data.productType).toBe('MOTOR');
    expect(data.preparedForCompany).toBe('PT Contoh');
    expect(data.preparedForPerson).toContain('Budi');
    expect(data.insurerShort).toBe('Zurich');
    expect(data.vehicleBrand).toBe('Toyota');
    expect(data.engineNumber).toBe('4A92-1');
    expect(data.chassisNumber).toBe('MHKFS4');
    expect(data.coverPhotoUrl).toContain('bstk');
    expect(data.totalPremium).toContain('637.500,00');
    expect(data.premiumAfterDiscount).toContain('587.500,00');
    expect(data.stampDuty).toBe('0,00');
    expect(data.subjectivityList.join(' ')).toMatch(/BSTK\/faktur/);
    expect(data.klausulList.join(' ')).toMatch(/Baru/);
    // QR/e-quote diisi oleh publishAndDownloadQuotation, bukan adapter.
    expect(data.eQuoteCode).toBeUndefined();
  });
});
