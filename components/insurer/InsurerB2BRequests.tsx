import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, CalendarClock, CheckCircle2, FileText, Info, Loader2, RefreshCw, Send, ShieldCheck, XCircle } from 'lucide-react';
import { useToast } from '../ui';
import {
  listInsurerB2BSubmissions,
  submitInsurerB2BDecision,
  type InsurerB2BSubmissionAssignment,
} from '../../services/insurerService';

interface Props {
  authToken: string;
  refreshTick: number;
}

const money = (value: number) => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0,
}).format(value);

const defaultValidity = () => {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
};

const safeSummary = (data: Record<string, unknown> | null | undefined) => Object.entries(data ?? {})
  .filter(([key, value]) => !key.startsWith('__') && key !== 'documents' && ['string', 'number', 'boolean'].includes(typeof value))
  .slice(0, 12);

const InsurerB2BRequests: React.FC<Props> = ({ authToken, refreshTick }) => {
  const toast = useToast();
  const [items, setItems] = useState<InsurerB2BSubmissionAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'QUOTE' | 'REQUEST_INFO' | 'DECLINE'>('QUOTE');
  const [premium, setPremium] = useState('');
  const [validUntil, setValidUntil] = useState(defaultValidity);
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setItems(await listInsurerB2BSubmissions(authToken));
    } catch (error) {
      console.error('Insurer B2B queue load failed:', error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { void load(); }, [load, refreshTick]);

  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const selected = useMemo(() => items.find(item => item.id === selectedId) ?? null, [items, selectedId]);
  const pendingCount = items.filter(item => item.status === 'ASSIGNED' || item.status === 'REQUEST_INFO').length;

  const resetForm = () => {
    setSelectedId(null);
    setDecision('QUOTE');
    setPremium('');
    setValidUntil(defaultValidity());
    setTerms('');
    setNotes('');
  };

  const submit = async () => {
    if (!selected || submitting) return;
    const amount = Number(premium);
    if (decision === 'QUOTE' && (!Number.isFinite(amount) || amount <= 0)) {
      toast.error('Masukkan premi yang valid dan lebih besar dari nol.');
      return;
    }
    if (decision === 'QUOTE' && (!validUntil || validUntil <= new Date().toISOString().slice(0, 10))) {
      toast.error('Tanggal berlaku penawaran harus di masa depan.');
      return;
    }
    if (decision !== 'QUOTE' && notes.trim().length < 5) {
      toast.error('Catatan wajib diisi minimal 5 karakter.');
      return;
    }

    setSubmitting(true);
    try {
      await submitInsurerB2BDecision(authToken, selected.id, {
        decision,
        premiumAmount: decision === 'QUOTE' ? amount : undefined,
        validUntil: decision === 'QUOTE' ? validUntil : undefined,
        terms: decision === 'QUOTE' ? terms : undefined,
        coverageDetails: decision === 'QUOTE' ? { underwriting_notes: notes.trim() || undefined } : undefined,
        notes,
      });
      toast.success(decision === 'QUOTE'
        ? 'Penawaran insurer berhasil dikirim ke SurePath dan portal klien B2B.'
        : decision === 'REQUEST_INFO'
          ? 'Permintaan informasi dikirim ke tim SurePath.'
          : 'Keputusan penolakan dikirim ke tim SurePath.');
      resetForm();
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Gagal mengirim keputusan insurer.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-4 space-y-4">
      <section className="rounded-2xl border border-ds-border dark:border-[#1E2D3D] bg-white dark:bg-[#0F1829] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center text-emerald-700 dark:text-emerald-400">
                <Building2 size={18} />
              </div>
              <div>
                <h2 className="text-sm font-black text-ds-ink dark:text-white">Corporate B2B Underwriting</h2>
                <p className="text-xs text-ds-ink3 mt-0.5">{items.length} assigned · {pendingCount} awaiting response</p>
              </div>
            </div>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="p-2 rounded-lg border border-ds-border dark:border-[#26354A] text-ds-ink3 hover:text-emerald-600 disabled:opacity-50" aria-label="Refresh B2B requests">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
        </div>
        <div className="mt-3 rounded-xl bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 p-3 flex gap-2">
          <Info size={15} className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
          <p className="text-[11px] leading-relaxed text-blue-800 dark:text-blue-200">
            Only submissions explicitly assigned to your insurer are shown. Quote terms and premiums are your insurer's underwriting response; SurePath does not generate or infer them.
          </p>
        </div>
      </section>

      {loadError ? (
        <section role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-bold">Unable to load corporate submissions.</p>
          <button type="button" onClick={() => void load()} className="mt-2 inline-flex items-center gap-2 text-xs font-bold underline"><RefreshCw size={13} /> Try again</button>
        </section>
      ) : loading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {[1, 2].map(n => <div key={n} className="h-32 rounded-2xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
        </div>
      ) : items.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-ds-border dark:border-[#26354A] p-10 text-center">
          <Building2 size={28} className="mx-auto text-ds-ink3" />
          <p className="mt-3 text-sm font-bold text-ds-ink dark:text-white">No corporate requests assigned</p>
          <p className="mt-1 text-xs text-ds-ink3">New requests assigned by SurePath operations will appear here.</p>
        </section>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map(item => {
            const s = item.submission;
            const active = selectedId === item.id;
            const isOpen = item.status === 'ASSIGNED' || item.status === 'REQUEST_INFO';
            return (
              <article key={item.id} className={`rounded-2xl border bg-white dark:bg-[#0F1829] p-4 space-y-3 ${active ? 'border-emerald-500 ring-2 ring-emerald-500/10' : 'border-ds-border dark:border-[#1E2D3D]'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-black text-ds-ink dark:text-white truncate">{s.company_name}</p>
                    <p className="text-[11px] text-ds-ink3 mt-0.5">{s.product_type.replace(/_/g, ' ')} · {new Date(s.created_at).toLocaleDateString('id-ID')}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-wider ${item.status === 'QUOTED' ? 'bg-emerald-100 text-emerald-700' : item.status === 'DECLINED' ? 'bg-rose-100 text-rose-700' : item.status === 'REQUEST_INFO' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{item.status.replace(/_/g, ' ')}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><p className="text-[9px] uppercase tracking-wider text-ds-ink3">PIC</p><p className="font-semibold text-ds-ink dark:text-white">{s.pic_name || '—'}</p></div>
                  <div><p className="text-[9px] uppercase tracking-wider text-ds-ink3">Contact</p><p className="font-semibold text-ds-ink dark:text-white">{s.pic_phone || s.pic_email || '—'}</p></div>
                </div>
                {item.decision_notes && <p className="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-2 text-[11px] text-ds-ink2 dark:text-slate-300">{item.decision_notes}</p>}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-ds-ink3">Assigned {new Date(item.created_at).toLocaleDateString('id-ID')}</span>
                  {isOpen && <button type="button" onClick={() => { setSelectedId(active ? null : item.id); setDecision('QUOTE'); }} className="rounded-lg bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white">{active ? 'Close response' : 'Review & respond'}</button>}
                  {!isOpen && <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700"><CheckCircle2 size={12} /> Response submitted</span>}
                </div>

                {active && isOpen && (
                  <div className="border-t border-ds-border dark:border-[#26354A] pt-3 space-y-3">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-ds-ink3 mb-2">Submitted risk information</p>
                      <div className="grid grid-cols-2 gap-2">
                        {safeSummary(s.submission_data).map(([key, value]) => (
                          <div key={key} className="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-2 min-w-0">
                            <p className="text-[9px] text-ds-ink3 uppercase tracking-wider truncate">{key.replace(/_/g, ' ')}</p>
                            <p className="text-[11px] font-semibold text-ds-ink dark:text-white break-words">{String(value)}</p>
                          </div>
                        ))}
                      </div>
                      {Array.isArray(s.documents) && s.documents.length > 0 && (
                        <div className="mt-3 space-y-1.5">
                          <p className="text-[9px] font-black uppercase tracking-wider text-ds-ink3">Supporting documents · secure links expire in 5 minutes</p>
                          {s.documents.map(doc => (
                            <div key={doc.id} className="flex items-center justify-between gap-2 rounded-lg border border-ds-border dark:border-[#26354A] px-2.5 py-2">
                              <span className="min-w-0 truncate text-[10px] text-ds-ink dark:text-white">{doc.doc_type.replace(/_/g, ' ')} · {doc.file_name}</span>
                              {doc.signed_url ? (
                                <a href={doc.signed_url} target="_blank" rel="noreferrer" className="shrink-0 text-[10px] font-bold text-emerald-700 dark:text-emerald-400 underline">Open</a>
                              ) : (
                                <span className="shrink-0 text-[9px] text-ds-ink3">Unavailable</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
                      {(['QUOTE', 'REQUEST_INFO', 'DECLINE'] as const).map(option => (
                        <button key={option} type="button" onClick={() => setDecision(option)} className={`flex-1 rounded-lg py-2 text-[9px] font-black uppercase tracking-wider ${decision === option ? 'bg-white dark:bg-slate-700 text-emerald-700 shadow-sm' : 'text-ds-ink3'}`}>{option === 'REQUEST_INFO' ? 'Request info' : option}</button>
                      ))}
                    </div>

                    {decision === 'QUOTE' ? (
                      <div className="space-y-2">
                        <label className="block text-[10px] font-bold text-ds-ink3">Premium (IDR)
                          <input type="number" min="1" step="1" value={premium} onChange={e => setPremium(e.target.value)} className="mt-1 w-full rounded-xl border border-ds-border dark:border-[#26354A] bg-white dark:bg-slate-900 px-3 py-2 text-sm text-ds-ink dark:text-white" placeholder="Enter insurer-approved premium" />
                        </label>
                        <label className="block text-[10px] font-bold text-ds-ink3">Quote valid until
                          <span className="mt-1 flex items-center gap-2 rounded-xl border border-ds-border dark:border-[#26354A] px-3 py-2"><CalendarClock size={14} /><input type="date" min={new Date().toISOString().slice(0, 10)} value={validUntil} onChange={e => setValidUntil(e.target.value)} className="w-full bg-transparent text-sm text-ds-ink dark:text-white outline-none" /></span>
                        </label>
                        <label className="block text-[10px] font-bold text-ds-ink3">Coverage / underwriting notes
                          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-ds-border dark:border-[#26354A] bg-white dark:bg-slate-900 px-3 py-2 text-xs text-ds-ink dark:text-white" placeholder="Coverage scope, deductibles, conditions…" />
                        </label>
                        <label className="block text-[10px] font-bold text-ds-ink3">Terms and exclusions
                          <textarea value={terms} onChange={e => setTerms(e.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-ds-border dark:border-[#26354A] bg-white dark:bg-slate-900 px-3 py-2 text-xs text-ds-ink dark:text-white" placeholder="Insurer's terms, exclusions and special conditions…" />
                        </label>
                      </div>
                    ) : (
                      <label className="block text-[10px] font-bold text-ds-ink3">{decision === 'REQUEST_INFO' ? 'Information required' : 'Reason for decline'}
                        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-ds-border dark:border-[#26354A] bg-white dark:bg-slate-900 px-3 py-2 text-xs text-ds-ink dark:text-white" placeholder="Enter clear notes for SurePath operations…" />
                      </label>
                    )}
                    <button type="button" onClick={() => void submit()} disabled={submitting} className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-xs font-black text-white disabled:opacity-50">
                      {submitting ? <Loader2 size={14} className="animate-spin" /> : decision === 'QUOTE' ? <Send size={14} /> : decision === 'DECLINE' ? <XCircle size={14} /> : <ShieldCheck size={14} />}
                      {submitting ? 'Submitting…' : decision === 'QUOTE' ? 'Submit insurer quotation' : decision === 'REQUEST_INFO' ? 'Request information' : 'Submit decline'}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default InsurerB2BRequests;
