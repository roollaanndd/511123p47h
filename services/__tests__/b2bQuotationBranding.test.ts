import { describe, expect, it } from 'vitest';
import { fromB2BQuote } from '../quotationSlipAdapter';

describe('B2B corporate quotation branding', () => {
  it('uses the server-resolved insurer logo and hides internal metadata', () => {
    const data = fromB2BQuote({
      id: '12345678-90ab-cdef-1234-567890abcdef',
      insurer_name: 'PT Sompo Insurance Indonesia',
      premium_amount: 125000000,
      coverage_details: {
        fleet_size: 52,
        coverage_type: 'Comprehensive',
        __insurer_id: 'insurer-123',
        __insurer_logo_url: 'https://cdn.example.com/sompo-logo.png',
      },
      valid_until: '2026-12-31',
      terms: 'Subject to underwriting.',
      created_at: '2026-11-28T07:00:00.000Z',
    }, 'PT Contoh Indonesia');

    expect(data.brandMode).toBe('INSURER');
    expect(data.insurerLogoUrl).toBe('https://cdn.example.com/sompo-logo.png');
    expect(data.insurer).toBe('PT Sompo Insurance Indonesia');
    expect(data.coverageCondition).toContain('Fleet Size: 52');
    expect(data.coverageCondition).not.toContain('__insurer');
    expect(data.objectDetails.some(row => row.label.includes('__INSURER'))).toBe(false);
    expect(data.termsList.join(' ')).toContain('PT Sompo Insurance Indonesia');
    expect(data.termsList.join(' ')).toContain('bukan polis atau bukti pertanggungan');
  });

  it('does not invent a default insurer or break legacy quotes without logo metadata', () => {
    const data = fromB2BQuote({
      id: '87654321-90ab-cdef-1234-567890abcdef',
      premium_amount: 5000000,
      coverage_details: { coverage_type: 'TLO' },
    }, 'PT Legacy Client');

    expect(data.insurer).toBe('Penanggung belum dipilih');
    expect(data.insurerLogoUrl).toBeUndefined();
    expect(data.brandMode).toBe('SUREPATH');
    expect(data.ledeHtml).toContain('Penanggung belum dipilih');
    expect(data.termsList.join(' ')).toContain('Penanggung belum dipilih');
  });
});
