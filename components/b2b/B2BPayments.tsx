// B2BPayments — roadmap #3 (v2.9.24): riwayat pembayaran klien B2B.
// Satu layar menyatukan semua invoice: batch massal (sp_payments.batch_id) +
// pembayaran polis individual (sp_payments.order_id). Setiap baris
// menunjukkan judul dokumen, nilai, status, tanggal, dan tautan invoice
// Xendit (bila statusnya PENDING) atau waktu pembayaran (bila PAID).
//
// Datanya dihitung server-side via `b2b_my_payments` — klien tidak pernah
// melihat kolom privat (fee rinci sudah include di schema terbuka). Agregat
// 4-KPI ringkasan dihitung di client dari data yang sudah terfilter.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Banknote, RefreshCw, CheckCircle2, Clock, AlertCircle, ExternalLink, FileDown } from 'lucide-react';
import { Language } from '../../types';
import { getMyB2BPayments, type B2BPaymentEntry } from '../../services/b2bBulk';
import { formatIDR } from '../car-wizard/WizardUI';
import { B2BGlass, B2BKpi, B2BPill, B2BSectionHeader, type B2BPillTone } from './dashboard/ui';

interface Props { lang: Language }

const STATUS_META: Record<string, { tone: B2BPillTone; id: string; en: string; icon: typeof CheckCircle2 }> = {
  PAID:     { tone: 'success', id: 'Lunas',      en: 'Paid',     icon: CheckCircle2 },
  PENDING:  { tone: 'warn',    id: 'Menunggu',   en: 'Pending',  icon: Clock },
  EXPIRED:  { tone: 'danger',  id: 'Kedaluwarsa',en: 'Expired',  icon: AlertCircle },
  FAILED:   { tone: 'danger',  id: 'Gagal',      en: 'Failed',   icon: AlertCircle },
  REFUNDED: { tone: 'neutral', id: 'Dikembalikan',en: 'Refunded',icon: AlertCircle },
};

type FilterKey = 'ALL' | 'PAID' | 'PENDING' | 'OTHER';

const fmtDate = (iso: string | null, lang: Language) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(lang === Language.EN ? 'en-GB' : 'id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
};

const B2BPayments: React.FC<Props> = ({ lang }) => {
  const t = (en: string, id: string) => (lang === Language.EN ? en : id);
  const [rows, setRows] = useState<B2BPaymentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('ALL');
  // v2.9.27 — paginasi (gateway sekarang mengekspos limit/offset [1..200]).
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const PAGE_SIZE = 100;

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    const nextOffset = reset ? 0 : offset;
    const batch = await getMyB2BPayments({ limit: PAGE_SIZE, offset: nextOffset });
    setRows(prev => reset ? batch : [...prev, ...batch]);
    setHasMore(batch.length === PAGE_SIZE);
    setOffset(nextOffset + batch.length);
    setLoading(false);
  }, [offset]);

  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const { totalPaid, totalPending, paidCount, pendingCount } = useMemo(() => {
    let paid = 0, pending = 0, pc = 0, pdc = 0;
    for (const r of rows) {
      if (r.status === 'PAID') { paid += r.paid_amount ?? 0; pc += 1; }
      else if (r.status === 'PENDING') { pending += r.paid_amount ?? 0; pdc += 1; }
    }
    return { totalPaid: paid, totalPending: pending, paidCount: pc, pendingCount: pdc };
  }, [rows]);

  const visible = useMemo(() => {
    if (filter === 'ALL') return rows;
    if (filter === 'OTHER') return rows.filter(r => r.status !== 'PAID' && r.status !== 'PENDING');
    return rows.filter(r => r.status === filter);
  }, [rows, filter]);

  return (
    <div className="max-w-7xl mx-auto space-y-5 pb-24">
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 b2b-stagger">
        <B2BKpi
          label={t('Total paid', 'Total lunas')}
          value={totalPaid}
          hint={t(`${paidCount} invoice(s)`, `${paidCount} invoice`)}
          tone="success"
          icon={CheckCircle2}
          format={formatIDR}
        />
        <B2BKpi
          label={t('Pending', 'Menunggu bayar')}
          value={totalPending}
          hint={t(`${pendingCount} invoice(s)`, `${pendingCount} invoice`)}
          tone={pendingCount > 0 ? 'warn' : 'default'}
          icon={Clock}
          format={formatIDR}
        />
        <B2BKpi
          label={t('Transactions', 'Transaksi')}
          value={rows.length}
          hint={t('all time', 'sepanjang waktu')}
          tone="default"
          icon={Banknote}
        />
        <B2BKpi
          label={t('This month', 'Bulan ini')}
          value={rows.filter(r => {
            if (r.status !== 'PAID' || !r.paid_at) return false;
            const d = new Date(r.paid_at);
            const now = new Date();
            return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
          }).reduce((s, r) => s + (r.paid_amount ?? 0), 0)}
          hint={t('paid this month', 'lunas bulan ini')}
          tone="accent"
          icon={Banknote}
          format={formatIDR}
        />
      </div>

      {/* Filter row */}
      <B2BGlass className="p-5">
        <B2BSectionHeader
          title={t('Payment History', 'Riwayat Pembayaran')}
          subtitle={t('Invoices from bulk batches and individual policies.',
                      'Invoice dari batch massal dan polis individual.')}
          action={
            <button
              type="button"
              onClick={() => load(true)}
              disabled={loading}
              aria-label={t('Reload', 'Muat ulang')}
              className="inline-flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              {t('Reload', 'Muat ulang')}
            </button>
          }
        />

        <div className="flex gap-2 mb-4 overflow-x-auto">
          {(['ALL', 'PAID', 'PENDING', 'OTHER'] as FilterKey[]).map(k => {
            const active = filter === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`flex-shrink-0 px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-widest transition-colors ${
                  active ? 'bg-indigo-600 text-white' : 'bg-white/70 border border-indigo-200/70 text-slate-600 hover:text-indigo-700'
                }`}
              >
                {k === 'ALL' ? t('All', 'Semua') : k === 'OTHER' ? t('Other', 'Lainnya') : (STATUS_META[k] ? (lang === Language.EN ? STATUS_META[k].en : STATUS_META[k].id) : k)}
              </button>
            );
          })}
        </div>

        {loading && rows.length === 0 ? (
          <div className="py-14 text-center text-sm text-slate-500">
            {t('Loading payments…', 'Memuat pembayaran…')}
          </div>
        ) : visible.length === 0 ? (
          <div className="py-14 text-center">
            <Banknote size={28} className="mx-auto text-slate-400 mb-2" />
            <p className="text-sm text-slate-500">
              {filter === 'ALL'
                ? t('No payments yet.', 'Belum ada pembayaran.')
                : t('No payments match this filter.', 'Tidak ada pembayaran sesuai filter.')}
            </p>
          </div>
        ) : (
          <ol className="space-y-2">
            {visible.map((p) => {
              const meta = STATUS_META[p.status] ?? { tone: 'neutral' as B2BPillTone, id: p.status, en: p.status, icon: AlertCircle };
              const Icon = meta.icon;
              return (
                <li key={p.id} className="p-4 rounded-xl border border-slate-200/70 hover:bg-white/60 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-black text-slate-900 truncate">
                          {p._title}
                        </p>
                        <B2BPill tone={p._kind === 'batch' ? 'info' : 'accent'}>
                          {p._kind === 'batch' ? t('Batch', 'Batch') : t('Policy', 'Polis')}
                        </B2BPill>
                      </div>
                      {p._subtitle && (
                        <p className="text-xs text-slate-500 truncate mt-0.5">{p._subtitle}</p>
                      )}
                      <p className="text-[10px] text-slate-500 mt-1 tabular-nums">
                        {t('Created', 'Dibuat')}: {fmtDate(p.created_at, lang)}
                        {p.paid_at && ` · ${t('Paid', 'Lunas')}: ${fmtDate(p.paid_at, lang)}`}
                        {p.expired_at && p.status === 'PENDING' && ` · ${t('Expires', 'Kadaluarsa')}: ${fmtDate(p.expired_at, lang)}`}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-black text-slate-900 tabular-nums"
                         style={{ fontFamily: '"JetBrains Mono",monospace' }}>
                        {formatIDR(p.paid_amount ?? 0)}
                      </p>
                      <div className="mt-1 inline-flex items-center gap-1">
                        <Icon size={10} className="flex-shrink-0" />
                        <B2BPill tone={meta.tone}>
                          {lang === Language.EN ? meta.en : meta.id}
                        </B2BPill>
                      </div>
                    </div>
                  </div>

                  {/* Actions: pay now if pending, view invoice always when URL exists */}
                  {p.invoice_url && (
                    <div className="mt-3 pt-3 border-t border-slate-200/70 flex gap-2 flex-wrap">
                      {p.status === 'PENDING' && (
                        <a
                          href={p.invoice_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest text-white"
                          style={{ background: 'linear-gradient(115deg, #4338ca 0%, #4f46e5 100%)' }}
                        >
                          <ExternalLink size={11} /> {t('Pay now', 'Bayar sekarang')}
                        </a>
                      )}
                      <a
                        href={p.invoice_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-slate-700 bg-white border border-slate-200 hover:border-indigo-300"
                      >
                        <FileDown size={11} /> {t('View invoice', 'Lihat invoice')}
                      </a>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {hasMore && rows.length > 0 && (
          <div className="pt-4 flex justify-center">
            <button
              type="button"
              onClick={() => load(false)}
              disabled={loading}
              className="text-xs font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
            >
              {loading ? t('Loading…', 'Memuat…') : t('Load older', 'Muat lebih lama')}
            </button>
          </div>
        )}
      </B2BGlass>

      <p className="text-[11px] text-slate-500 leading-relaxed text-center">
        {t(
          'Invoices and receipts are issued by Xendit. For reconciliation questions contact SurePath finance.',
          'Invoice dan kuitansi diterbitkan oleh Xendit. Untuk pertanyaan rekonsiliasi, hubungi keuangan SurePath.',
        )}
      </p>
    </div>
  );
};

export default B2BPayments;
