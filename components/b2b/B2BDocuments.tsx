// B2BDocuments — roadmap #2 (v2.9.25): pusat dokumen klien B2B.
//
// Satu layar menyatukan semua dokumen resmi klien korporat:
//   - Polis induk batch massal (`sp_b2b_batches.master_policy_document_url`)
//   - Invoice batch (`sp_payments.invoice_url` — datang dari layar Pembayaran,
//     tidak dioverlap di sini agar setiap layar punya fokus)
//
// Aksi gateway: `b2b_bulk_list_batches` dengan flag `include_master_policy_url`
// menandatangani path privat di bucket `b2b-documents` dan mengembalikan
// URL yang dapat diunduh langsung (berlaku 5 menit). Klien mengklik → browser
// unduh dalam tab baru. Tidak perlu N+1 permintaan.
//
// Pencarian + filter status disederhanakan: klien biasanya tahu nomor batch
// atau nomor polis induk, keduanya terindeks di client-side filter.

import React, { useEffect, useMemo, useState } from 'react';
import { FileText, Search, Download, FolderOpen, RefreshCw, Shield, AlertTriangle } from 'lucide-react';
import { Language } from '../../types';
import { getMyB2BBatchesWithDocuments, type SpB2BBatchWithSignedUrl } from '../../services/b2bBulk';
import { formatIDR } from '../car-wizard/WizardUI';
import { B2BGlass, B2BPill, B2BSectionHeader, type B2BPillTone } from './dashboard/ui';

interface Props { lang: Language }

const STATUS_TONE: Record<string, B2BPillTone> = {
  DRAFT:     'neutral',
  SUBMITTED: 'info',
  INVOICED:  'warn',
  PAID:      'success',
  ISSUED:    'success',
  CANCELLED: 'danger',
};

const STATUS_LABEL: Record<string, { id: string; en: string }> = {
  DRAFT:     { id: 'Draf',       en: 'Draft' },
  SUBMITTED: { id: 'Diajukan',   en: 'Submitted' },
  INVOICED:  { id: 'Ditagih',    en: 'Invoiced' },
  PAID:      { id: 'Lunas',      en: 'Paid' },
  ISSUED:    { id: 'Terbit',     en: 'Issued' },
  CANCELLED: { id: 'Batal',      en: 'Cancelled' },
};

const fmtDate = (iso: string | null | undefined, lang: Language) =>
  iso ? new Date(iso).toLocaleDateString(lang === Language.EN ? 'en-GB' : 'id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
  }) : '—';

const B2BDocuments: React.FC<Props> = ({ lang }) => {
  const t = (en: string, id: string) => (lang === Language.EN ? en : id);
  const [batches, setBatches] = useState<SpB2BBatchWithSignedUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [onlyIssued, setOnlyIssued] = useState(true);

  const load = async () => {
    setLoading(true);
    const data = await getMyB2BBatchesWithDocuments();
    setBatches(data);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    let rows = batches;
    if (onlyIssued) rows = rows.filter(b => b.status === 'ISSUED' && !!b.master_policy_signed_url);
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(b =>
        (b.batch_number?.toLowerCase().includes(q)) ||
        (b.master_policy_number?.toLowerCase().includes(q)) ||
        (b.insurer_name?.toLowerCase().includes(q))
      );
    }
    return rows;
  }, [batches, query, onlyIssued]);

  const issuedCount = batches.filter(b => b.status === 'ISSUED').length;
  const availableCount = batches.filter(b => b.status === 'ISSUED' && !!b.master_policy_signed_url).length;

  return (
    <div className="max-w-7xl mx-auto space-y-5 pb-24">
      {/* Header + counters */}
      <B2BGlass className="p-6">
        <B2BSectionHeader
          title={t('Documents Center', 'Pusat Dokumen')}
          subtitle={t(
            `${availableCount} master policy document(s) available for download.`,
            `${availableCount} polis induk tersedia untuk diunduh.`,
          )}
          action={
            <button
              type="button"
              onClick={load}
              disabled={loading}
              aria-label={t('Reload', 'Muat ulang')}
              className="inline-flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              {t('Reload', 'Muat ulang')}
            </button>
          }
        />

        {/* Search + filter */}
        <div className="flex gap-3 flex-wrap items-center pt-2">
          <div className="relative flex-1 min-w-[240px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('Search batch, master policy, insurer…', 'Cari batch, nomor polis, asuransi…')}
              className="w-full pl-9 pr-3 py-2 rounded-xl text-sm text-slate-900 outline-none bg-white/80 border border-indigo-200/60 focus:border-indigo-400"
            />
          </div>
          <label className="flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyIssued}
              onChange={e => setOnlyIssued(e.target.checked)}
              className="accent-indigo-600"
            />
            {t('Issued only', 'Hanya yang terbit')}
          </label>
        </div>
      </B2BGlass>

      {/* List */}
      {loading && batches.length === 0 ? (
        <B2BGlass className="p-10 text-center text-sm text-slate-500">
          {t('Loading documents…', 'Memuat dokumen…')}
        </B2BGlass>
      ) : filtered.length === 0 ? (
        <B2BGlass className="p-14 text-center">
          <FolderOpen size={32} className="mx-auto text-slate-400 mb-3" />
          <p className="text-sm text-slate-500">
            {batches.length === 0
              ? t('No batches yet.', 'Belum ada batch.')
              : onlyIssued && availableCount === 0
                ? t('No issued master policies yet.', 'Belum ada polis induk yang terbit.')
                : t('No documents match this filter.', 'Tidak ada dokumen sesuai filter.')}
          </p>
        </B2BGlass>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((b) => {
            const label = STATUS_LABEL[b.status] ?? { id: b.status, en: b.status };
            const tone = STATUS_TONE[b.status] ?? 'neutral';
            const canDownload = b.status === 'ISSUED' && !!b.master_policy_signed_url;
            const expired = !!b.master_policy_document_url && b.master_policy_document_url.startsWith('http');
            return (
              <B2BGlass key={b.id} className="p-5 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <p className="text-sm font-black text-slate-900 truncate" style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 12 }}>
                        {b.batch_number}
                      </p>
                      <B2BPill tone={tone}>
                        {lang === Language.EN ? label.en : label.id}
                      </B2BPill>
                    </div>
                    <p className="text-xs text-slate-600 truncate">{b.company_name}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5 tabular-nums">
                      {t('Items', 'Unit')}: {b.item_count} · {formatIDR(b.total_amount ?? 0)}
                    </p>
                  </div>
                  <div className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(99,102,241,0.08)' }}>
                    <FileText size={16} className="text-indigo-600" />
                  </div>
                </div>

                {/* Master policy info */}
                <div className="rounded-xl bg-slate-50/70 dark:bg-white/5 p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Shield size={11} className="text-emerald-600 flex-shrink-0" />
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                        {t('Master Policy', 'Polis Induk')}
                      </p>
                    </div>
                    {b.master_policy_number ? (
                      <p className="text-xs font-bold text-slate-900 truncate" style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 11 }}>
                        {b.master_policy_number}
                      </p>
                    ) : (
                      <p className="text-xs text-slate-500 italic">{t('Not yet issued', 'Belum terbit')}</p>
                    )}
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {b.insurer_name ?? t('Insurer not assigned', 'Asuransi belum ditugaskan')}
                      {b.issued_at && ` · ${fmtDate(b.issued_at, lang)}`}
                    </p>
                  </div>
                  {canDownload ? (
                    <a
                      href={b.master_policy_signed_url ?? '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest text-white"
                      style={{ background: 'linear-gradient(115deg, #4338ca 0%, #4f46e5 100%)' }}
                    >
                      <Download size={11} /> {t('Download', 'Unduh')}
                    </a>
                  ) : expired ? (
                    <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-amber-700" title={t('Legacy URL; please re-request from SurePath.', 'URL lama; hubungi SurePath untuk terbitkan ulang.')}>
                      <AlertTriangle size={11} /> {t('Legacy', 'Lama')}
                    </span>
                  ) : null}
                </div>
              </B2BGlass>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-slate-500 leading-relaxed text-center">
        {t(
          'Download links are signed URLs valid for 5 minutes. Reload the page to refresh them.',
          'Tautan unduh adalah URL bertanda tangan yang berlaku 5 menit. Muat ulang halaman untuk memperbarui.',
        )}
      </p>
    </div>
  );
};

export default B2BDocuments;
