import React, { useMemo, useState } from 'react';
import { Download, FileText, CarFront, ShieldCheck, Calculator, Printer } from 'lucide-react';
import jsPDF from 'jspdf';
import {
  calcBulkPremium, getActiveBulkRateConfig, TPL_OPTIONS,
  type VehicleClass, type FleetCoverage, type FleetAddOns,
} from '../../services/b2bFleetRating';
import { PROVINCES, getZone } from '../../services/ojkRates';

type Props = { lang: 'ID' | 'EN' | string };
type Template = 'invoice' | 'proposal';

const money = (n: number) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Math.round(n || 0));
const B2BQuickQuotation: React.FC<Props> = ({ lang }) => {
  const isEn = lang === 'EN';
  const [template, setTemplate] = useState<Template>('invoice');
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [make, setMake] = useState('Toyota');
  const [model, setModel] = useState('Avanza');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [plate, setPlate] = useState('');
  const [province, setProvince] = useState('DKI Jakarta');
  const [vehicleClass, setVehicleClass] = useState<VehicleClass>('CAR');
  const [coverage, setCoverage] = useState<FleetCoverage>('COMPREHENSIVE');
  const [otr, setOtr] = useState('250000000');
  const [sumInsured, setSumInsured] = useState('250000000');
  const [tenor, setTenor] = useState('12');
  const [depreciation, setDepreciation] = useState('10');
  const [discount, setDiscount] = useState('25');
  const [tpl, setTpl] = useState('0');
  const [flood, setFlood] = useState(false);
  const [earthquake, setEarthquake] = useState(false);
  const [srcc, setSrcc] = useState(false);
  const [paDriver, setPaDriver] = useState(false);
  const [paSeats, setPaSeats] = useState('0');
  const [notes, setNotes] = useState('');
  const [quoteNo] = useState(() => 'SPQ-' + Date.now().toString().slice(-8));

  const rateConfig = getActiveBulkRateConfig();
  const months = Math.max(1, Math.min(72, Number(tenor) || 12));
  const vehicleValue = Math.max(0, Number(sumInsured) || 0);
  const addon: FleetAddOns = {
    flood, earthquake, srcc, tplLimit: Number(tpl) || 0,
    paDriver, paPassengerSeats: Number(paSeats) || 0,
  };
  const result = useMemo(() => {
    if (!vehicleValue) return null;
    return calcBulkPremium({
      vehicleClass, zone: getZone(province), financingValue: vehicleValue,
      otr: Math.max(0, Number(otr) || vehicleValue), tenorMonths: months,
      coverage, depreciationRate: months > 12 ? Math.min(0.5, Math.max(0, Number(depreciation) / 100)) : 0,
      discountRateOverride: Math.min(vehicleClass === 'HEAVY_EQUIPMENT' ? rateConfig.discountRateHeavy : rateConfig.discountRateStandard, Math.max(0, Number(discount) / 100)),
      addons,
    }, rateConfig);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleClass, province, vehicleValue, otr, months, coverage, depreciation, discount, tpl, flood, earthquake, srcc, paDriver, paSeats, rateConfig]);

  const fmtDate = new Date().toLocaleDateString(isEn ? 'en-GB' : 'id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  const schedule = result?.schedule ?? [];
  const lines = [
    ['Premi dasar', result?.premiumGross ?? 0],
    ['Diskon', -(result?.discountAmount ?? 0)],
    ['Perluasan / TPL / PA', result?.addonPremium ?? 0],
    ['Biaya administrasi', result?.adminFee ?? 0],
    ['Total premi', result?.totalPremium ?? 0],
  ] as Array<[string, number]>;

  const exportPdf = () => {
    if (!result) return;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const green = [5, 115, 82] as [number, number, number];
    pdf.setFillColor(...green); pdf.rect(0, 0, 210, 36, 'F');
    pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(19);
    pdf.text('SurePath', 15, 16); pdf.setFontSize(10); pdf.setFont('helvetica', 'normal');
    pdf.text(template === 'invoice' ? 'SINGLE VEHICLE PREMIUM QUOTATION' : 'MULTI-YEAR INSURANCE PROPOSAL', 15, 25);
    pdf.setTextColor(35, 45, 45); pdf.setFontSize(10);
    pdf.text('Quotation: ' + quoteNo, 15, 47); pdf.text('Date: ' + fmtDate, 145, 47);
    pdf.setFont('helvetica', 'bold'); pdf.text('CUSTOMER', 15, 60);
    pdf.setFont('helvetica', 'normal'); pdf.text(customer || '—', 15, 67); pdf.text(phone || '—', 15, 73);
    pdf.setFont('helvetica', 'bold'); pdf.text('VEHICLE & COVERAGE', 15, 88);
    pdf.setFont('helvetica', 'normal');
    pdf.text([make, model, year].filter(Boolean).join(' '), 15, 95);
    pdf.text('Plate: ' + (plate || '—') + ' | Province: ' + province, 15, 102);
    pdf.text('Coverage: ' + result.coverage + ' | Tenor: ' + months + ' months | Zone ' + getZone(province), 15, 109);
    pdf.text('Insured value: ' + money(vehicleValue), 15, 116);
    pdf.setFont('helvetica', 'bold'); pdf.text('PREMIUM BREAKDOWN', 15, 132);
    let y = 141;
    for (const [label, value] of lines) {
      pdf.setFont('helvetica', label === 'Total premi' ? 'bold' : 'normal');
      pdf.text(label, 15, y); pdf.text(money(value), 195, y, { align: 'right' }); y += 8;
    }
    if (template === 'proposal' && schedule.length) {
      y += 7; pdf.setFont('helvetica', 'bold'); pdf.text('MULTI-YEAR SCHEDULE', 15, y); y += 8;
      pdf.setFont('helvetica', 'normal');
      for (const row of schedule) { pdf.text('Year ' + row.year + ' (' + row.months + ' months)', 15, y); pdf.text(money(row.premiumGross), 195, y, { align: 'right' }); y += 7; }
    }
    if (notes) { y += 7; pdf.setFont('helvetica', 'bold'); pdf.text('NOTES', 15, y); y += 7; pdf.setFont('helvetica', 'normal'); pdf.text(pdf.splitTextToSize(notes, 175), 15, y); }
    pdf.setFontSize(8); pdf.setTextColor(100, 110, 110);
    pdf.text('Indicative premium estimate only. Final terms, acceptance and premium are subject to insurer underwriting and confirmation.', 15, 282, { maxWidth: 180 });
    pdf.save(quoteNo + '-' + template + '.pdf');
  };

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span>{children}</label>
  );
  const input = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100';
  const total = result?.totalPremium ?? 0;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="mb-1 flex items-center gap-2 text-emerald-700"><Calculator size={18}/><span className="text-xs font-black uppercase tracking-[.18em]">SurePath Studio</span></div>
          <h1 className="text-2xl font-black text-slate-900">{isEn ? 'Quick Quotation' : 'Quick Quotation'}</h1>
          <p className="mt-1 text-sm text-slate-500">{isEn ? 'Create a clear, client-ready vehicle premium estimate.' : 'Buat estimasi premi kendaraan yang rapi dan siap ditunjukkan ke klien.'}</p></div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800"><ShieldCheck size={14} className="mr-1 inline"/> {isEn ? 'Uses active SurePath rates' : 'Menggunakan rate SurePath aktif'}</div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Nama klien / Customer"><input className={input} value={customer} onChange={e=>setCustomer(e.target.value)} placeholder="Nama nasabah / perusahaan"/></Field>
            <Field label="Nomor telepon"><input className={input} value={phone} onChange={e=>setPhone(e.target.value)} placeholder="08xxxxxxxxxx"/></Field>
            <Field label="Jenis kendaraan"><select className={input} value={vehicleClass} onChange={e=>{setVehicleClass(e.target.value as VehicleClass);if(e.target.value==='HEAVY_EQUIPMENT')setCoverage('TLO');}}><option value="CAR">Mobil</option><option value="MOTORCYCLE">Motor</option><option value="HEAVY_EQUIPMENT">Alat berat</option></select></Field>
            <Field label="Pertanggungan"><select className={input} value={coverage} onChange={e=>setCoverage(e.target.value as FleetCoverage)}><option value="COMPREHENSIVE">Comprehensive / All Risk</option><option value="TLO">TLO</option></select></Field>
            <Field label="Merek"><input className={input} value={make} onChange={e=>setMake(e.target.value)} /></Field>
            <Field label="Model / tipe"><input className={input} value={model} onChange={e=>setModel(e.target.value)} /></Field>
            <Field label="Tahun kendaraan"><input className={input} inputMode="numeric" value={year} onChange={e=>setYear(e.target.value)} /></Field>
            <Field label="Nomor polisi"><input className={input} value={plate} onChange={e=>setPlate(e.target.value.toUpperCase())} /></Field>
            <Field label="Provinsi / wilayah"><select className={input} value={province} onChange={e=>setProvince(e.target.value)}>{PROVINCES.map(p=><option key={p} value={p}>{p}</option>)}</select></Field>
            <Field label="Nilai pertanggungan / pencairan (Rp)"><input className={input} inputMode="numeric" value={sumInsured} onChange={e=>setSumInsured(e.target.value.replace(/[^0-9]/g,''))}/></Field>
            <Field label="Harga OTR (Rp)"><input className={input} inputMode="numeric" value={otr} onChange={e=>setOtr(e.target.value.replace(/[^0-9]/g,''))}/></Field>
            <Field label="Tenor"><select className={input} value={tenor} onChange={e=>setTenor(e.target.value)}>{[6,12,18,24,36,48,60,72].map(n=><option key={n} value={n}>{n} bulan</option>)}</select></Field>
            <Field label="Diskon (%)"><input className={input} type="number" min="0" max="25" value={discount} onChange={e=>setDiscount(e.target.value)}/><span className="text-[10px] text-slate-400">Dibatasi oleh plafon rate set aktif.</span></Field>
            <Field label="Penyusutan per tahun (%)"><input className={input} type="number" min="0" max="50" value={depreciation} onChange={e=>setDepreciation(e.target.value)} disabled={months<=12}/></Field>
            <Field label="TPL"><select className={input} value={tpl} onChange={e=>setTpl(e.target.value)}>{TPL_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
          </div>
          <div className="border-t border-slate-100 pt-4"><p className="mb-3 text-xs font-black uppercase tracking-wider text-slate-500">Perluasan opsional</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {[[flood,setFlood,'Banjir'],[earthquake,setEarthquake,'Gempa bumi'],[srcc,setSrcc,'Huru-hara & kerusuhan'],[paDriver,setPaDriver,'PA pengemudi']].map(([v,set,label]: any)=><label key={label} className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-sm"><input type="checkbox" checked={v} onChange={e=>set(e.target.checked)} className="accent-emerald-600"/>{label}</label>)}
              <Field label="PA penumpang (jumlah kursi)"><select className={input} value={paSeats} onChange={e=>setPaSeats(e.target.value)}>{[0,1,2,3,4,5,6,7].map(n=><option key={n} value={n}>{n} kursi</option>)}</select></Field>
            </div>
          </div>
          <Field label="Catatan / ketentuan khusus"><textarea className={input+' min-h-20'} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Catatan untuk klien (opsional)"/></Field>
        </section>

        <aside className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
            <div className="bg-gradient-to-r from-emerald-800 to-emerald-600 p-5 text-white"><div className="flex items-center justify-between"><span className="text-xs font-black uppercase tracking-[.2em]">SurePath</span><CarFront size={22}/></div><p className="mt-5 text-xs text-emerald-100">ESTIMASI PREMI ASURANSI</p><div className="mt-1 text-3xl font-black">{money(total)}</div><p className="mt-2 text-xs text-emerald-100">{quoteNo} · {fmtDate}</p></div>
            <div className="space-y-4 p-5">
              <div><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Tertanggung</p><p className="font-bold text-slate-900">{customer || 'Nama klien'}</p><p className="text-sm text-slate-500">{[make,model,year].filter(Boolean).join(' ')}</p><p className="text-xs text-slate-400">{plate || 'Nomor polisi'} · Zona {getZone(province)}</p></div>
              <div className="space-y-2 border-y border-dashed border-slate-200 py-3">
                {lines.map(([label,value])=><div key={label} className={'flex justify-between gap-2 text-sm '+(label==='Total premi'?'font-black text-emerald-800':'text-slate-600')}><span>{label}</span><span className="text-right tabular-nums">{money(value)}</span></div>)}
              </div>
              {template==='proposal' && schedule.length>0 && <div><p className="mb-2 text-xs font-black uppercase tracking-wider text-slate-500">Jadwal premi tahunan</p>{schedule.map(row=><div key={row.year} className="flex justify-between py-1 text-xs text-slate-600"><span>Tahun {row.year} · {row.months} bln</span><b>{money(row.premiumGross)}</b></div>)}</div>}
              <p className="text-[10px] leading-relaxed text-slate-400">Estimasi indikatif. Premi final, syarat pertanggungan, dan persetujuan tetap mengikuti underwriting serta konfirmasi perusahaan asuransi.</p>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="mb-3 text-xs font-black uppercase tracking-wider text-slate-500">Format dokumen</p>
            <div className="grid grid-cols-2 gap-2"><button onClick={()=>setTemplate('invoice')} className={'rounded-xl border p-3 text-left text-xs font-bold '+(template==='invoice'?'border-emerald-500 bg-emerald-50 text-emerald-800':'border-slate-200 text-slate-600')}><FileText size={16} className="mb-2"/>Single Vehicle Invoice</button><button onClick={()=>setTemplate('proposal')} className={'rounded-xl border p-3 text-left text-xs font-bold '+(template==='proposal'?'border-emerald-500 bg-emerald-50 text-emerald-800':'border-slate-200 text-slate-600')}><Printer size={16} className="mb-2"/>Multi-Year Proposal</button></div>
            <button onClick={exportPdf} disabled={!result} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-black text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"><Download size={16}/> Export PDF</button>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-400">PDF memakai angka dan detail yang sama dengan preview. Pengiriman/penyimpanan quotation belum terhubung ke server.</p>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default B2BQuickQuotation;
