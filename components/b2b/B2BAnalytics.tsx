// B2BAnalytics — roadmap #5 (v2.9.25): analitik belanja klien B2B.
//
// Semua perhitungan dilakukan di klien dari data yang sudah dimuat
// `B2BPortal.loadData()` (submissions, quotes, bulkBatches) — tidak menambah
// panggilan gateway baru. Ini memberi klien korporat ringkasan portofolio
// mereka: belanja berjalan, tren bulanan, bauran produk, konsentrasi
// penanggung, dan status batch — informasi yang sebelumnya hanya terlihat
// pada CMS admin.
//
// Grafik digambar sebagai SVG inline. Tanpa chart library — tema B2B tetap
// konsisten, tidak menambah vendor bundle, dan ukurannya sepenuhnya responsif.

import React, { useMemo } from 'react';
import { TrendingUp, Banknote, PieChart as PieIcon, Clock, Layers, Shield } from 'lucide-react';
import { Language } from '../../types';
import type { SpB2BSubmission, SpB2BQuote } from '../../services/supabaseService';
import type { SpB2BBatch } from '../../services/b2bBulk';
import { formatIDR } from '../car-wizard/WizardUI';
import { B2BGlass, B2BKpi, B2BSectionHeader } from './dashboard/ui';

interface Props {
  submissions: SpB2BSubmission[];
  quotes: SpB2BQuote[];
  bulkBatches: SpB2BBatch[];
  lang: Language;
}

const PRODUCT_LABEL: Record<string, { id: string; en: string; tone: string }> = {
  FLEET_MV:     { id: 'Fleet MV',    en: 'Fleet MV',    tone: '#4338ca' },
  BONDING:      { id: 'Bonding',     en: 'Bonding',     tone: '#8b5cf6' },
  GROUP_HEALTH: { id: 'Group Health',en: 'Group Health',tone: '#059669' },
};

const STATUS_TONE: Record<string, string> = {
  DRAFT:     '#64748b',
  SUBMITTED: '#0ea5e9',
  INVOICED:  '#f59e0b',
  PAID:      '#10b981',
  ISSUED:    '#059669',
  CANCELLED: '#ef4444',
};

// Kecil, reusable SVG horizontal bar row.
const HBar: React.FC<{ label: string; value: number; max: number; color: string; valueLabel?: string }> = ({ label, value, max, color, valueLabel }) => {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 2;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-bold text-slate-600 w-28 flex-shrink-0 truncate">{label}</span>
      <div className="flex-1 bg-slate-100 dark:bg-white/5 rounded-full h-2 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${w}%`, background: color }} />
      </div>
      <span className="text-xs font-black text-slate-900 dark:text-white tabular-nums w-20 text-right flex-shrink-0">
        {valueLabel ?? value.toLocaleString('id-ID')}
      </span>
    </div>
  );
};

// SVG vertical bar chart for monthly trends.
const MonthlyBars: React.FC<{ data: { label: string; value: number }[]; lang: Language }> = ({ data, lang }) => {
  const max = Math.max(1, ...data.map(d => d.value));
  const H = 140, W = 420, barW = W / data.length * 0.6;
  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} className="w-full h-auto" role="img" aria-label="Monthly premium">
      {data.map((d, i) => {
        const cx = (i + 0.5) * (W / data.length);
        const h = (d.value / max) * H;
        const y = H - h;
        return (
          <g key={d.label}>
            <rect
              x={cx - barW / 2} y={y} width={barW} height={h}
              rx="3"
              fill="url(#b2b-bar-grad)"
            />
            <text x={cx} y={H + 14} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 9, fontWeight: 700 }}>
              {d.label}
            </text>
          </g>
        );
      })}
      <defs>
        <linearGradient id="b2b-bar-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4338ca" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#4338ca" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {max > 0 && (
        <text x={W - 4} y={10} textAnchor="end" className="fill-slate-400" style={{ fontSize: 9, fontWeight: 600 }}>
          {lang === Language.EN ? 'max:' : 'maks:'} {formatIDR(max)}
        </text>
      )}
    </svg>
  );
};

const B2BAnalytics: React.FC<Props> = ({ submissions, quotes, bulkBatches, lang }) => {
  const t = (en: string, id: string) => (lang === Language.EN ? en : id);

  const stats = useMemo(() => {
    const paidBatches = bulkBatches.filter(b => b.status === 'PAID' || b.status === 'ISSUED');
    const openBatches = bulkBatches.filter(b => b.status === 'SUBMITTED' || b.status === 'INVOICED');
    const premiumYtd = paidBatches.reduce((s, b) => s + (b.total_amount ?? 0), 0);
    const openExposure = openBatches.reduce((s, b) => s + (b.total_amount ?? 0), 0);
    const avgPerBatch = paidBatches.length > 0 ? premiumYtd / paidBatches.length : 0;
    const totalUnits = bulkBatches.reduce((s, b) => s + (b.item_count ?? 0), 0);

    // Monthly (last 12 months) — bucketing paid batches by issued_at or paid created_at
    const now = new Date();
    const buckets = new Map<string, number>();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets.set(key, 0);
    }
    for (const b of paidBatches) {
      const iso = b.issued_at ?? b.updated_at ?? b.created_at;
      if (!iso) continue;
      const d = new Date(iso);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + (b.total_amount ?? 0));
    }
    const monthly = [...buckets.entries()].map(([key, value]) => {
      const [y, m] = key.split('-').map(Number);
      const dt = new Date(y, m - 1, 1);
      return {
        label: dt.toLocaleDateString(lang === Language.EN ? 'en-GB' : 'id-ID', { month: 'short' }),
        value,
      };
    });

    // Growth MoM: last month vs previous month
    const lastMonth = monthly[monthly.length - 1]?.value ?? 0;
    const prevMonth = monthly[monthly.length - 2]?.value ?? 0;
    const growthPct = prevMonth > 0 ? ((lastMonth - prevMonth) / prevMonth) * 100 : lastMonth > 0 ? 100 : 0;

    // Product mix (submissions)
    const productCounts: Record<string, number> = {};
    for (const s of submissions) {
      productCounts[s.product_type ?? 'OTHER'] = (productCounts[s.product_type ?? 'OTHER'] ?? 0) + 1;
    }

    // Top insurers (batches, paid + issued)
    const insurerPremium: Record<string, number> = {};
    for (const b of paidBatches) {
      const key = b.insurer_name ?? t('Unassigned', 'Belum ditugaskan');
      insurerPremium[key] = (insurerPremium[key] ?? 0) + (b.total_amount ?? 0);
    }
    const topInsurers = Object.entries(insurerPremium)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Status distribution (all batches)
    const statusCounts: Record<string, number> = {};
    for (const b of bulkBatches) {
      statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1;
    }

    return {
      premiumYtd, openExposure, avgPerBatch, totalUnits,
      paidCount: paidBatches.length, openCount: openBatches.length,
      monthly, lastMonth, growthPct,
      productCounts, topInsurers, statusCounts,
    };
  }, [submissions, quotes, bulkBatches, lang, t]);

  const productMax = Math.max(1, ...Object.values(stats.productCounts));
  const insurerMax = Math.max(1, ...stats.topInsurers.map(([, v]) => v));
  const statusMax = Math.max(1, ...Object.values(stats.statusCounts));

  return (
    <div className="max-w-7xl mx-auto space-y-5 pb-24">
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 b2b-stagger">
        <B2BKpi
          label={t('Premium YTD', 'Premi Lunas YTD')}
          value={stats.premiumYtd}
          hint={t(`${stats.paidCount} batch paid`, `${stats.paidCount} batch lunas`)}
          tone="success"
          icon={Banknote}
          format={formatIDR}
        />
        <B2BKpi
          label={t('Open exposure', 'Eksposur terbuka')}
          value={stats.openExposure}
          hint={t(`${stats.openCount} batch pending`, `${stats.openCount} batch berjalan`)}
          tone={stats.openCount > 0 ? 'warn' : 'default'}
          icon={Clock}
          format={formatIDR}
        />
        <B2BKpi
          label={t('Avg per batch', 'Rata-rata per batch')}
          value={stats.avgPerBatch}
          hint={t('all paid batches', 'seluruh batch lunas')}
          tone="accent"
          icon={PieIcon}
          format={formatIDR}
        />
        <B2BKpi
          label={t('Growth MoM', 'Pertumbuhan MoM')}
          value={Math.round(stats.growthPct)}
          hint={t(
            `Last month: ${formatIDR(stats.lastMonth)}`,
            `Bulan lalu: ${formatIDR(stats.lastMonth)}`,
          )}
          tone={stats.growthPct >= 0 ? 'success' : 'spark'}
          icon={TrendingUp}
          format={(n) => `${n >= 0 ? '+' : ''}${n}%`}
        />
      </div>

      {/* Monthly trend */}
      <B2BGlass className="p-6">
        <B2BSectionHeader
          title={t('12-Month Premium Trend', 'Tren Premi 12 Bulan')}
          subtitle={t('Based on paid or issued batches.', 'Berdasarkan batch yang telah lunas atau terbit.')}
        />
        <div className="pt-2">
          <MonthlyBars data={stats.monthly} lang={lang} />
        </div>
      </B2BGlass>

      {/* Product mix + Insurer concentration + Status distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
        <B2BGlass className="p-5">
          <B2BSectionHeader
            title={t('Product Mix', 'Bauran Produk')}
            subtitle={t('All submissions', 'Semua pengajuan')}
          />
          {Object.keys(stats.productCounts).length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">
              {t('No submissions yet.', 'Belum ada pengajuan.')}
            </p>
          ) : (
            <div className="space-y-3 pt-2">
              {Object.entries(stats.productCounts).sort((a, b) => b[1] - a[1]).map(([code, count]) => {
                const meta = PRODUCT_LABEL[code] ?? { id: code, en: code, tone: '#64748b' };
                return (
                  <HBar
                    key={code}
                    label={lang === Language.EN ? meta.en : meta.id}
                    value={count}
                    max={productMax}
                    color={meta.tone}
                  />
                );
              })}
            </div>
          )}
        </B2BGlass>

        <B2BGlass className="p-5">
          <B2BSectionHeader
            title={t('Top Insurers', 'Penanggung Teratas')}
            subtitle={t('By premium paid', 'Berdasarkan premi lunas')}
          />
          {stats.topInsurers.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">
              <Shield size={24} className="mx-auto text-slate-300 mb-2" />
              {t('No paid batches yet.', 'Belum ada batch lunas.')}
            </p>
          ) : (
            <div className="space-y-3 pt-2">
              {stats.topInsurers.map(([name, premium], i) => (
                <HBar
                  key={name}
                  label={name}
                  value={premium}
                  max={insurerMax}
                  color={['#4338ca', '#8b5cf6', '#059669', '#f59e0b', '#64748b'][i] ?? '#64748b'}
                  valueLabel={formatIDR(premium)}
                />
              ))}
            </div>
          )}
        </B2BGlass>

        <B2BGlass className="p-5">
          <B2BSectionHeader
            title={t('Batch Status', 'Status Batch')}
            subtitle={t('All time', 'Sepanjang waktu')}
          />
          {Object.keys(stats.statusCounts).length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">
              <Layers size={24} className="mx-auto text-slate-300 mb-2" />
              {t('No batches yet.', 'Belum ada batch.')}
            </p>
          ) : (
            <div className="space-y-3 pt-2">
              {Object.entries(stats.statusCounts).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
                <HBar
                  key={status}
                  label={status}
                  value={count}
                  max={statusMax}
                  color={STATUS_TONE[status] ?? '#64748b'}
                />
              ))}
            </div>
          )}
        </B2BGlass>
      </div>

      {/* Summary footer */}
      <div className="rounded-2xl border border-slate-200/70 bg-white/60 dark:bg-white/5 p-5">
        <p className="text-[11px] font-black uppercase tracking-widest text-slate-500 mb-3">
          {t('Portfolio Summary', 'Ringkasan Portofolio')}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <p className="text-slate-500">{t('Total units', 'Total unit')}</p>
            <p className="text-sm font-black text-slate-900 tabular-nums mt-0.5">{stats.totalUnits.toLocaleString('id-ID')}</p>
          </div>
          <div>
            <p className="text-slate-500">{t('All submissions', 'Semua pengajuan')}</p>
            <p className="text-sm font-black text-slate-900 tabular-nums mt-0.5">{submissions.length}</p>
          </div>
          <div>
            <p className="text-slate-500">{t('All batches', 'Semua batch')}</p>
            <p className="text-sm font-black text-slate-900 tabular-nums mt-0.5">{bulkBatches.length}</p>
          </div>
          <div>
            <p className="text-slate-500">{t('Active quotes', 'Penawaran aktif')}</p>
            <p className="text-sm font-black text-slate-900 tabular-nums mt-0.5">{quotes.filter(q => q.status === 'PENDING').length}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default B2BAnalytics;
