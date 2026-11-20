// B2BAuditLog — roadmap #10 (v2.9.24): klien B2B melihat seluruh aktivitas
// akunnya sendiri tanpa perlu minta admin. Data berasal dari
// sp_b2b_activity_log (deny-all RLS) via gateway action `b2b_my_activity_log`
// yang otomatis memfilter ke client_id milik caller.
//
// Transparansi: setiap tindakan di sistem (impor massal, invoice dibuat,
// pembayaran, polis induk terbit, unduhan file sumber, dsb.) muncul di sini
// dengan stempel waktu — klien bisa mengaudit sendiri siapa melakukan apa
// dan kapan.

import React, { useEffect, useState, useCallback } from 'react';
import { History, RefreshCw, User, Shield, FileText, Download as DownloadIcon } from 'lucide-react';
import { Language } from '../../types';
import { getMyB2BActivity, type SpB2BActivityEntry } from '../../services/b2bBulk';
import { B2BGlass, B2BPill, B2BSectionHeader, type B2BPillTone } from './dashboard/ui';

interface Props { lang: Language }

// Label aksi yang manusiawi — mencerminkan daftar admin tetapi dari sudut
// pandang klien (admin yang menyentuh akun ditampilkan sebagai "Tim SurePath"
// bukan dengan nama admin, untuk melindungi privasi internal).
const ACTION_LABEL: Record<string, { id: string; en: string }> = {
  bulk_batch_created:                 { id: 'Pengajuan impor massal', en: 'Bulk batch created' },
  bulk_batch_viewed:                  { id: 'Detail batch dibuka',    en: 'Batch viewed' },
  bulk_invoice_created:               { id: 'Invoice dibuat',         en: 'Invoice created' },
  bulk_paid:                          { id: 'Pembayaran diterima',    en: 'Payment received' },
  bulk_invoice_expired:               { id: 'Invoice kadaluarsa',     en: 'Invoice expired' },
  bulk_insurer_assigned:              { id: 'Asuransi ditugaskan',    en: 'Insurer assigned' },
  bulk_master_policy_issued:          { id: 'Polis induk terbit',     en: 'Master policy issued' },
  bulk_insurer_uploaded_master_policy:{ id: 'Polis induk diunggah',   en: 'Master policy uploaded' },
  bulk_source_file_downloaded:        { id: 'File sumber diunduh',    en: 'Source file downloaded' },
};

const ACTOR_TONE: Record<string, B2BPillTone> = {
  B2B_CLIENT:   'info',
  ADMIN:        'accent',
  MASTER_ADMIN: 'accent',
  INSURER:      'warn',
  SYSTEM:       'neutral',
};

// Masking label aktor supaya klien tidak melihat nama admin internal.
const actorLabel = (role: string, lang: Language): string => {
  const en = lang === Language.EN;
  switch (role) {
    case 'B2B_CLIENT':   return en ? 'You' : 'Anda';
    case 'ADMIN':
    case 'MASTER_ADMIN': return en ? 'SurePath Team' : 'Tim SurePath';
    case 'INSURER':      return en ? 'Insurer' : 'Asuransi';
    case 'SYSTEM':       return 'System';
    default:             return role;
  }
};

const actionIcon = (action: string) => {
  if (action.startsWith('bulk_paid') || action.includes('invoice')) return FileText;
  if (action.includes('download')) return DownloadIcon;
  if (action.includes('policy') || action.includes('insurer')) return Shield;
  return History;
};

const fmtTime = (iso: string, lang: Language) => {
  const d = new Date(iso);
  return d.toLocaleString(lang === Language.EN ? 'en-GB' : 'id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const B2BAuditLog: React.FC<Props> = ({ lang }) => {
  const t = (en: string, id: string) => (lang === Language.EN ? en : id);
  const [entries, setEntries] = useState<SpB2BActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const PAGE_SIZE = 50;

  const load = useCallback(async (reset = false) => {
    setLoading(true);
    const nextOffset = reset ? 0 : offset;
    const batch = await getMyB2BActivity({ limit: PAGE_SIZE, offset: nextOffset });
    setEntries(prev => reset ? batch : [...prev, ...batch]);
    setHasMore(batch.length === PAGE_SIZE);
    setOffset(nextOffset + batch.length);
    setLoading(false);
  }, [offset]);

  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-24">
      <B2BGlass className="p-6">
        <B2BSectionHeader
          title={t('Activity Log', 'Riwayat Aktivitas')}
          subtitle={t(
            'Every action on your account, with a timestamp.',
            'Setiap tindakan pada akun Anda, berikut stempel waktunya.',
          )}
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

        {loading && entries.length === 0 ? (
          <div className="py-14 text-center text-sm text-slate-500">
            {t('Loading activity…', 'Memuat aktivitas…')}
          </div>
        ) : entries.length === 0 ? (
          <div className="py-14 text-center">
            <History size={28} className="mx-auto text-slate-400 mb-2" />
            <p className="text-sm text-slate-500">
              {t('No activity yet. Create a submission or batch to get started.',
                 'Belum ada aktivitas. Buat pengajuan atau batch untuk memulai.')}
            </p>
          </div>
        ) : (
          <ol className="space-y-2">
            {entries.map((e) => {
              const label = ACTION_LABEL[e.action];
              const Icon = actionIcon(e.action);
              const tone = ACTOR_TONE[e.actor_role] ?? 'neutral';
              return (
                <li key={e.id} className="flex items-start gap-3 p-3 rounded-xl hover:bg-white/60 transition-colors border border-slate-200/70">
                  <div
                    className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center"
                    style={{ background: 'rgba(99,102,241,0.08)' }}
                  >
                    <Icon size={14} className="text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-slate-900 truncate">
                        {label ? (lang === Language.EN ? label.en : label.id) : e.action}
                      </p>
                      <B2BPill tone={tone}>
                        <User size={10} className="inline mr-1" />
                        {actorLabel(e.actor_role, lang)}
                      </B2BPill>
                    </div>
                    {e.summary && (
                      <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{e.summary}</p>
                    )}
                    <p className="text-[10px] text-slate-500 mt-1 tabular-nums">
                      {fmtTime(e.created_at, lang)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {hasMore && entries.length > 0 && (
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
          'Internal staff actions are shown as "SurePath Team" to protect operator privacy.',
          'Tindakan staf internal ditampilkan sebagai "Tim SurePath" untuk melindungi privasi operator.',
        )}
      </p>
    </div>
  );
};

export default B2BAuditLog;
