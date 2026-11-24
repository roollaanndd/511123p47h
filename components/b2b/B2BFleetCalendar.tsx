// B2BFleetCalendar — roadmap #12: the fleet's renewal calendar.
//
// Every ISSUED policy order owned by the B2B client (gateway scopes to the
// caller) feeds the retention engine's queue, so the finance PIC sees WHICH
// units expire WHEN — grouped by month, triaged by urgency tier, exportable
// as CSV for the finance calendar. Honest scope note: units inside bulk
// batches only appear once they exist as policy orders (single unit orders
// and issued coverage); a batch_item→policy_order linkage is a planned
// migration, and this screen says so instead of pretending coverage.

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Download, AlertTriangle, ShieldCheck, Truck } from 'lucide-react';
import { Language } from '../../types';
import {
  getCustomerOrders, getMyB2BFleetRenewals, type B2BFleetRenewalItem,
} from '../../services/supabaseService';
import {
  buildRenewalQueue, TIER_LABEL_ID, TIER_LABEL_EN,
  formatEndDate, type RenewalCandidate,
} from '../../services/renewalEngine';
import { B2BGlass, B2BKpi, B2BPill, B2BButton, type B2BPillTone } from './dashboard/ui';

/** Deterministic CSV (finance-calendar paste). Bom-free: rows only. */
export function fleetCsv(queue: RenewalCandidate[]): string {
  const head = 'policy_number,product,end_date,tier,days_left';
  const rows = queue.map(q =>
    [q.policyNumber, `"${q.productName.replace(/"/g, '""')}"`, q.endDate.slice(0, 10), q.tier, String(q.daysLeft)].join(','),
  );
  return [head, ...rows].join('\n');
}

const TIER_TONE: Record<string, B2BPillTone> = {
  HEALTHY:  'success',
  SOON:     'warn',
  CRITICAL: 'warn',
  EXPIRED:  'danger',
};

// v2.9.29 — batch-unit renewal radar. A batch item has no policy order, so
// buildRenewalQueue() cannot see it; the gateway reads coverage_end_date from
// sp_b2b_batch_items directly and returns the urgency tier.
const RENEWAL_TONE: Record<B2BFleetRenewalItem['urgency'], B2BPillTone> = {
  CRITICAL: 'danger',
  SOON:     'warn',
  PLANNED:  'info',
};
const RENEWAL_LABEL: Record<B2BFleetRenewalItem['urgency'], { en: string; id: string }> = {
  CRITICAL: { en: 'Critical', id: 'Kritis' },
  SOON:     { en: 'Soon', id: 'Segera' },
  PLANNED:  { en: 'Planned', id: 'Terjadwal' },
};

interface Props { lang: Language }

const B2BFleetCalendar: React.FC<Props> = ({ lang }) => {
  const t = (en: string, id: string) => (lang === Language.EN ? en : id);
  const [orders, setOrders] = useState<Awaited<ReturnType<typeof getCustomerOrders>>>([]);
  const [loading, setLoading] = useState(true);
  const [renewals, setRenewals] = useState<B2BFleetRenewalItem[]>([]);
  const [renewalError, setRenewalError] = useState(false);

  useEffect(() => {
    let alive = true;
    getCustomerOrders('').then(o => { if (alive) setOrders(o); }).finally(() => { if (alive) setLoading(false); });
    getMyB2BFleetRenewals(90)
      .then(items => { if (alive) setRenewals(items); })
      // getMyB2BFleetRenewals() logs and returns [] on failure; a non-empty
      // failure would be indistinguishable, so the empty state never claims
      // "no renewals" without saying it may be incomplete.
      .catch(() => { if (alive) setRenewalError(true); });
    return () => { alive = false; };
  }, []);

  const queue = useMemo(() => buildRenewalQueue(orders), [orders]);
  const dueSoon = queue.filter(q => q.tier === 'CRITICAL' || q.tier === 'SOON').length;
  const expired = queue.filter(q => q.tier === 'EXPIRED').length;

  // Group by calendar month of end_date, chronologically.
  const months = useMemo(() => {
    const map = new Map<string, RenewalCandidate[]>();
    for (const q of queue) {
      const key = (q.endDate ?? '').slice(0, 7);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(q);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [queue]);

  const monthLabel = (key: string) => {
    const d = new Date(`${key}-01T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return key;
    return d.toLocaleDateString(lang === Language.EN ? 'en-GB' : 'id-ID', { month: 'long', year: 'numeric' });
  };

  const downloadCsv = () => {
    const blob = new Blob([fleetCsv(queue)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SurePath-Fleet-Renewal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-5 pb-24">
      {/* KPI row — B2B kit, tabular numerals via b2b-numerals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 lg:gap-4 b2b-stagger">
        <B2BKpi
          label={t('Covered units', 'Unit terlindungi')}
          value={queue.length}
          tone="success"
          icon={ShieldCheck}
        />
        <B2BKpi
          label={t('Due ≤30 days', 'Tempo ≤30 hari')}
          value={dueSoon}
          tone={dueSoon > 0 ? 'warn' : 'default'}
          icon={CalendarDays}
        />
        <B2BKpi
          label={t('Expired', 'Kedaluwarsa')}
          value={expired}
          tone={expired > 0 ? 'spark' : 'default'}
          icon={AlertTriangle}
        />
      </div>

      {/* CSV export — glass panel with primary action */}
      <B2BGlass className="p-5 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500 m-0 pr-3">
          {t('Renewal schedule for the finance calendar.', 'Jadwal perpanjangan untuk kalender keuangan.')}
        </p>
        <B2BButton
          variant="primary"
          icon={Download}
          onClick={downloadCsv}
          disabled={queue.length === 0}
        >
          CSV
        </B2BButton>
      </B2BGlass>

      {/* Renewal radar — units inside bulk batches (v2.9.29) */}
      <B2BGlass className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(79,70,229,0.08)' }}>
              <Truck size={16} className="text-indigo-600" />
            </div>
            <div>
              <p className="text-sm font-black text-slate-900">{t('Renewal radar — batch units', 'Radar perpanjangan — unit batch')}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {t('Batch vehicles whose cover ends within 90 days.', 'Kendaraan batch yang pertanggungannya berakhir dalam 90 hari.')}
              </p>
            </div>
          </div>
          <B2BPill tone={renewals.length > 0 ? 'warn' : 'neutral'}>
            {renewals.length} {t('units', 'unit')}
          </B2BPill>
        </div>

        {renewalError ? (
          <p className="text-xs text-amber-700 flex items-center gap-1.5">
            <AlertTriangle size={13} />
            {t('Renewal radar could not load. This list may be incomplete.',
               'Radar perpanjangan gagal dimuat. Daftar ini mungkin tidak lengkap.')}
          </p>
        ) : renewals.length === 0 ? (
          <p className="text-xs text-slate-500">
            {t('No batch unit cover ends in the next 90 days.',
               'Tidak ada pertanggungan unit batch yang berakhir dalam 90 hari ke depan.')}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {renewals.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-900 truncate">
                    {r.nasabah_name}
                    {r.plate_no && (
                      <span className="ml-2 font-mono text-[11px] text-slate-500">{r.plate_no}</span>
                    )}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate mt-0.5">
                    {[r.make, r.model].filter(Boolean).join(' ') || t('Vehicle', 'Kendaraan')}
                    {' · '}{r.batch_number ?? '—'}
                    {' · '}{t('ends', 'berakhir')} {formatEndDate(r.coverage_end_date, lang === Language.EN ? 'EN' : 'ID')}
                  </p>
                </div>
                <B2BPill tone={RENEWAL_TONE[r.urgency] ?? 'neutral'} className="flex-shrink-0">
                  {lang === Language.EN ? RENEWAL_LABEL[r.urgency].en : RENEWAL_LABEL[r.urgency].id}
                  {' · '}{Math.abs(r.days_remaining)}{t('d', 'h')}
                </B2BPill>
              </li>
            ))}
          </ul>
        )}
      </B2BGlass>

      {/* Month sections */}
      {loading ? (
        <B2BGlass className="p-10 text-center text-sm text-slate-500">
          {t('Loading fleet…', 'Memuat armada…')}
        </B2BGlass>
      ) : months.length === 0 ? (
        <B2BGlass className="p-10 text-center text-sm text-slate-500">
          {t('No issued unit policies yet.', 'Belum ada polis unit yang diterbitkan.')}
        </B2BGlass>
      ) : months.map(([key, units]) => (
        <section key={key} className="space-y-2">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-500">{monthLabel(key)}</p>
          <div className="space-y-2">
            {units.map(u => {
              const label = lang === Language.EN ? TIER_LABEL_EN[u.tier] : TIER_LABEL_ID[u.tier];
              const tone = TIER_TONE[u.tier] ?? 'neutral';
              const daySuffix = u.tier !== 'HEALTHY' ? ` · ${u.daysLeft < 0 ? Math.abs(u.daysLeft) : u.daysLeft}h` : '';
              return (
                <B2BGlass key={u.orderId} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-black text-slate-900 truncate" style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 12 }}>
                      {u.policyNumber}
                    </p>
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {u.productName} · {formatEndDate(u.endDate, lang === Language.EN ? 'EN' : 'ID')}
                    </p>
                  </div>
                  <B2BPill tone={tone} className="flex-shrink-0">
                    {label}{daySuffix}
                  </B2BPill>
                </B2BGlass>
              );
            })}
          </div>
        </section>
      ))}

      <p className="text-[11px] text-slate-500 leading-relaxed">
        {t('Units inside bulk batches appear here once issued as individual policies.',
           'Unit dalam batch massal muncul di sini setelah diterbitkan sebagai polis individual.')}
      </p>
    </div>
  );
};

export default B2BFleetCalendar;
