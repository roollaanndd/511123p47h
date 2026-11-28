import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronDown, ChevronUp, Plus, Trash2, CheckCircle2, AlertTriangle, FileText, Heart, Upload, Loader2, Building2, Copy, KeyRound, FileDown, History, Pencil, ShieldOff, ShieldCheck, X, LayoutDashboard, Clock, FileCheck2, TrendingUp, Banknote, Users } from 'lucide-react';
import { AdminKpiCard } from './adminUI';
import {
  getAllB2BSubmissions,
  updateB2BSubmissionStatus,
  createB2BQuote,
  listActiveInsurers,
  getAllLifeApplications,
  updateLifeApplicationStatus,
  adminGetAllB2BBulkBatches,
  adminIssueB2BBulkBatch,
  adminAssignB2BBulkInsurer,
  uploadB2BBulkMasterPolicy,
  adminListB2BUsers,
  adminGetB2BUser,
  adminUpdateB2BUser,
  adminSetB2BUserActive,
  adminDeleteB2BUser,
  adminGetB2BBulkSourceUrl,
  adminListB2BActivity,
  adminCancelB2BBatch,
  adminExpireStaleB2BBatches,
  adminGetB2BBatchAging,
  type B2BBatchAging,
  setMitraTempPassword,
  supabase,
  type SpB2BSubmission,
  type SpB2BQuote,
  type SpInsurer,
  type SpLifeApplication,
  type SpB2BBatch,
  type SpB2BUser,
  type SpB2BUserDetail,
  type B2BProfileEdit,
  type SpB2BActivityEntry,
} from '../../services/supabaseService';
import ModuleIcon from '../shared/ModuleIcon';
import { useConfirmDialog, usePromptDialog } from '../ui';
import { getB2BBulkBatch, type SpB2BBatchItem } from '../../services/b2bBulk';
import AddUserWizard, { type WizardCredential } from './AddUserWizard';
import { FIELD_MATRIX } from './wizard/kycMatrix';

interface InsurerOption { id: string; name: string; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtIDR = (n: number) => 'Rp ' + n.toLocaleString('id-ID');
const fmtDate = (s?: string) => s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

// Sumber enum yang sama dengan AddUserWizard — jangan duplikat daftar industri.
const INDUSTRY_OPTIONS = FIELD_MATRIX.B2B_CLIENT.find(f => f.key === 'company_industry')?.options ?? [];

// ─── Badge maps ───────────────────────────────────────────────────────────────

const B2B_STATUS_CLS: Record<string, string> = {
  SUBMITTED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  REVIEWING: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  QUOTED:    'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  ACCEPTED:  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  REJECTED:  'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
};

const LIFE_STATUS_CLS: Record<string, string> = {
  SUBMITTED:   'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  UNDERWRITING:'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  APPROVED:    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  DECLINED:    'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  ISSUED:      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  DRAFT:       'bg-ds-card2 text-ds-ink2 dark:bg-slate-800 dark:text-ds-ink3',
};

const PRODUCT_TYPE_CLS: Record<string, string> = {
  FLEET_MV:     'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  BONDING:      'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  GROUP_HEALTH: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

const B2B_STATUSES = ['SUBMITTED', 'REVIEWING', 'QUOTED', 'ACCEPTED', 'REJECTED'];
const LIFE_STATUSES = ['SUBMITTED', 'UNDERWRITING', 'APPROVED', 'DECLINED', 'ISSUED'];

// ─── Toast ────────────────────────────────────────────────────────────────────

const Toast: React.FC<{ msg: string; onDone: () => void }> = ({ msg, onDone }) => {
  useEffect(() => { const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 bg-green-600 text-white rounded-2xl shadow-xl text-sm font-semibold animate-fade-in">
      <CheckCircle2 size={16} /> {msg}
    </div>
  );
};

// ─── Shared atoms ─────────────────────────────────────────────────────────────

const INPUT = 'w-full px-3 py-2 rounded-xl border border-ds-border dark:border-ds-border bg-white dark:bg-ds-card2 text-ds-ink dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400';
const TEXTAREA = INPUT + ' resize-none';

const Badge: React.FC<{ cls: string; label: string }> = ({ cls, label }) => (
  <span className={`text-2xs font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${cls}`}>{label}</span>
);

// ─── B2B Quote Form ───────────────────────────────────────────────────────────

interface QuoteFormProps {
  submissionId: string;
  clientId: string;
  productType: SpB2BSubmission['product_type'];
  onSaved: () => void;
  onClose: () => void;
}

const QuoteForm: React.FC<QuoteFormProps> = ({ submissionId, clientId, productType, onSaved, onClose }) => {
  const [insurers, setInsurers] = useState<SpInsurer[]>([]);
  const [selectedInsurerId, setSelectedInsurerId] = useState('');
  const [loadingInsurers, setLoadingInsurers] = useState(true);
  const [premiumAmount, setPremiumAmount] = useState(0);
  const [validUntil, setValidUntil] = useState('');
  const [terms, setTerms] = useState('');
  const [rows, setRows] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLoadingInsurers(true);
    listActiveInsurers()
      .then(items => { if (alive) setInsurers(items); })
      .catch(error => { console.error('Unable to load active B2B insurers:', error); if (alive) setInsurers([]); })
      .finally(() => { if (alive) setLoadingInsurers(false); });
    return () => { alive = false; };
  }, []);

  const selectedInsurer = insurers.find(insurer => insurer.id === selectedInsurerId) ?? null;
  const addRow = () => { if (rows.length < 10) setRows(r => [...r, { key: '', value: '' }]); };
  const removeRow = (i: number) => setRows(r => r.filter((_, idx) => idx !== i));
  const updateRow = (i: number, field: 'key' | 'value', val: string) =>
    setRows(r => r.map((row, idx) => idx === i ? { ...row, [field]: val } : row));

  const save = async () => {
    if (!selectedInsurer) { setErr('Select an active insurer.'); return; }
    if (!selectedInsurer.logo_url) { setErr('This insurer has no official logo configured. Update its insurer profile before issuing a branded quote.'); return; }
    if (!Number.isFinite(premiumAmount) || premiumAmount <= 0 || !validUntil) {
      setErr('A positive premium and valid-until date are required.');
      return;
    }
    setSaving(true);
    setErr('');
    const coverageDetails: Record<string, string> = {};
    rows.filter(r => r.key.trim()).forEach(r => { coverageDetails[r.key.trim()] = r.value; });
    const quoteData: Omit<SpB2BQuote, 'id' | 'created_at' | 'updated_at'> = {
      submission_id: submissionId,
      client_id: clientId,
      insurer_id: selectedInsurer.id,
      insurer_name: selectedInsurer.name,
      premium_amount: premiumAmount,
      coverage_details: coverageDetails,
      valid_until: validUntil,
      terms,
      status: 'PENDING',
    };
    const ok = await createB2BQuote(quoteData);
    if (ok) {
      await updateB2BSubmissionStatus(submissionId, 'QUOTED');
      onSaved();
    } else {
      setErr('Failed to save quote. Please try again.');
    }
    setSaving(false);
  };

  return (
    <div className="mt-3 p-4 bg-slate-50 dark:bg-ds-card2 border border-ds-border dark:border-ds-border rounded-2xl space-y-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-bold text-ds-ink dark:text-white">Create insurer quotation</p>
        <button onClick={onClose} className="text-ds-ink3 hover:text-ds-ink2"><ChevronUp size={16} /></button>
      </div>
      {err && <p role="alert" className="text-xs text-rose-700 dark:text-rose-200 flex items-center gap-1"><AlertTriangle size={12} />{err}</p>}
      <div className="rounded-xl border border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/20 p-3 text-xs text-sky-900 dark:text-sky-100">
        {productType === 'FLEET_MV'
          ? 'This fleet request contains aggregate unit count and fleet value, not a validated per-vehicle schedule. Enter the premium from the reviewed insurer/underwriter quotation; do not infer a per-unit OJK rate from the aggregate value. Use B2B Unit Order or Bulk Import for server-recalculated per-vehicle pricing.'
          : 'Enter the premium returned by the insurer/underwriter after reviewing the submitted risk details. This form does not invent a rate or replace insurer underwriting.'}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-semibold text-ds-ink3 mb-1">Active Insurer</label>
          <select
            value={selectedInsurerId}
            onChange={e => setSelectedInsurerId(e.target.value)}
            disabled={loadingInsurers || saving}
            className={INPUT}
          >
            <option value="">{loadingInsurers ? 'Loading insurers…' : 'Select an active insurer'}</option>
            {insurers.map(insurer => <option key={insurer.id} value={insurer.id}>{insurer.name}</option>)}
          </select>
          {selectedInsurer && (
            <div className="mt-2 flex items-center gap-3 rounded-xl border border-ds-border bg-white dark:bg-ds-card2 p-3">
              {selectedInsurer.logo_url
                ? <img src={selectedInsurer.logo_url} alt={selectedInsurer.name + ' logo'} className="h-9 max-w-28 object-contain" />
                : <AlertTriangle size={16} className="text-amber-600" />}
              <div className="min-w-0">
                <p className="text-xs font-bold text-ds-ink dark:text-white">{selectedInsurer.name}</p>
                <p className="text-2xs text-ds-ink3">{selectedInsurer.logo_url ? 'Official logo configured' : 'Official logo missing — branded quotation is blocked'}</p>
              </div>
            </div>
          )}
          {!loadingInsurers && insurers.length === 0 && (
            <p className="mt-1 text-xs text-rose-600">No active insurers are available. Check insurer configuration.</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-semibold text-ds-ink3 mb-1">Insurer / Underwriter Premium (IDR)</label>
          <input type="number" min="1" value={premiumAmount} onChange={e => setPremiumAmount(Number(e.target.value))} className={INPUT} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ds-ink3 mb-1">Valid Until</label>
          <input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} className={INPUT} />
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold text-ds-ink3">Coverage Details</label>
          <button onClick={addRow} className="text-xs text-ds-green font-semibold flex items-center gap-1"><Plus size={12} />Add Row</button>
        </div>
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input value={row.key} onChange={e => updateRow(i, 'key', e.target.value)} placeholder="Key" className={INPUT + ' flex-1'} />
              <input value={row.value} onChange={e => updateRow(i, 'value', e.target.value)} placeholder="Value" className={INPUT + ' flex-1'} />
              {rows.length > 1 && <button onClick={() => removeRow(i)}><Trash2 size={14} className="text-rose-700 dark:text-rose-300" /></button>}
            </div>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-ds-ink3 mb-1">Terms</label>
        <textarea value={terms} onChange={e => setTerms(e.target.value)} rows={3} className={TEXTAREA} />
      </div>
      <button
        onClick={save} disabled={saving || loadingInsurers || !selectedInsurer || !selectedInsurer.logo_url}
        className="w-full py-2.5 rounded-xl bg-emerald-500 text-white font-semibold text-sm disabled:opacity-40 flex items-center justify-center gap-2"
      >
        {saving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
        Save Insurer Quotation
      </button>
    </div>
  );
};

// ─── B2B Submission Card ──────────────────────────────────────────────────────

const B2BCard: React.FC<{ sub: SpB2BSubmission; onUpdated: () => void; onToast: (m: string) => void }> = ({ sub, onUpdated, onToast }) => {
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const [status, setStatus] = useState(sub.status);
  const [notes, setNotes] = useState(sub.admin_notes ?? '');
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const changeStatus = async (s: string) => {
    setStatus(s as SpB2BSubmission['status']);
    setUpdatingStatus(true);
    await updateB2BSubmissionStatus(sub.id, s);
    setUpdatingStatus(false);
    onToast('Status updated');
    onUpdated();
  };

  const saveNotes = async () => {
    await updateB2BSubmissionStatus(sub.id, status, notes);
    onToast('Notes saved');
  };

  const docs: { doc_type?: string; filename?: string }[] = (sub.submission_data?.documents as unknown[])?.map?.(d => d as { doc_type?: string; filename?: string }) ?? [];

  return (
    <div className="p-4 bg-white dark:bg-ds-card2 border border-ds-border dark:border-ds-border rounded-2xl space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Badge cls={PRODUCT_TYPE_CLS[sub.product_type] ?? ''} label={sub.product_type} />
            <Badge cls={B2B_STATUS_CLS[status] ?? ''} label={status} />
          </div>
          <p className="font-bold text-ds-ink dark:text-white text-sm">{sub.company_name}</p>
          <p className="text-xs text-ds-ink3">{sub.pic_name} · {sub.pic_phone}</p>
          <p className="text-xs text-ds-ink3">{fmtDate(sub.created_at)}</p>
        </div>
        {updatingStatus && <RefreshCw size={14} className="text-ds-ink3 animate-spin flex-shrink-0 mt-1" />}
      </div>

      {/* Status Dropdown */}
      <div>
        <label className="block text-2xs font-semibold text-ds-ink3 uppercase mb-1">Change Status</label>
        <div className="relative">
          <select
            value={status}
            onChange={e => changeStatus(e.target.value)}
            className="w-full appearance-none px-3 py-2 pr-8 rounded-xl border border-ds-border dark:border-ds-border bg-white dark:bg-ds-card2 text-ds-ink dark:text-white text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            {B2B_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-ds-ink3 pointer-events-none" />
        </div>
      </div>

      {/* Admin Notes */}
      <div>
        <label className="block text-2xs font-semibold text-ds-ink3 uppercase mb-1">Admin Notes</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={saveNotes}
          rows={2}
          className={TEXTAREA}
          placeholder="Internal notes…"
        />
      </div>

      {/* Documents */}
      {docs.length > 0 && (
        <div>
          <p className="text-2xs font-semibold text-ds-ink3 uppercase mb-1">Documents</p>
          <div className="flex flex-wrap gap-1.5">
            {docs.map((d, i) => (
              <span key={i} className="flex items-center gap-1 text-xs px-2 py-1 bg-ds-card2 dark:bg-ds-card2 rounded-lg text-ds-ink2 dark:text-ds-ink2">
                <FileText size={10} />{d.doc_type ?? 'doc'}: {d.filename ?? '—'}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Add Quote Button */}
      <button
        onClick={() => setShowQuoteForm(v => !v)}
        className="flex items-center gap-2 text-xs font-semibold text-ds-green hover:underline"
      >
        {showQuoteForm ? <ChevronUp size={14} /> : <Plus size={14} />}
        {showQuoteForm ? 'Close Quote Form' : 'Add Quote'}
      </button>

      {showQuoteForm && (
        <QuoteForm
          submissionId={sub.id}
          clientId={sub.client_id}
          productType={sub.product_type}
          onSaved={() => { setShowQuoteForm(false); onToast('Quote saved — status set to QUOTED'); onUpdated(); }}
          onClose={() => setShowQuoteForm(false)}
        />
      )}
    </div>
  );
};

// ─── Life Application Card ────────────────────────────────────────────────────

const LifeCard: React.FC<{ app: SpLifeApplication; onUpdated: () => void; onToast: (m: string) => void }> = ({ app, onUpdated, onToast }) => {
  const [status, setStatus] = useState(app.status);
  const [notes, setNotes] = useState(app.insurer_notes ?? '');
  const [policyNumber, setPolicyNumber] = useState(app.policy_number ?? '');
  const [saving, setSaving] = useState(false);

  const age = (() => {
    if (!app.client_dob) return '?';
    const today = new Date();
    const birth = new Date(app.client_dob);
    return today.getFullYear() - birth.getFullYear();
  })();

  const yesAnswers = Object.entries(app.health_declaration).filter(([, v]) => v).map(([k]) => Number(k));
  const showPolicyNumber = status === 'APPROVED' || status === 'ISSUED';

  const handleUpdate = async () => {
    setSaving(true);
    const ok = await updateLifeApplicationStatus(app.id, status, notes, showPolicyNumber ? policyNumber : undefined);
    setSaving(false);
    if (ok) { onToast('Application updated'); onUpdated(); }
  };

  return (
    <div className="p-4 bg-white dark:bg-ds-card2 border border-ds-border dark:border-ds-border rounded-2xl space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-2xs font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-orange-100 text-orange-800 dark:text-orange-300 dark:bg-orange-900/30 dark:text-orange-400 font-mono">{app.order_number}</span>
            <Badge cls={LIFE_STATUS_CLS[status] ?? ''} label={status} />
          </div>
          <p className="font-bold text-ds-ink dark:text-white text-sm">{app.client_name}</p>
          <p className="text-xs text-ds-ink3">{age} yo · {app.client_gender === 'M' ? 'Male' : 'Female'} · {app.smoker ? 'Smoker' : 'Non-smoker'}</p>
          <p className="text-xs text-ds-ink3">{app.product_code.replace('_', ' ')} · UP {fmtIDR(app.sum_assured)}</p>
          <p className="text-xs text-ds-ink3">Indicative premium/yr: {fmtIDR(app.indicative_premium)}</p>
        </div>
        <Heart size={16} className="text-rose-700 dark:text-rose-300 flex-shrink-0 mt-1" />
      </div>

      {/* Riders */}
      {app.riders.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {app.riders.map(r => (
            <span key={r} className="text-2xs px-2 py-0.5 bg-orange-50 dark:bg-orange-900/10 text-orange-800 dark:text-orange-300 dark:text-orange-400 rounded-full font-semibold">{r.replace('_', ' ')}</span>
          ))}
        </div>
      )}

      {/* Health — Yes answers highlighted */}
      {yesAnswers.length > 0 && (
        <div className="p-2 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-500/20 rounded-xl">
          <p className="text-2xs font-semibold text-ds-amber uppercase mb-1 flex items-center gap-1"><AlertTriangle size={10} />Health Flags</p>
          {yesAnswers.map(qi => (
            <p key={qi} className="text-xs text-amber-700 dark:text-amber-400">Q{qi + 1}: Yes</p>
          ))}
        </div>
      )}

      {/* Beneficiary */}
      <div className="text-xs text-ds-ink3">
        Beneficiary: <span className="font-semibold text-ds-ink2 dark:text-ds-ink2">{app.beneficiary_name}</span> ({app.beneficiary_relation}, {app.beneficiary_percentage}%)
      </div>

      {/* Status Update */}
      <div>
        <label className="block text-2xs font-semibold text-ds-ink3 uppercase mb-1">Change Status</label>
        <div className="relative">
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="w-full appearance-none px-3 py-2 pr-8 rounded-xl border border-ds-border dark:border-ds-border bg-white dark:bg-ds-card2 text-ds-ink dark:text-white text-xs font-semibold focus:outline-none"
          >
            {LIFE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-ds-ink3 pointer-events-none" />
        </div>
      </div>

      {/* Policy Number */}
      {showPolicyNumber && (
        <div>
          <label className="block text-2xs font-semibold text-ds-ink3 uppercase mb-1">Policy Number</label>
          <input value={policyNumber} onChange={e => setPolicyNumber(e.target.value)} className={INPUT} placeholder="e.g. PRU-LIFE-2026-XXXXX" />
        </div>
      )}

      {/* Insurer Notes */}
      <div>
        <label className="block text-2xs font-semibold text-ds-ink3 uppercase mb-1">Insurer Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className={TEXTAREA} placeholder="Underwriting notes…" />
      </div>

      <button
        onClick={handleUpdate} disabled={saving}
        className="w-full py-2.5 rounded-xl bg-emerald-500 text-white font-semibold text-sm disabled:opacity-40 flex items-center justify-center gap-2"
      >
        {saving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
        Update
      </button>
    </div>
  );
};

// ─── Bulk Batch Card ──────────────────────────────────────────────────────────

const BULK_STATUS_CLS: Record<string, string> = {
  DRAFT:     'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-ds-ink3',
  SUBMITTED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  INVOICED:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  PAID:      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  ISSUED:    'bg-emerald-500 text-white',
  CANCELLED: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
};

const fmtIDRBulk = (n: number) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

// v2.9.1 — Perluasan + paket + foto rangkuman di tabel admin.
const ADDON_LABEL_ADMIN: Record<string, string> = {
  flood: 'Banjir', earthquake: 'Gempa', srcc: 'SRCC', terrorism: 'Terorisme',
  authorizedWorkshop: 'Bengkel Resmi', paDriver: 'PA Pengemudi',
};
function renderAddonsAndPlan(
  it: SpB2BBatchItem,
  plansMap: Record<string, { name: string; code: string; loading_rate: number }> = {},
): React.ReactElement {
  const addons = (it.addons ?? {}) as Record<string, unknown>;
  const chips: Array<{ k: string; label: string }> = [];
  for (const [k, label] of Object.entries(ADDON_LABEL_ADMIN)) {
    if (addons[k]) chips.push({ k, label });
  }
  const tpl = Number(addons.tplLimit) || 0;
  if (tpl > 0) chips.push({ k: 'tpl', label: `TPL ${(tpl / 1_000_000).toFixed(0)}jt` });
  const seats = Number(addons.paPassengerSeats) || 0;
  if (seats > 0) chips.push({ k: 'paPassenger', label: `PA ${seats} kursi` });
  const hasAddon = chips.length > 0 || (it.addon_premium ?? 0) > 0;
  // v2.9.4 Phase 3 — nama paket di-resolve dari plansMap yang dikirim gateway.
  const planInfo = it.plan_id ? plansMap[it.plan_id] : null;
  const plan = planInfo ? planInfo.name : (it.plan_id ? 'Paket' : null);
  if (!hasAddon && !plan && (it.plan_loading ?? 0) === 0) return <span className="text-ds-ink3">—</span>;
  return (
    <div className="flex flex-col gap-0.5" title={hasAddon ? `+${fmtIDRBulk(it.addon_premium ?? 0)} perluasan` : undefined}>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-0.5">
          {chips.slice(0, 3).map(c => (
            <span key={c.k} className="rounded-full bg-sky-100 px-1.5 py-0.5 font-black text-sky-800 dark:bg-sky-900/30 dark:text-sky-300">{c.label}</span>
          ))}
          {chips.length > 3 && <span className="rounded-full bg-slate-200 px-1.5 py-0.5 font-black text-slate-700 dark:bg-white/10">+{chips.length - 3}</span>}
        </div>
      )}
      {(it.addon_premium ?? 0) > 0 && (
        <span className="text-ds-ink3 tabular-nums text-right font-mono">+{fmtIDRBulk(it.addon_premium ?? 0)}</span>
      )}
      {plan && (
        <span className={`rounded-full px-1.5 py-0.5 font-black ${(it.plan_loading ?? 0) > 0 ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' : (it.plan_loading ?? 0) < 0 ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300'}`}>
          {plan}{(it.plan_loading ?? 0) !== 0 ? ` (${(it.plan_loading ?? 0) > 0 ? '+' : ''}${fmtIDRBulk(it.plan_loading ?? 0)})` : ''}
        </span>
      )}
    </div>
  );
}
function renderPhotos(it: SpB2BBatchItem): React.ReactElement {
  const photos = it.vehicle_photos ?? [];
  if (!photos.length) return <span className="text-ds-ink3">—</span>;
  return (
    <div className="flex items-center gap-0.5">
      {photos.slice(0, 3).map((p, i) => (
        <a key={i} href={p.url} target="_blank" rel="noreferrer" title={p.slot}>
          {}
          <img src={p.url} className="h-7 w-7 rounded-md object-cover border border-ds-border hover:scale-125 transition-transform" />
        </a>
      ))}
      {photos.length > 3 && (
        <span className="ml-1 text-2xs font-black text-ds-ink3">+{photos.length - 3}</span>
      )}
    </div>
  );
}

const BulkBatchCard: React.FC<{ batch: SpB2BBatch; insurers: InsurerOption[]; onUpdated: () => void; onToast: (m: string) => void }> = ({ batch, insurers, onUpdated, onToast }) => {
  const prompt = usePromptDialog();
  const [cancelling, setCancelling] = useState(false);
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [policyNumber, setPolicyNumber] = useState(batch.master_policy_number ?? '');
  const [insurerName, setInsurerName] = useState(batch.insurer_name ?? '');
  const [docUrl, setDocUrl] = useState(batch.master_policy_document_url ?? '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [assigningInsurer, setAssigningInsurer] = useState(false);
  const [err, setErr] = useState('');

  // v2.9.12 — file sumber klien kini terlacak (source_file_path) dan bisa
  // diunduh ulang admin lewat signed URL gateway (diaudit di log aktivitas).
  const [downloadingSource, setDownloadingSource] = useState(false);
  const handleDownloadSource = async () => {
    if (downloadingSource) return;
    setDownloadingSource(true);
    const res = await adminGetB2BBulkSourceUrl(batch.id);
    setDownloadingSource(false);
    if ('error' in res) { onToast(res.error); return; }
    window.open(res.url, '_blank', 'noopener');
  };

  // FIX v2.8.20 (audit 2026-11-11): admin sebelumnya tidak bisa melihat isi
  // baris batch — kartu hanya menampilkan agregat, padahal aksi gateway
  // b2b_bulk_get_batch sudah tersedia. Panel detail menampilkan item per baris
  // (nasabah, unit, zona, TSI, premi, flag) + status faktur terakhir.
  const [showDetail, setShowDetail] = useState(false);
  const [detailItems, setDetailItems] = useState<SpB2BBatchItem[] | null>(null);
  const [detailPayment, setDetailPayment] = useState<{ invoice_url?: string; status?: string } | null>(null);
  const [detailPlans, setDetailPlans] = useState<Record<string, { name: string; code: string; loading_rate: number }>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState('');

  const loadDetail = async () => {
    if (detailLoading) return;
    setDetailLoading(true);
    setDetailErr('');
    const res = await getB2BBulkBatch(batch.id);
    setDetailLoading(false);
    if (!res) { setDetailErr('Gagal memuat detail batch. Coba lagi.'); return; }
    setDetailItems(res.items ?? []);
    setDetailPayment(res.payment ?? null);
    setDetailPlans(res.plans ?? {});
  };

  const toggleDetail = () => {
    const next = !showDetail;
    setShowDetail(next);
    if (next && !detailItems) void loadDetail();
  };

  const handleAssignInsurer = async (insurerId: string) => {
    if (!insurerId) return;
    setAssigningInsurer(true);
    const result = await adminAssignB2BBulkInsurer(batch.id, insurerId);
    setAssigningInsurer(false);
    if (result) { onToast('Insurer ditugaskan — batch kini terlihat di dashboard mereka.'); onUpdated(); }
    else onToast('Gagal menugaskan insurer.');
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    const url = await uploadB2BBulkMasterPolicy(batch.id, file);
    setUploading(false);
    if (url) setDocUrl(url);
    else setErr('Gagal mengunggah dokumen polis.');
  };

  // v2.9.29 — pembatalan oleh admin. Gateway menolak PAID/ISSUED (polis sudah
  // terbit) dan meminta alasan untuk audit; INVOICED boleh dibatalkan karena
  // admin memang pemegang keputusan void invoice Xendit.
  const handleCancel = async () => {
    if (cancelling) return;
    const reason = await prompt({
      title: 'Batalkan batch?',
      description: `Batch ${batch.batch_number} (${batch.company_name}) akan dibatalkan. Status CANCELLED bersifat final; pembayaran yang masuk setelahnya tidak akan menghidupkan batch ini.`,
      confirmLabel: 'Batalkan batch',
      cancelLabel: 'Jangan batalkan',
      variant: 'danger',
      input: { label: 'Alasan pembatalan (wajib)', placeholder: 'mis. klien membatalkan order', multiline: true, required: true },
    });
    if (reason === null) return;
    const trimmed = reason.trim();
    if (!trimmed) { onToast('Alasan pembatalan wajib diisi.'); return; }
    setCancelling(true);
    const ok = await adminCancelB2BBatch(batch.id, trimmed);
    setCancelling(false);
    if (!ok) { onToast('Gagal membatalkan batch — muat ulang lalu coba lagi.'); return; }
    onToast('Batch dibatalkan.');
    onUpdated();
  };

  const handleIssue = async () => {
    if (!policyNumber.trim() || !docUrl.trim()) { setErr('Nomor polis dan dokumen polis wajib diisi.'); return; }
    setSaving(true);
    const result = await adminIssueB2BBulkBatch({ batchId: batch.id, masterPolicyNumber: policyNumber.trim(), masterPolicyPath: docUrl.trim(), insurerName: insurerName.trim() || undefined });
    setSaving(false);
    if (result) { onToast('Polis batch diterbitkan'); setShowIssueForm(false); onUpdated(); }
    else setErr('Gagal menerbitkan polis. Coba unggah ulang dokumennya.');
  };

  return (
    <div className="p-4 bg-white dark:bg-ds-card2 border border-ds-border dark:border-ds-border rounded-2xl space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-mono text-2xs font-black px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/10 text-ds-ink2">{batch.batch_number}</span>
            <Badge cls={BULK_STATUS_CLS[batch.status] ?? ''} label={batch.status} />
          </div>
          <p className="font-bold text-ds-ink dark:text-white text-sm">{batch.company_name}</p>
          <p className="text-xs text-ds-ink3">{batch.item_count} unit · {fmtIDRBulk(batch.total_amount)}</p>
          <p className="text-xs text-ds-ink3">{fmtDate(batch.created_at)}</p>
          {/* v2.9.12 — file sumber klien: nama + ukuran tampil, dan admin bisa
              mengunduh ulang aslinya lewat signed URL gateway (diaudit). */}
          {batch.source_file_name && (
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              <span className="text-2xs text-ds-ink3 font-mono truncate max-w-[220px]" title={batch.source_file_name}>
                📄 {batch.source_file_name}{batch.source_file_size ? ` · ${(batch.source_file_size / 1024).toFixed(0)} KB` : ''}
              </span>
              {batch.source_file_path ? (
                <button
                  onClick={handleDownloadSource}
                  disabled={downloadingSource}
                  className="inline-flex items-center gap-1 text-2xs font-bold text-ds-green hover:underline disabled:opacity-50"
                >
                  {downloadingSource ? <Loader2 size={11} className="animate-spin" /> : <FileDown size={11} />}
                  Unduh file sumber
                </button>
              ) : (
                <span className="text-2xs text-ds-ink3" title="Diimpor sebelum v2.9.12 — path file tidak terekam">file tidak terlacak</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Insurer assignment — needed before the insurer's own token-authed
          dashboard can show this batch at all (insurer_list_bulk_batches
          filters by sp_b2b_batches.insurer_id). Available at any status so
          admin can assign early and let the insurer start preparing. */}
      {batch.status !== 'CANCELLED' && batch.status !== 'ISSUED' && (
        <div className="flex items-center gap-2">
          <Building2 size={13} className="text-ds-ink3 flex-shrink-0" />
          <select
            value={batch.insurer_id ?? ''}
            disabled={assigningInsurer}
            onChange={e => handleAssignInsurer(e.target.value)}
            className="flex-1 bg-ds-card2 border border-ds-border rounded-lg px-2.5 py-1.5 text-2xs font-bold text-ds-ink focus:outline-none focus:border-emerald-500/50 [&>option]:bg-ds-card"
          >
            <option value="">— Belum ditugaskan ke insurer —</option>
            {insurers.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          {assigningInsurer && <Loader2 size={12} className="animate-spin text-ds-ink3" />}
        </div>
      )}

      {/* Detail unit per baris — aksi gateway b2b_bulk_get_batch (admin diizinkan) */}
      <button
        onClick={toggleDetail}
        className="flex items-center gap-2 text-xs font-semibold text-ds-green hover:underline"
      >
        {showDetail ? <ChevronUp size={14} /> : <Plus size={14} />}
        {showDetail ? 'Tutup Detail Unit' : 'Detail Unit'}
      </button>

      {showDetail && (
        <div className="mt-1 rounded-2xl border border-ds-border bg-slate-50 dark:bg-ds-card2 p-3 space-y-2">
          {detailLoading && (
            <div className="flex items-center gap-2 py-3 text-2xs text-ds-ink3">
              <Loader2 size={13} className="animate-spin" /> Memuat detail unit…
            </div>
          )}
          {!detailLoading && detailErr && (
            <div className="flex items-center justify-between gap-2 py-1">
              <p className="text-2xs font-bold text-rose-700 dark:text-rose-300 flex items-center gap-1"><AlertTriangle size={12} />{detailErr}</p>
              <button onClick={() => void loadDetail()} className="text-2xs font-bold text-ds-green hover:underline">Coba lagi</button>
            </div>
          )}
          {!detailLoading && detailItems && detailItems.length === 0 && (
            <p className="text-2xs text-ds-ink3 py-2">Batch ini tidak memiliki baris unit.</p>
          )}
          {!detailLoading && detailItems && detailItems.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-2xs">
                <thead>
                  <tr className="text-left text-ds-ink3 uppercase tracking-wider">
                    <th className="py-1.5 pr-2 font-black">No</th>
                    <th className="py-1.5 pr-2 font-black">Nasabah</th>
                    <th className="py-1.5 pr-2 font-black">Unit</th>
                    <th className="py-1.5 pr-2 font-black">Plat</th>
                    <th className="py-1.5 pr-2 font-black">Zona</th>
                    <th className="py-1.5 pr-2 font-black">Periode</th>
                    <th className="py-1.5 pr-2 font-black">Perluasan / Paket</th>
                    <th className="py-1.5 pr-2 font-black">Foto</th>
                    <th className="py-1.5 pr-2 font-black text-right">TSI</th>
                    <th className="py-1.5 pr-2 font-black text-right">Premi Total</th>
                    <th className="py-1.5 pr-2 font-black">Status</th>
                  </tr>
                </thead>
                <tbody className="text-ds-ink2">
                  {detailItems.map(it => (
                    <tr key={it.id} className="border-t border-ds-border/60">
                      <td className="py-1.5 pr-2 font-mono">{it.row_no}</td>
                      <td className="py-1.5 pr-2 font-bold text-ds-ink dark:text-white max-w-[160px] truncate" title={it.nasabah_name}>{it.nasabah_name}</td>
                      <td className="py-1.5 pr-2 max-w-[170px] truncate" title={[it.make, it.model, it.model_year].filter(Boolean).join(' ') || it.vehicle_class}>
                        {[it.make, it.model, it.model_year].filter(Boolean).join(' ') || it.vehicle_class}
                        {/* v2.8.24 — penerbit polis harus tahu jenis pertanggungannya. */}
                        <span className={`ml-1 inline-block rounded-full px-1.5 py-0.5 font-black ${it.coverage_type === 'COMPREHENSIVE' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-slate-100 text-ds-ink2 dark:bg-white/10'}`}>
                          {it.coverage_type === 'COMPREHENSIVE' ? 'Comprehensive' : 'TLO'}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 font-mono">{it.plate_no ?? '—'}</td>
                      <td className="py-1.5 pr-2">{it.zone}</td>
                      {/* v2.8.23 — order unit: periode, penyusutan multi-tahun, dan
                          apakah diskon dicetak di polis. Penerbit polis perlu
                          ketiganya; baris impor massal hanya punya tenor. */}
                      <td className="py-1.5 pr-2">
                        <span className="whitespace-nowrap">
                          {it.coverage_start_date && it.coverage_end_date
                            ? `${it.coverage_start_date} → ${it.coverage_end_date}`
                            : `${it.tenor_months} bln`}
                        </span>
                        {it.depreciation_rate > 0 && (
                          <span
                            title={(it.premium_schedule ?? []).map(r => `Tahun ${r.year} (${r.months} bln): TSI ${fmtIDRBulk(r.sumInsured)} · premi gross ${fmtIDRBulk(r.premiumGross)}`).join('\n')}
                            className="ml-1 inline-block whitespace-nowrap rounded-full bg-sky-100 px-1.5 py-0.5 font-black text-sky-800 dark:bg-sky-900/30 dark:text-sky-300"
                          >
                            TSI susut {Number((it.depreciation_rate * 100).toFixed(2))}%/thn
                          </span>
                        )}
                        {it.discount_shown_on_policy === false && it.discount_amount > 0 && (
                          <span className="ml-1 inline-block whitespace-nowrap rounded-full bg-amber-100 px-1.5 py-0.5 font-black text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                            diskon tidak tertera di polis
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2">
                        {renderAddonsAndPlan(it, detailPlans)}
                      </td>
                      <td className="py-1.5 pr-2">
                        {renderPhotos(it)}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{fmtIDRBulk(it.financing_value)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums font-bold">{fmtIDRBulk(it.total_premium)}</td>
                      <td className="py-1.5 pr-2">
                        {it.flags.length > 0 ? (
                          <span title={it.flags.join('\n')} className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 font-black text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                            <AlertTriangle size={10} /> {it.flags.length}
                          </span>
                        ) : (
                          <span className={`rounded-full px-1.5 py-0.5 font-black ${it.status === 'ISSUED' ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-ds-ink2 dark:bg-white/10'}`}>{it.status}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!detailLoading && detailPayment && (
            <p className="text-2xs text-ds-ink3 pt-1 border-t border-ds-border/60">
              Faktur terakhir: <span className="font-bold">{detailPayment.status ?? '—'}</span>
              {detailPayment.invoice_url && (
                <> · <a href={detailPayment.invoice_url} target="_blank" rel="noreferrer" className="font-bold text-ds-green hover:underline">buka tautan</a></>
              )}
            </p>
          )}
        </div>
      )}

      {batch.status === 'ISSUED' && (
        <div className="text-xs text-ds-green dark:text-emerald-400 font-semibold">
          Polis: {batch.master_policy_number} {batch.insurer_name ? `· ${batch.insurer_name}` : ''}
        </div>
      )}

      {(batch.status === 'SUBMITTED' || batch.status === 'INVOICED') && (
        <button
          onClick={() => void handleCancel()}
          disabled={cancelling}
          className="flex items-center gap-2 text-xs font-semibold text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-300"
        >
          {cancelling ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
          {cancelling ? 'Membatalkan…' : 'Batalkan Batch'}
        </button>
      )}

      {(batch.status === 'PAID' || batch.status === 'ISSUED') && (
        <button
          onClick={() => setShowIssueForm(v => !v)}
          className="flex items-center gap-2 text-xs font-semibold text-ds-green hover:underline"
        >
          {showIssueForm ? <ChevronUp size={14} /> : <Plus size={14} />}
          {batch.status === 'ISSUED' ? 'Perbarui Polis' : 'Terbitkan Polis'}
        </button>
      )}

      {showIssueForm && (
        <div className="mt-1 p-4 bg-slate-50 dark:bg-ds-card2 border border-ds-border dark:border-ds-border rounded-2xl space-y-3">
          {err && <p className="text-xs text-rose-700 dark:text-rose-200 flex items-center gap-1"><AlertTriangle size={12} />{err}</p>}
          <div>
            <label className="block text-xs font-semibold text-ds-ink3 mb-1">Nomor Polis Induk</label>
            <input value={policyNumber} onChange={e => setPolicyNumber(e.target.value)} className={INPUT} placeholder="e.g. POL-TLO-2026-XXXXX" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ds-ink3 mb-1">Nama Penanggung</label>
            <input value={insurerName} onChange={e => setInsurerName(e.target.value)} className={INPUT} placeholder="e.g. Asuransi ABC" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ds-ink3 mb-1">Dokumen Polis Induk (PDF)</label>
            {docUrl && <p className="text-2xs text-ds-green break-all mb-1">Tersimpan: {docUrl}</p>}
            <label className="flex items-center gap-2 px-3 py-2 rounded-xl bg-ds-green text-ds-on-green text-xs font-bold cursor-pointer w-fit">
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              {docUrl ? 'Ganti Dokumen' : 'Unggah Dokumen'}
              <input type="file" accept=".pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            </label>
          </div>
          <button
            onClick={handleIssue} disabled={saving || uploading}
            className="w-full py-2.5 rounded-xl bg-emerald-500 text-white font-semibold text-sm disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {saving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            Terbitkan Polis Batch
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Modal edit profil korporat (v2.9.17) ────────────────────────────────────

const B2BEditUserModal: React.FC<{
  user: SpB2BUserDetail;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: B2BProfileEdit) => Promise<void>;
}> = ({ user, busy, onClose, onSave }) => {
  const [form, setForm] = useState({
    name: user.name ?? '',
    phone: user.phone ?? '',
    company_name: user.company_name ?? '',
    company_reg_no: user.company_reg_no ?? '',
    company_industry: user.company_industry ?? '',
    company_npwp: user.company_npwp ?? '',
    company_address: user.company_address ?? '',
    pic_ktp: user.pic_ktp ?? '',
  });
  const set = (key: keyof typeof form, value: string) => setForm(prev => ({ ...prev, [key]: value }));
  const inputCls = 'w-full rounded-xl border border-ds-border bg-white dark:bg-ds-card2 px-3 py-2 text-sm text-ds-ink dark:text-white focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20';
  const labelCls = 'block text-2xs font-black uppercase tracking-wide text-ds-ink3 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Edit pengguna korporat">
      <form
        onSubmit={e => { e.preventDefault(); void onSave(form); }}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-ds-border bg-white dark:bg-ds-card2 p-5 shadow-2xl space-y-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-ds-ink dark:text-white">Edit Pengguna Korporat</h3>
            <p className="text-2xs text-ds-ink3">{user.company_name || user.email} · versi {user.b2b_profile_version ?? 1}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="text-ds-ink3 hover:text-ds-ink2 disabled:opacity-40"><X size={16} /></button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><label className={labelCls}>Nama PIC</label><input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)} required /></div>
          <div><label className={labelCls}>Telepon</label><input className={inputCls} value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Nama Perusahaan</label><input className={inputCls} value={form.company_name} onChange={e => set('company_name', e.target.value)} required /></div>
          <div><label className={labelCls}>NIB / No. Registrasi</label><input className={inputCls} value={form.company_reg_no} onChange={e => set('company_reg_no', e.target.value)} /></div>
          <div>
            <label className={labelCls}>Industri</label>
            <select className={inputCls} value={form.company_industry} onChange={e => set('company_industry', e.target.value)}>
              <option value="">— Pilih industri —</option>
              {INDUSTRY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
          <div><label className={labelCls}>NPWP Perusahaan (15/16 digit)</label><input className={inputCls} value={form.company_npwp} onChange={e => set('company_npwp', e.target.value)} placeholder="00.000.000.000.000" /></div>
          <div><label className={labelCls}>NIK KTP PIC (16 digit)</label><input className={inputCls} value={form.pic_ktp} onChange={e => set('pic_ktp', e.target.value)} placeholder="16 digit" /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Alamat Perusahaan</label><textarea className={`${inputCls} resize-none min-h-[64px]`} value={form.company_address} onChange={e => set('company_address', e.target.value)} /></div>
        </div>

        <p className="rounded-xl bg-ds-card2 border border-ds-border p-3 text-2xs text-ds-ink3 leading-relaxed">
          Email login, role, dan status verifikasi tidak bisa diubah dari sini. Untuk menonaktifkan akun, gunakan tombol khusus di daftar pengguna. Setiap perubahan tercatat di log aktivitas B2B.
        </p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl border border-ds-border px-4 py-2 text-sm font-bold text-ds-ink2 disabled:opacity-40">Batal</button>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} {busy ? 'Menyimpan…' : 'Simpan Perubahan'}
          </button>
        </div>
      </form>
    </div>
  );
};

// ─── Pengguna Korporat (admin provisioning B2B, v2.7.56) ─────────────────────
//
// Mendaftarkan akun klien korporat B2B lengkap dengan kata sandi yang dibuat
// manual oleh admin (hanya MASTER_ADMIN; ADMIN memakai email undangan). Kata
// sandi ditampilkan sekali dan berlaku permanen sejak v2.8.8.
// v2.9.17: daftar ini juga jadi tempat edit KYC, aktif/nonaktif, dan hapus
// permanen bersyarat (MASTER_ADMIN saja).

const UsersSection: React.FC<{ onToast: (msg: string) => void }> = ({ onToast }) => {
  const confirm = useConfirmDialog();
  const prompt = usePromptDialog();
  const [showWizard, setShowWizard] = useState(false);
  const [credential, setCredential] = useState<WizardCredential | null>(null);
  const [users, setUsers] = useState<SpB2BUser[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [editingUser, setEditingUser] = useState<SpB2BUserDetail | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  // Caller role dibaca dari session — menentukan apakah opsi "Kata Sandi
  // Manual" tersedia (MASTER_ADMIN only).
  const callerRole: string = (() => {
    try {
      const raw = localStorage.getItem('SUREPATH_SESSION') ?? sessionStorage.getItem('SUREPATH_SESSION');
      return JSON.parse(raw ?? '{}')?.role ?? '';
    } catch { return ''; }
  })();

  const loadUsers = useCallback(async () => {
    setListLoading(true);
    setUsers(await adminListB2BUsers());
    setListLoading(false);
  }, []);
  useEffect(() => { loadUsers(); }, [loadUsers]);

  const copyCredential = async () => {
    if (!credential?.password) return;
    try {
      await navigator.clipboard.writeText(`Portal: https://myinsurepath.com/b2bapps\nEmail: ${credential.email}\nKata sandi: ${credential.password}\n(Berlaku permanen — pengguna bisa langsung login)`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard opsional */ }
  };

  // v2.8.8 — setel ulang kata sandi pengguna korporat secara manual. Sandi
  // baru berlaku permanen (tanpa wajib ganti), selaras dengan pembuatan akun;
  // ditampilkan sekali via banner kuning yang sama.
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const handleSetPassword = async (u: SpB2BUser) => {
    if (resettingUserId) return;
    const ok = await confirm({
      title: 'Setel Kata Sandi Baru?',
      description: `Kata sandi baru untuk ${u.name || u.email} akan dibuat dan berlaku permanen. Kata sandi lama langsung tidak berlaku.`,
      confirmLabel: 'Setel Sandi',
      cancelLabel: 'Batal',
    });
    if (!ok) return;
    setResettingUserId(u.id);
    const res = await setMitraTempPassword(u.id, false);
    setResettingUserId(null);
    if (res.error || !res.tempPassword) {
      onToast(res.error ?? 'Gagal menyetel kata sandi.');
      return;
    }
    setCredential({
      name: u.name || u.email,
      email: res.email ?? u.email,
      password: res.tempPassword,
      note: 'Kata sandi baru ini berlaku permanen — pengguna bisa langsung login dengannya. Tidak disimpan di sistem mana pun.',
    });
    onToast(`Kata sandi ${u.name || u.email} disetel ulang — tampil sekali di bawah.`);
  };

  // v2.9.17 — edit KYC hanya untuk ADMIN/MASTER_ADMIN. Role diverifikasi ulang
  // di gateway; pengecekan UI ini hanya menyembunyikan tombol yang tidak ada.
  const canManage = callerRole === 'MASTER_ADMIN' || callerRole === 'ADMIN';
  const canDelete = callerRole === 'MASTER_ADMIN';

  const openEdit = async (u: SpB2BUser) => {
    const res = await adminGetB2BUser(u.id);
    if (res.error || !res.data) {
      onToast(res.error ?? 'Gagal memuat detail pengguna.');
      return;
    }
    setEditingUser(res.data);
  };

  const saveEdit = async (patch: B2BProfileEdit) => {
    if (!editingUser || editBusy) return;
    setEditBusy(true);
    const res = await adminUpdateB2BUser(editingUser.id, editingUser.b2b_profile_version ?? 1, patch);
    setEditBusy(false);
    if (res.error || !res.data) {
      if (res.code === 'VERSION_CONFLICT') {
        onToast('Data berubah dari admin lain. Daftar dimuat ulang — buka edit lagi.');
        setEditingUser(null);
        void loadUsers();
        return;
      }
      onToast(res.error ?? 'Gagal menyimpan perubahan.');
      return;
    }
    setEditingUser(null);
    onToast('Profil korporat diperbarui.');
    void loadUsers();
  };

  const toggleActive = async (u: SpB2BUser) => {
    if (busyUserId) return;
    const deactivate = !u.b2b_deactivated_at;
    const ok = await confirm({
      title: deactivate ? 'Nonaktifkan akun korporat?' : 'Aktifkan kembali akun?',
      description: deactivate
        ? `${u.company_name || u.name || u.email} tidak bisa memakai portal sampai diaktifkan kembali. Data, batch, dan polis tetap aman.`
        : `${u.company_name || u.name || u.email} boleh login kembali ke portal B2B.`,
      confirmLabel: deactivate ? 'Nonaktifkan' : 'Aktifkan',
      cancelLabel: 'Batal',
      variant: deactivate ? 'danger' : 'default',
    });
    if (!ok) return;
    setBusyUserId(u.id);
    const res = await adminSetB2BUserActive(u.id, !deactivate);
    setBusyUserId(null);
    if (res.error || !res.data) {
      onToast(res.error ?? 'Gagal mengubah status akun.');
      return;
    }
    onToast(deactivate ? 'Akun korporat dinonaktifkan.' : 'Akun korporat diaktifkan kembali.');
    void loadUsers();
  };

  const hardDelete = async (u: SpB2BUser) => {
    if (busyUserId) return;
    const typed = await prompt({
      title: 'Hapus permanen akun korporat?',
      description: `Hanya MASTER_ADMIN. Akun tidak bisa dikembalikan, dan penghapusan hanya berhasil bila pengguna tidak memiliki batch polis. Ketik ${u.email} untuk konfirmasi.`,
      confirmLabel: 'Hapus permanen',
      cancelLabel: 'Batal',
      variant: 'danger',
      input: { label: 'Email pengguna', placeholder: u.email, required: true },
    });
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== u.email.toLowerCase()) {
      onToast('Email konfirmasi tidak cocok — penghapusan dibatalkan.');
      return;
    }
    setBusyUserId(u.id);
    const res = await adminDeleteB2BUser(u.id, typed);
    setBusyUserId(null);
    if (res.error || !res.data) {
      onToast(res.code === 'ACTIVE_BATCHES'
        ? `Gagal: pengguna masih punya ${res.batch_count ?? '≥1'} batch polis. Selesaikan atau batalkan dulu.`
        : res.error ?? 'Gagal menghapus akun.');
      return;
    }
    onToast(`Akun ${u.email} dihapus permanen.`);
    void loadUsers();
  };

  return (
    <div className="space-y-3">
      {editingUser && (
        <B2BEditUserModal
          user={editingUser}
          busy={editBusy}
          onClose={() => setEditingUser(null)}
          onSave={saveEdit}
        />
      )}

      {/* v2.8.5 — Unified AddUserWizard menggantikan form inline lama. Alur
          korporat (KYC perusahaan + PIC + dokumen NIB/NPWP/KTP) ada di
          kycMatrix.B2B_CLIENT, jadi wizard akan menampilkan field dan
          dokumen yang tepat begitu role B2B_CLIENT dipilih. */}
      <AddUserWizard
        open={showWizard}
        callerRole={callerRole}
        defaultRole="B2B_CLIENT"
        onClose={() => setShowWizard(false)}
        onCreated={(user, cred, docErrors) => {
          if (cred) setCredential(cred);
          onToast(cred ? 'Pengguna B2B terdaftar.' : 'Email undangan B2B terkirim.');
          if (docErrors.length > 0) {
            onToast(`${docErrors.length} dokumen gagal unggah — retry dari detail pengguna.`);
          }
          loadUsers();
          void user;
        }}
      />

      <div className="flex items-center justify-between gap-3 rounded-2xl border border-ds-border bg-white dark:bg-ds-card2 p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center">
            <Building2 size={18} className="text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-black text-ds-ink dark:text-white">Pengguna Korporat</p>
            <p className="text-xs text-ds-ink3 mt-0.5">Daftarkan multifinance/logistik dengan KYC perusahaan + PIC + dokumen NIB/NPWP/KTP.</p>
          </div>
        </div>
        <button
          onClick={() => setShowWizard(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-600 active:scale-95 transition-all shadow-sm hover:shadow-md"
        >
          <Plus size={14} /> Tambah Pengguna Korporat
        </button>
      </div>

      {/* Credential one-shot banner — tampil setelah wizard menyelesaikan
          mode password. Kartu kuning yang sama dengan inline lama. */}
      {credential?.password && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-2 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-xs font-black uppercase tracking-wider text-amber-800 dark:text-amber-300">Kata sandi awal — tampil sekali, simpan sekarang</p>
          <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
            <span className="rounded-lg bg-white dark:bg-ds-card px-2 py-1 border border-ds-border">{credential.email}</span>
            <span className="rounded-lg bg-white dark:bg-ds-card px-2 py-1 border border-ds-border">{credential.password}</span>
            <button onClick={copyCredential} className="inline-flex items-center gap-1 rounded-lg border border-ds-border px-2 py-1 text-xs font-bold text-ds-ink2">
              {copied ? <CheckCircle2 size={12} className="text-emerald-500" /> : <Copy size={12} />} {copied ? 'Tersalin' : 'Salin'}
            </button>
            <button onClick={() => setCredential(null)} className="inline-flex items-center gap-1 rounded-lg border border-ds-border px-2 py-1 text-xs font-bold text-ds-ink2">
              Tutup
            </button>
          </div>
          <p className="text-2xs text-amber-700 dark:text-amber-400">{credential.note ?? 'Kredensial ini tidak disimpan di sistem mana pun. Kata sandi berlaku permanen — pengguna bisa langsung login di /b2bapps dan mengganti sandinya kapan saja dari menu Profil.'}</p>
        </div>
      )}

      {/* Daftar pengguna */}
      <div className="rounded-2xl border border-ds-border bg-white dark:bg-ds-card2 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-black text-ds-ink dark:text-white">Pengguna Korporat Terdaftar</h3>
          <button onClick={loadUsers} className="text-ds-ink3 hover:text-ds-ink2"><RefreshCw size={14} className={listLoading ? 'animate-spin' : ''} /></button>
        </div>
        {listLoading ? (
          <div className="flex items-center justify-center py-8 text-ds-ink3 text-sm gap-2">
            <Loader2 size={14} className="animate-spin" /> Memuat…
          </div>
        ) : users.length === 0 ? (
          <p className="py-6 text-center text-sm text-ds-ink3">Belum ada pengguna korporat terdaftar.</p>
        ) : (
          <div className="space-y-2">
            {users.map(u => (
              <div key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ds-border px-3 py-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-2xs font-black text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  {(u.company_name || 'B2B').trim().split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || 'B2B'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ds-ink dark:text-white">{u.company_name || u.name || '—'}</p>
                  <p className="truncate text-2xs text-ds-ink3">{u.name} · {u.email}{u.phone ? ` · ${u.phone}` : ''}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-2xs font-black ${
                  u.b2b_deactivated_at
                    ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                }`}>
                  {u.b2b_deactivated_at ? 'NONAKTIF' : 'AKTIF'}
                </span>
                {canManage && (
                  <>
                    <button
                      onClick={() => void openEdit(u)}
                      className="inline-flex items-center gap-1 rounded-lg border border-ds-border bg-ds-card px-2 py-1 text-2xs font-bold text-ds-ink2 hover:border-emerald-400 hover:text-emerald-700"
                    >
                      <Pencil size={11} /> Edit
                    </button>
                    <button
                      onClick={() => void toggleActive(u)}
                      disabled={busyUserId === u.id}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-2xs font-bold disabled:opacity-50 ${
                        u.b2b_deactivated_at
                          ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                          : 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/20'
                      }`}
                    >
                      {u.b2b_deactivated_at ? <ShieldCheck size={11} /> : <ShieldOff size={11} />}
                      {busyUserId === u.id ? '…' : u.b2b_deactivated_at ? 'Aktifkan' : 'Nonaktifkan'}
                    </button>
                  </>
                )}
                {canDelete && (
                  <button
                    onClick={() => void hardDelete(u)}
                    disabled={busyUserId === u.id}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-2xs font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-900/20"
                  >
                    <Trash2 size={11} /> Hapus
                  </button>
                )}
                {callerRole === 'MASTER_ADMIN' && (
                  <button
                    onClick={() => handleSetPassword(u)}
                    disabled={resettingUserId === u.id}
                    className="inline-flex items-center gap-1 rounded-lg border border-ds-border bg-ds-card px-2 py-1 text-2xs font-bold text-ds-ink2 hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-50"
                  >
                    <KeyRound size={11} /> {resettingUserId === u.id ? 'Menyetel…' : 'Setel Sandi'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Bulk ops: aging + stale sweep (v2.9.29) ────────────────────────────────
//
// Aging answers "how much money is sitting in which stage for how long", and
// the sweep closes SUBMITTED batches nobody ever paid for. Both read/write via
// gateway actions that are admin-only and audited; this panel only renders
// their output. The sweep is manual on purpose — no cron is configured, and a
// silent auto-cancel of client work should be an explicit operator decision.

const BulkOpsPanel: React.FC<{ onUpdated: () => void; onToast: (m: string) => void }> = ({ onUpdated, onToast }) => {
  const confirm = useConfirmDialog();
  const [aging, setAging] = useState<B2BBatchAging | null>(null);
  const [agingLoading, setAgingLoading] = useState(true);
  const [agingError, setAgingError] = useState(false);
  const [sweeping, setSweeping] = useState(false);

  const loadAging = useCallback(async () => {
    setAgingLoading(true);
    setAgingError(false);
    const res = await adminGetB2BBatchAging(180);
    setAging(res);
    setAgingError(res === null);
    setAgingLoading(false);
  }, []);

  useEffect(() => { void loadAging(); }, [loadAging]);

  const handleSweep = async () => {
    if (sweeping) return;
    const ok = await confirm({
      title: 'Kedaluwarsakan batch SUBMITTED?',
      description: 'Batch SUBMITTED yang lebih tua dari 7 hari akan berstatus CANCELLED agar tidak menggantung. Batch yang sudah INVOICED/PAID/ISSUED tidak tersentuh. Tindakan ini tercatat di log aktivitas.',
      confirmLabel: 'Jalankan sweep',
      cancelLabel: 'Batal',
      variant: 'danger',
    });
    if (!ok) return;
    setSweeping(true);
    const res = await adminExpireStaleB2BBatches(7);
    setSweeping(false);
    if (!res) { onToast('Sweep gagal dijalankan.'); return; }
    onToast(`${res.expired} batch dibatalkan dari ${res.scanned} yang diperiksa.`);
    void loadAging();
    onUpdated();
  };

  return (
    <div className="rounded-2xl border border-ds-border bg-white dark:bg-ds-card2 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black text-ds-ink dark:text-white">Batch Aging · 180 hari</p>
          <p className="text-xs text-ds-ink3 mt-0.5">Nilai batch per umur dan per status — melihat pekerjaan yang menumpuk.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void loadAging()}
            disabled={agingLoading}
            aria-label="Muat ulang aging"
            className="p-2 rounded-xl text-ds-ink3 hover:text-ds-ink2 disabled:opacity-50"
          >
            <RefreshCw size={14} className={agingLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => void handleSweep()}
            disabled={sweeping}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 px-3 py-2 text-xs font-bold text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/20"
          >
            {sweeping ? <Loader2 size={13} className="animate-spin" /> : <Clock size={13} />}
            {sweeping ? 'Menjalankan…' : 'Sweep SUBMITTED > 7 hari'}
          </button>
        </div>
      </div>

      {agingError ? (
        <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle size={13} /> Aging belum dapat dimuat. Angka di bawah tidak ditampilkan.
        </p>
      ) : agingLoading && !aging ? (
        <div className="flex items-center gap-2 py-3 text-xs text-ds-ink3">
          <Loader2 size={13} className="animate-spin" /> Memuat aging…
        </div>
      ) : aging ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {aging.buckets.map(b => (
              <div key={b.key} className="rounded-xl border border-ds-border bg-ds-card2 dark:bg-white/5 px-3 py-2">
                <p className="text-2xs font-black uppercase tracking-wider text-ds-ink3">{b.label}</p>
                <p className="text-sm font-black text-ds-ink dark:text-white tabular-nums mt-0.5">{b.batches} batch</p>
                <p className="text-2xs text-ds-ink3 tabular-nums">{fmtIDRBulk(b.amount)}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(aging.by_status).map(([status, v]) => (
              <span key={status} className={`rounded-full px-2 py-0.5 text-2xs font-black ${BULK_STATUS_CLS[status] ?? 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-ds-ink3'}`}>
                {status} · {v.batches} · {fmtIDRBulk(v.amount)}
              </span>
            ))}
          </div>
          {aging.truncated && (
            <p className="flex items-center gap-1.5 text-2xs text-amber-700 dark:text-amber-400">
              <AlertTriangle size={11} /> Lebih dari 1.000 baris — angka aging terpotong, bukan total penuh.
            </p>
          )}
          <p className="text-2xs text-ds-ink3">Per {fmtDate(aging.as_of)} · jendela {aging.window_days} hari · {aging.row_count} batch terbaca</p>
        </>
      ) : null}
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

const BULK_STATUSES = ['SUBMITTED', 'INVOICED', 'PAID', 'ISSUED', 'CANCELLED'];

const B2BAdminView: React.FC = () => {
  const [tab, setTab] = useState<'overview' | 'b2b' | 'bulk' | 'life' | 'users' | 'activity'>('overview');
  const [b2bSubs, setB2bSubs] = useState<SpB2BSubmission[]>([]);
  const [bulkBatches, setBulkBatches] = useState<SpB2BBatch[]>([]);
  const [lifeApps, setLifeApps] = useState<SpLifeApplication[]>([]);
  const [insurers, setInsurers] = useState<InsurerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [b2bFilter, setB2bFilter] = useState('ALL');
  const [bulkFilter, setBulkFilter] = useState('ALL');
  const [lifeFilter, setLifeFilter] = useState('ALL');
  // v2.9.4 Phase 3 — search query per-tab. Mencari di nomor batch, nama
  // perusahaan, nama insurer, atau nomor polis. Non-sensitif ke case.
  const [searchQ, setSearchQ] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [subs, batches, apps, insRes] = await Promise.all([
        getAllB2BSubmissions(), adminGetAllB2BBulkBatches(), getAllLifeApplications(),
        supabase.from('sp_insurers').select('id, name').eq('is_active', true).order('name'),
      ]);
      setB2bSubs(subs);
      setBulkBatches(batches);
      setLifeApps(apps);
      setInsurers((insRes.data ?? []) as InsurerOption[]);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Gagal memuat pengajuan B2B dan aplikasi jiwa.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Surfaced prominently per the owner's request (5 Nov 2026) — bulk batches
  // awaiting payment or awaiting master-policy issuance are easy to lose
  // track of buried inside a filtered tab.
  const bulkAwaitingPayment = bulkBatches.filter(b => b.status === 'SUBMITTED' || b.status === 'INVOICED').length;
  const bulkAwaitingIssuance = bulkBatches.filter(b => b.status === 'PAID').length;

  const showToast = (msg: string) => setToast(msg);

  const q = searchQ.trim().toLowerCase();
  const matchesB2B = (s: SpB2BSubmission) =>
    !q || (s.company_name?.toLowerCase().includes(q))
       || (s.pic_name?.toLowerCase().includes(q) ?? false)
       || (s.product_type?.toLowerCase().includes(q));
  const matchesBulk = (b: SpB2BBatch) =>
    !q || b.batch_number?.toLowerCase().includes(q)
       || b.company_name?.toLowerCase().includes(q)
       || (b.insurer_name?.toLowerCase().includes(q) ?? false)
       || (b.master_policy_number?.toLowerCase().includes(q) ?? false);
  const matchesLife = (a: SpLifeApplication) =>
    !q || a.client_name?.toLowerCase().includes(q)
       || (a.product_code?.toLowerCase().includes(q));
  const visibleB2b = (b2bFilter === 'ALL' ? b2bSubs : b2bSubs.filter(s => s.status === b2bFilter)).filter(matchesB2B);
  const visibleBulk = (bulkFilter === 'ALL' ? bulkBatches : bulkBatches.filter(b => b.status === bulkFilter)).filter(matchesBulk);
  const visibleLife = (lifeFilter === 'ALL' ? lifeApps : lifeApps.filter(a => a.status === lifeFilter)).filter(matchesLife);

  return (
    <div className="min-h-full bg-slate-50 dark:bg-ds-card">
      {toast && <Toast msg={toast} onDone={() => setToast('')} />}

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 px-5 pt-5 pb-3 flex-wrap">
        <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')} icon={<LayoutDashboard size={18} />} label="Overview" />
        <TabBtn active={tab === 'b2b'} onClick={() => setTab('b2b')} icon={<ModuleIcon id="b2b" size={22} />} label="B2B Submissions" />
        <TabBtn active={tab === 'bulk'} onClick={() => setTab('bulk')} icon={<ModuleIcon id="documents" size={22} />} label="Bulk Batches" badge={bulkAwaitingPayment + bulkAwaitingIssuance} />
        <TabBtn active={tab === 'life'} onClick={() => setTab('life')} icon={<ModuleIcon id="family_health" size={22} />} label="Life Applications" />
        <TabBtn active={tab === 'users'} onClick={() => setTab('users')} icon={<Building2 size={22} />} label="Pengguna Korporat" />
        <TabBtn active={tab === 'activity'} onClick={() => setTab('activity')} icon={<History size={22} />} label="Aktivitas" />
        <button onClick={load} className="ml-auto p-2 rounded-xl text-ds-ink3 hover:text-ds-ink2 dark:hover:text-ds-ink">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Filter Pills + search — overview, users, activity have no filter bar */}
      {tab !== 'overview' && tab !== 'users' && tab !== 'activity' && (
      <div className="flex gap-2 px-5 pb-3 overflow-x-auto items-center">
        {tab === 'b2b' && ['ALL', ...B2B_STATUSES].map(f => (
          <FilterPill key={f} label={f} active={b2bFilter === f} onClick={() => setB2bFilter(f)} />
        ))}
        {tab === 'bulk' && ['ALL', ...BULK_STATUSES].map(f => (
          <FilterPill key={f} label={f} active={bulkFilter === f} onClick={() => setBulkFilter(f)} />
        ))}
        {tab === 'life' && ['ALL', ...LIFE_STATUSES].map(f => (
          <FilterPill key={f} label={f} active={lifeFilter === f} onClick={() => setLifeFilter(f)} />
        ))}
        <div className="ml-auto relative flex-shrink-0">
          <input
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder={tab === 'bulk' ? 'Cari batch / perusahaan / polis…' : tab === 'b2b' ? 'Cari perusahaan / PIC…' : 'Cari nasabah / produk…'}
            className="w-64 pl-8 pr-2 py-1.5 text-xs rounded-lg border border-ds-border bg-white dark:bg-ds-card2 outline-none focus:border-indigo-400"
          />
          <svg aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ds-ink3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /></svg>
          {searchQ && (
            <button onClick={() => setSearchQ('')} aria-label="Hapus pencarian" className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-ds-ink3 hover:text-ds-ink2 text-xs">✕</button>
          )}
        </div>
      </div>
      )}

      {/* Content */}
      <div className="px-5 pb-8 space-y-3">
        {loadError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
            <span><strong>Data belum berhasil dimuat.</strong> {loadError}</span>
            <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-current px-3 py-2 font-semibold">
              <RefreshCw size={14} /> Coba lagi
            </button>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-ds-ink3 text-sm gap-2">
            <RefreshCw size={16} className="animate-spin" /> Loading…
          </div>
        ) : tab === 'overview' ? (
          <B2BOverviewSection
            b2bSubs={b2bSubs}
            bulkBatches={bulkBatches}
            lifeApps={lifeApps}
            insurers={insurers}
            onNavigate={setTab}
          />
        ) : tab === 'b2b' ? (
          visibleB2b.length === 0 ? (
            <Empty />
          ) : (
            visibleB2b.map(sub => (
              <B2BCard key={sub.id} sub={sub} onUpdated={load} onToast={showToast} />
            ))
          )
        ) : tab === 'bulk' ? (
          <>
            <BulkOpsPanel onUpdated={load} onToast={showToast} />
            {visibleBulk.length === 0 ? (
              <Empty />
            ) : (
              visibleBulk.map(batch => (
                <BulkBatchCard key={batch.id} batch={batch} insurers={insurers} onUpdated={load} onToast={showToast} />
              ))
            )}
          </>
        ) : tab === 'users' ? (
          <UsersSection onToast={showToast} />
        ) : tab === 'activity' ? (
          <B2BActivitySection />
        ) : (
          visibleLife.length === 0 ? (
            <Empty />
          ) : (
            visibleLife.map(app => (
              <LifeCard key={app.id} app={app} onUpdated={load} onToast={showToast} />
            ))
          )
        )}
      </div>
    </div>
  );
};

// ─── B2B Overview Section (v2.9.23) ─────────────────────────────────────────
//
// Strategic landing tab for admin B2B: one glance tells them where the queue
// stands and what needs attention first. Consumes data already fetched by the
// parent load() so no extra network calls.
//
// Layout:
//   1. KPI strip (6 cards) — pending, quoted, awaiting payment, awaiting
//      issuance, life pending, total premium YTD.
//   2. Action-required panel — urgent items with deep-link buttons that
//      switch tabs + filter.
//   3. Quick actions — jump to the most common follow-ups.

const B2BOverviewSection: React.FC<{
  b2bSubs: SpB2BSubmission[];
  bulkBatches: SpB2BBatch[];
  lifeApps: SpLifeApplication[];
  insurers: InsurerOption[];
  onNavigate: (tab: 'overview' | 'b2b' | 'bulk' | 'life' | 'users' | 'activity') => void;
}> = ({ b2bSubs, bulkBatches, lifeApps, insurers, onNavigate }) => {
  const pendingReview = b2bSubs.filter(s => s.status === 'SUBMITTED' || s.status === 'REVIEWING').length;
  const quotedOpen    = b2bSubs.filter(s => s.status === 'QUOTED').length;
  const acceptedYtd   = b2bSubs.filter(s => s.status === 'ACCEPTED').length;
  const awaitingPay   = bulkBatches.filter(b => b.status === 'SUBMITTED' || b.status === 'INVOICED').length;
  const awaitingIss   = bulkBatches.filter(b => b.status === 'PAID').length;
  const issuedBatches = bulkBatches.filter(b => b.status === 'ISSUED').length;
  const lifePending   = lifeApps.filter(a => a.status === 'SUBMITTED' || a.status === 'UNDERWRITING').length;
  const premiumYtd    = bulkBatches
    .filter(b => b.status === 'PAID' || b.status === 'ISSUED')
    .reduce((s, b) => s + (b.total_amount ?? 0), 0);
  const totalFleetUnits = bulkBatches.reduce((s, b) => s + (b.item_count ?? 0), 0);
  const uniqueClients = new Set([
    ...b2bSubs.map(s => s.client_id).filter(Boolean),
    ...bulkBatches.map(b => b.client_id).filter(Boolean),
  ]).size;

  const needsAttention = pendingReview + awaitingPay + awaitingIss + lifePending;

  return (
    <div className="space-y-5">
      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <AdminKpiCard
          label="Perlu Review"
          value={pendingReview}
          sub="Submissions SUBMITTED/REVIEWING"
          icon={Clock}
          tone="amber"
          onClick={() => onNavigate('b2b')}
        />
        <AdminKpiCard
          label="Open Quotes"
          value={quotedOpen}
          sub="Menunggu keputusan klien"
          icon={FileCheck2}
          tone="violet"
          onClick={() => onNavigate('b2b')}
        />
        <AdminKpiCard
          label="Await Payment"
          value={awaitingPay}
          sub="Bulk batches SUBMITTED/INVOICED"
          icon={Banknote}
          tone="amber"
          onClick={() => onNavigate('bulk')}
        />
        <AdminKpiCard
          label="Await Issuance"
          value={awaitingIss}
          sub="PAID, polis induk belum terbit"
          icon={ShieldCheck}
          tone="rose"
          onClick={() => onNavigate('bulk')}
        />
        <AdminKpiCard
          label="Life Pending"
          value={lifePending}
          sub="SUBMITTED/UNDERWRITING"
          icon={Heart}
          tone="blue"
          onClick={() => onNavigate('life')}
        />
        <AdminKpiCard
          label="Premi (YTD)"
          value={fmtIDR(premiumYtd)}
          sub={`${issuedBatches} batch issued`}
          icon={TrendingUp}
          tone="green"
        />
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-ds-border bg-ds-card p-4">
          <p className="text-2xs font-black uppercase tracking-widest text-ds-ink3">Klien Korporat</p>
          <p className="text-2xl font-black text-ds-ink mt-1 tabular-nums">{uniqueClients}</p>
          <p className="text-2xs text-ds-ink3 mt-1">Dengan aktivitas</p>
        </div>
        <div className="rounded-2xl border border-ds-border bg-ds-card p-4">
          <p className="text-2xs font-black uppercase tracking-widest text-ds-ink3">Unit Armada</p>
          <p className="text-2xl font-black text-ds-ink mt-1 tabular-nums">{totalFleetUnits.toLocaleString('id-ID')}</p>
          <p className="text-2xs text-ds-ink3 mt-1">Semua batch</p>
        </div>
        <div className="rounded-2xl border border-ds-border bg-ds-card p-4">
          <p className="text-2xs font-black uppercase tracking-widest text-ds-ink3">Submission Diterima</p>
          <p className="text-2xl font-black text-ds-ink mt-1 tabular-nums">{acceptedYtd}</p>
          <p className="text-2xs text-ds-ink3 mt-1">Status ACCEPTED</p>
        </div>
        <div className="rounded-2xl border border-ds-border bg-ds-card p-4">
          <p className="text-2xs font-black uppercase tracking-widest text-ds-ink3">Asuransi Aktif</p>
          <p className="text-2xl font-black text-ds-ink mt-1 tabular-nums">{insurers.length}</p>
          <p className="text-2xs text-ds-ink3 mt-1">Dapat ditugaskan</p>
        </div>
      </div>

      {/* Action-required panel */}
      {needsAttention > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 dark:bg-amber-900/10 dark:border-amber-800/40 p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} className="text-amber-600" />
            <p className="text-sm font-black uppercase tracking-wider text-amber-900 dark:text-amber-200">
              {needsAttention} item butuh tindakan
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {pendingReview > 0 && (
              <button
                onClick={() => onNavigate('b2b')}
                className="text-left bg-white dark:bg-ds-card p-3 rounded-xl border border-ds-border hover:border-amber-400 transition-colors"
              >
                <p className="text-xs font-bold text-ds-ink">Review submission</p>
                <p className="text-lg font-black text-amber-700 tabular-nums mt-0.5">{pendingReview}</p>
                <p className="text-2xs text-ds-ink3">Buka tab B2B →</p>
              </button>
            )}
            {awaitingPay > 0 && (
              <button
                onClick={() => onNavigate('bulk')}
                className="text-left bg-white dark:bg-ds-card p-3 rounded-xl border border-ds-border hover:border-amber-400 transition-colors"
              >
                <p className="text-xs font-bold text-ds-ink">Tunggu pembayaran</p>
                <p className="text-lg font-black text-amber-700 tabular-nums mt-0.5">{awaitingPay}</p>
                <p className="text-2xs text-ds-ink3">Buka tab Bulk Batches →</p>
              </button>
            )}
            {awaitingIss > 0 && (
              <button
                onClick={() => onNavigate('bulk')}
                className="text-left bg-white dark:bg-ds-card p-3 rounded-xl border border-ds-border hover:border-rose-400 transition-colors"
              >
                <p className="text-xs font-bold text-ds-ink">Terbitkan polis induk</p>
                <p className="text-lg font-black text-rose-700 tabular-nums mt-0.5">{awaitingIss}</p>
                <p className="text-2xs text-ds-ink3">Buka tab Bulk Batches →</p>
              </button>
            )}
            {lifePending > 0 && (
              <button
                onClick={() => onNavigate('life')}
                className="text-left bg-white dark:bg-ds-card p-3 rounded-xl border border-ds-border hover:border-blue-400 transition-colors"
              >
                <p className="text-xs font-bold text-ds-ink">Life underwriting</p>
                <p className="text-lg font-black text-blue-700 tabular-nums mt-0.5">{lifePending}</p>
                <p className="text-2xs text-ds-ink3">Buka tab Life →</p>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Quick nav row */}
      <div className="rounded-2xl border border-ds-border bg-ds-card p-5">
        <p className="text-2xs font-black uppercase tracking-[0.18em] text-ds-ink3 mb-3">Navigasi cepat</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <button onClick={() => onNavigate('users')} className="flex items-center gap-2 p-3 rounded-xl border border-ds-border hover:border-emerald-400 transition-colors text-left">
            <Users size={14} className="text-emerald-600" />
            <span className="text-xs font-bold text-ds-ink">Pengguna</span>
          </button>
          <button onClick={() => onNavigate('b2b')} className="flex items-center gap-2 p-3 rounded-xl border border-ds-border hover:border-emerald-400 transition-colors text-left">
            <FileText size={14} className="text-emerald-600" />
            <span className="text-xs font-bold text-ds-ink">Submissions</span>
          </button>
          <button onClick={() => onNavigate('bulk')} className="flex items-center gap-2 p-3 rounded-xl border border-ds-border hover:border-emerald-400 transition-colors text-left">
            <ModuleIcon id="documents" size={16} />
            <span className="text-xs font-bold text-ds-ink">Bulk Batches</span>
          </button>
          <button onClick={() => onNavigate('life')} className="flex items-center gap-2 p-3 rounded-xl border border-ds-border hover:border-emerald-400 transition-colors text-left">
            <Heart size={14} className="text-emerald-600" />
            <span className="text-xs font-bold text-ds-ink">Life Apps</span>
          </button>
          <button onClick={() => onNavigate('activity')} className="flex items-center gap-2 p-3 rounded-xl border border-ds-border hover:border-emerald-400 transition-colors text-left">
            <History size={14} className="text-emerald-600" />
            <span className="text-xs font-bold text-ds-ink">Aktivitas</span>
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── B2B activity log section (v2.9.12) ──────────────────────────────────────

// Label aksi yang manusiawi (Indonesia) — aksi tak dikenal ditampilkan mentah
// agar log dari versi mendatang tetap terbaca.
const B2B_ACTION_LABEL: Record<string, string> = {
  bulk_batch_created: 'Pengajuan impor massal',
  bulk_batch_viewed: 'Detail batch dibuka',
  bulk_invoice_created: 'Invoice dibuat',
  bulk_paid: 'Pembayaran diterima',
  bulk_invoice_expired: 'Invoice kadaluarsa',
  bulk_insurer_assigned: 'Insurer ditugaskan',
  bulk_master_policy_issued: 'Polis induk diterbitkan',
  bulk_insurer_uploaded_master_policy: 'Polis induk diunggah insurer',
  bulk_source_file_downloaded: 'File sumber diunduh',
};

const B2B_ACTOR_CLS: Record<string, string> = {
  B2B_CLIENT: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  ADMIN: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  MASTER_ADMIN: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  INSURER: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  SYSTEM: 'bg-slate-100 text-ds-ink2 dark:bg-white/10',
};

const B2BActivitySection: React.FC = () => {
  const [entries, setEntries] = useState<SpB2BActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async (lim: number) => {
    setLoading(true);
    const rows = await adminListB2BActivity({ limit: lim + 1 });
    if (rows.length > lim) { setHasMore(true); rows.pop(); } else { setHasMore(false); }
    setEntries(rows);
    setLoading(false);
  }, []);

  useEffect(() => { void load(limit); }, [load, limit]);

  // Pencarian klien-side: menyentuh ringkasan, aktor, nomor batch, aksi —
  // cukup untuk "apa yang klien X lakukan minggu ini" tanpa query server baru.
  const visible = entries.filter(e => {
    if (!q) return true;
    const n = q.toLowerCase();
    return (e.summary ?? '').toLowerCase().includes(n)
      || (e.actor_email ?? '').toLowerCase().includes(n)
      || (e.batch_number ?? '').toLowerCase().includes(n)
      || (e.action ?? '').toLowerCase().includes(n);
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Cari ringkasan / aktor / batch…"
          className="w-64 px-3 py-1.5 text-xs rounded-lg border border-ds-border bg-white dark:bg-ds-card2 outline-none focus:border-indigo-400"
        />
        <button onClick={() => void load(limit)} className="ml-auto inline-flex items-center gap-1.5 text-xs font-bold text-ds-green hover:underline">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Muat ulang
        </button>
      </div>

      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-ds-ink3 text-sm gap-2">
          <RefreshCw size={16} className="animate-spin" /> Memuat log aktivitas…
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-ds-ink3">
          <History size={44} className="mb-3" />
          <p className="text-sm">{q ? 'Tidak ada entri yang cocok.' : 'Belum ada aktivitas B2B tercatat.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(e => {
            const label = B2B_ACTION_LABEL[e.action] ?? e.action;
            const actorCls = B2B_ACTOR_CLS[e.actor_role ?? ''] ?? 'bg-slate-100 text-ds-ink2 dark:bg-white/10';
            return (
              <div key={e.id} className="p-3 bg-white dark:bg-ds-card2 border border-ds-border rounded-2xl">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-ds-ink dark:text-white">{label}</p>
                    <p className="text-xs text-ds-ink2 mt-0.5 break-words">{e.summary}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                    {e.actor_role && (
                      <span className={`rounded-full px-2 py-0.5 text-2xs font-black ${actorCls}`}>{e.actor_role}</span>
                    )}
                    {e.batch_number && (
                      <span className="font-mono text-2xs font-black px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/10 text-ds-ink2">{e.batch_number}</span>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-2 flex-wrap text-2xs text-ds-ink3">
                  <span>{new Date(e.created_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  {e.actor_email && <span>· {e.actor_email}</span>}
                  {e.ip && <span className="font-mono">· {e.ip}</span>}
                </div>
                {e.detail && Object.keys(e.detail).length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-2xs font-bold text-ds-green select-none">Detail</summary>
                    <pre className="mt-1.5 p-2 rounded-lg bg-slate-50 dark:bg-ds-card text-2xs overflow-x-auto text-ds-ink2">{JSON.stringify(e.detail, null, 2)}</pre>
                  </details>
                )}
              </div>
            );
          })}
          {hasMore && (
            <button onClick={() => setLimit(l => l + 100)} className="w-full py-2.5 rounded-xl border border-ds-border text-xs font-bold text-ds-ink2 hover:bg-slate-50 dark:hover:bg-white/5">
              Muat lebih banyak
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Minor atoms ──────────────────────────────────────────────────────────────

const TabBtn: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }> = ({ active, onClick, icon, label, badge }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
      active ? 'bg-emerald-500 text-white shadow-sm' : 'bg-white dark:bg-ds-card2 border border-ds-border dark:border-ds-border text-ds-ink2 dark:text-ds-ink2'
    }`}
  >
    {icon}{label}
    {!!badge && (
      <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-2xs font-black ${active ? 'bg-white/20 text-white' : 'bg-rose-500 text-white'}`}>
        {badge}
      </span>
    )}
  </button>
);

const FilterPill: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
      active ? 'bg-emerald-500 text-white' : 'bg-white dark:bg-ds-card2 border border-ds-border dark:border-ds-border text-ds-ink3 dark:text-ds-ink3'
    }`}
  >
    {label}
  </button>
);

const Empty: React.FC = () => (
  <div className="flex flex-col items-center justify-center py-16 text-ds-ink3">
    <ModuleIcon id="documents" size={52} className="mb-3" />
    <p className="text-sm">No records found</p>
  </div>
);

export default B2BAdminView;
