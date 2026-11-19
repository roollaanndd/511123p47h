import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, KeyRound, Loader2, LogOut, MailCheck, ShieldCheck } from 'lucide-react';
import {
  AgentPinError, PIN_LENGTH, cachePinConfigured, isSixDigits, requestPinReset,
  resetAgentPin, setAgentPin, verifyAgentPin,
} from '../../services/agentPin';

interface Props {
  /** 'setup' = PIN belum ada; 'unlock' = PIN sudah dibuat / layar idle. */
  mode: 'setup' | 'unlock';
  userId: string;
  email?: string;
  name?: string;
  onUnlocked: () => void;
  onLogout: () => void;
}

type Step = 'pin' | 'forgot' | 'reset';

const errMessage = (e: unknown): string =>
  e instanceof AgentPinError ? e.message : 'Something went wrong. Coba lagi.';

const fmtCountdown = (ms: number): string => {
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Full-screen blocking gate untuk portal agen. PIN mentah hanya hidup di state
 * input dan dikirim langsung ke data-gateway — tidak ditulis ke storage/audit.
 */
const AgentPinGate: React.FC<Props> = ({ mode, userId, email, name, onUnlocked, onLogout }) => {
  const [step, setStep] = useState<Step>('pin');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!lockedUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  const remainingLock = useMemo(() => {
    if (!lockedUntil) return 0;
    const until = Date.parse(lockedUntil);
    return Number.isFinite(until) ? Math.max(0, until - now) : 0;
  }, [lockedUntil, now]);
  const isLocked = remainingLock > 0;

  const digitsOnly = (value: string) => value.replace(/\D/g, '').slice(0, PIN_LENGTH);

  const resetFields = () => {
    setPin(''); setConfirm(''); setCode(''); setNewPin(''); setConfirmNewPin('');
  };

  const goStep = (next: Step) => {
    setError(null); setNotice(null); resetFields(); setStep(next);
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (loading || isLocked) return;
    setError(null);

    try {
      if (mode === 'setup') {
        if (!isSixDigits(pin)) throw new AgentPinError('PIN harus tepat 6 digit angka.');
        if (pin !== confirm) throw new AgentPinError('Konfirmasi PIN belum sama.');
        setLoading(true);
        await setAgentPin(pin);
        cachePinConfigured(userId, true);
        resetFields();
        onUnlocked();
        return;
      }

      if (step === 'pin') {
        if (!isSixDigits(pin)) throw new AgentPinError('PIN harus tepat 6 digit angka.');
        setLoading(true);
        await verifyAgentPin(pin);
        cachePinConfigured(userId, true);
        resetFields();
        onUnlocked();
        return;
      }

      if (step === 'forgot') {
        setLoading(true);
        const res = await requestPinReset();
        setNotice(`Kode reset dikirim ke ${res.email}. Berlaku 10 menit.`);
        setStep('reset');
        setPin('');
        return;
      }

      // step === 'reset'
      if (!isSixDigits(code)) throw new AgentPinError('Kode reset harus 6 digit angka.');
      if (!isSixDigits(newPin)) throw new AgentPinError('PIN baru harus 6 digit angka.');
      if (newPin !== confirmNewPin) throw new AgentPinError('Konfirmasi PIN baru belum sama.');
      setLoading(true);
      await resetAgentPin(code, newPin);
      cachePinConfigured(userId, true);
      resetFields();
      onUnlocked();
    } catch (e) {
      setError(errMessage(e));
      if (e instanceof AgentPinError && e.lockedUntil) setLockedUntil(e.lockedUntil);
    } finally {
      setLoading(false);
    }
  };

  const title = mode === 'setup'
    ? 'Buat PIN Agen'
    : step === 'forgot' ? 'Reset PIN' : step === 'reset' ? 'Masukkan Kode Reset' : 'Masukkan PIN';
  const subtitle = mode === 'setup'
    ? '6 digit angka untuk mengunci portal agen kamu.'
    : step === 'forgot'
      ? 'Kami akan mengirim kode reset ke email akun kamu.'
      : step === 'reset'
        ? 'Gunakan kode dari email, lalu buat PIN baru.'
        : 'Demi keamanan, PIN diminta lagi setelah 30 menit tidak aktif.';

  return (
    <div
      className="fixed inset-0 z-[5000] flex items-center justify-center px-5 py-8"
      style={{ background: '#f6faf7', paddingTop: 'max(2rem, env(safe-area-inset-top))', paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}
    >
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-16 h-16 mx-auto rounded-[22px] bg-white shadow-[0_10px_28px_rgba(6,78,59,0.12)] ring-1 ring-emerald-900/5 flex items-center justify-center mb-4">
            {mode === 'setup' ? <KeyRound size={28} className="text-ds-green" /> : <ShieldCheck size={28} className="text-ds-green" />}
          </div>
          <h1 className="text-xl font-black tracking-tight text-slate-900">{title}</h1>
          <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{subtitle}</p>
          {(name || email) && (
            <p className="text-[11px] font-bold text-ds-green mt-3">
              {name || email}
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="sp-glass rounded-3xl p-6 space-y-4">
          {notice && (
            <div className="flex items-start gap-2 rounded-2xl bg-emerald-500/10 text-emerald-800 px-3 py-2.5">
              <MailCheck size={15} className="mt-0.5 shrink-0" />
              <p className="text-[11px] leading-relaxed">{notice}</p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-2xl bg-rose-500/10 text-rose-700 px-3 py-2.5" role="alert">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <p className="text-[11px] leading-relaxed">{error}</p>
            </div>
          )}

          {isLocked && (
            <div className="rounded-2xl bg-amber-500/10 text-amber-800 px-3 py-2.5 text-center">
              <p className="text-[11px] font-bold">Terlalu banyak PIN salah. Coba lagi dalam</p>
              <p className="font-mono text-lg font-black tracking-widest mt-0.5">{fmtCountdown(remainingLock)}</p>
            </div>
          )}

          {mode === 'setup' && (
            <>
              <PinField label="PIN baru" value={pin} onChange={v => setPin(digitsOnly(v))} disabled={loading} autoFocus />
              <PinField label="Ulangi PIN" value={confirm} onChange={v => setConfirm(digitsOnly(v))} disabled={loading} />
            </>
          )}

          {mode === 'unlock' && step === 'pin' && (
            <PinField label="PIN 6 digit" value={pin} onChange={v => setPin(digitsOnly(v))} disabled={loading || isLocked} autoFocus />
          )}

          {mode === 'unlock' && step === 'forgot' && (
            <div className="rounded-2xl bg-ds-card2 border border-ds-border px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-ds-ink3">Email akun</p>
              <p className="text-sm font-bold text-ds-ink mt-1 break-all">{email || 'Akun ini'}</p>
            </div>
          )}

          {mode === 'unlock' && step === 'reset' && (
            <>
              <PinField label="Kode dari email" value={code} onChange={v => setCode(digitsOnly(v))} disabled={loading} autoFocus />
              <PinField label="PIN baru" value={newPin} onChange={v => setNewPin(digitsOnly(v))} disabled={loading} />
              <PinField label="Ulangi PIN baru" value={confirmNewPin} onChange={v => setConfirmNewPin(digitsOnly(v))} disabled={loading} />
            </>
          )}

          <button
            type="submit"
            disabled={loading || isLocked}
            className="w-full py-3.5 rounded-2xl bg-ds-green text-white text-sm font-black tracking-wide shadow-[0_8px_20px_rgba(6,78,59,0.22)] disabled:opacity-50 disabled:cursor-not-allowed active:translate-y-px transition-all"
          >
            {loading ? <Loader2 size={18} className="animate-spin mx-auto" /> :
              mode === 'setup' ? 'Simpan PIN' :
                step === 'forgot' ? 'Kirim kode reset' :
                  step === 'reset' ? 'Reset PIN' : 'Buka Portal'}
          </button>

          {mode === 'unlock' && step === 'pin' && (
            <button
              type="button"
              onClick={() => goStep('forgot')}
              className="w-full text-center text-xs font-bold text-ds-green hover:underline"
            >
              Lupa PIN?
            </button>
          )}

          {(step === 'forgot' || step === 'reset') && (
            <button
              type="button"
              onClick={() => goStep('pin')}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-ds-ink3 hover:text-ds-ink"
            >
              <ArrowLeft size={14} /> Kembali
            </button>
          )}

          <div className="pt-1 border-t border-ds-border text-center">
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-ds-ink3 hover:text-rose-600"
            >
              <LogOut size={14} /> Keluar dari akun ini
            </button>
          </div>
        </form>

        <p className="text-center text-[10px] text-ds-ink3 mt-5 leading-relaxed">
          PIN kamu hanya tersimpan sebagai hash di server. SurePath tidak pernah meminta PIN lewat email atau pesan.
        </p>
      </div>
    </div>
  );
};

const PinField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}> = ({ label, value, onChange, disabled, autoFocus }) => (
  <label className="block">
    <span className="block text-[10px] font-black uppercase tracking-[0.2em] text-ds-ink3 mb-2">{label}</span>
    <input
      type="password"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      maxLength={PIN_LENGTH}
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="000000"
      className="w-full text-center font-mono text-2xl font-black tracking-[0.45em] py-3 rounded-2xl bg-ds-card2 border border-ds-border text-ds-ink outline-none focus:border-ds-green focus:ring-2 focus:ring-ds-green/15 disabled:opacity-50"
    />
  </label>
);

export default AgentPinGate;
