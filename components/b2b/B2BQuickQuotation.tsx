import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, ShieldCheck, Calculator, Printer, Image as ImageIcon } from 'lucide-react';
import jsPDF from 'jspdf';
import { calcBulkPremium, getActiveBulkRateConfig, TPL_OPTIONS, type VehicleClass, type FleetCoverage, type FleetAddOns } from '../../services/b2bFleetRating';
import { PROVINCES, getZone } from '../../services/ojkRates';

type Props={lang:'ID'|'EN'|string}; type Template='invoice'|'proposal';
const money=(n:number)=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Math.round(n||0));
const rupiah=(n:number)=>'Rp'+new Intl.NumberFormat('id-ID',{maximumFractionDigits:0}).format(Math.round(n||0));

function renderDocument(canvas:HTMLCanvasElement,d:{
 template:Template; quoteNo:string; date:string; customer:string; phone:string; make:string; model:string; year:string; plate:string;
 province:string; zone:number; vehicleClass:VehicleClass; vehicleValue:number; months:number; tplLimit:number; notes:string;
 result:ReturnType<typeof calcBulkPremium>
}) {
 const W=1200,H=1660; canvas.width=W;canvas.height=H;const x=canvas.getContext('2d');if(!x)return;
 const green='#08764f',dark='#064b37',lime='#e5f7b9',ink='#17251f',muted='#58675f',orange='#ef8b19',border='#9bc9ad';
 const box=(a:number,b:number,w:number,h:number,fill='#fff',stroke=border)=>{x.beginPath();x.roundRect(a,b,w,h,16);x.fillStyle=fill;x.fill();if(stroke){x.strokeStyle=stroke;x.lineWidth=2;x.stroke();}};
 const text=(s:string,a:number,b:number,size=18,color=ink,bold=false,align:CanvasTextAlign='left')=>{x.fillStyle=color;x.font=(bold?'700 ':'400 ')+size+'px Arial';x.textAlign=align;x.fillText(s,a,b);};
 const fit=(s:string,w:number,size=18)=>{x.font='400 '+size+'px Arial';while(x.measureText(s).width>w&&s.length>4)s=s.slice(0,-2)+'…';return s;};
 const total=d.result.totalPremium, vehicle=[d.make,d.model,d.year].filter(Boolean).join(' ');
 const addonNames:Record<string,string>={flood:'Perluasan Banjir',earthquake:'Perluasan Gempa Bumi',srcc:'Perluasan Huru-hara / SRCC',tpl:'Tanggung Jawab Pihak Ketiga (TPL)',authorizedWorkshop:'Authorized Garage / Bengkel Resmi',paDriver:'Personal Accident Pengemudi',paPassenger:'Personal Accident Penumpang',terrorism:'Terorisme & Sabotase'};
 x.fillStyle='#fff';x.fillRect(0,0,W,H);
 const grad=x.createLinearGradient(0,0,W,270);grad.addColorStop(0,'#e9f8ff');grad.addColorStop(.55,'#c5ebf7');grad.addColorStop(1,green);x.fillStyle=grad;x.fillRect(0,0,W,270);
 x.fillStyle='#8dca28';x.beginPath();x.moveTo(54,30);x.lineTo(94,13);x.lineTo(134,30);x.lineTo(127,91);x.lineTo(94,117);x.lineTo(61,91);x.closePath();x.fill();
 x.fillStyle=dark;x.beginPath();x.moveTo(94,27);x.lineTo(119,40);x.lineTo(113,82);x.lineTo(94,100);x.lineTo(75,82);x.closePath();x.fill();text('✓',94,78,38,'#fff',true,'center');
 text('SurePath',151,66,49,dark,true);text('Your Path to Protection.',153,96,19);
 text('PENAWARAN ASURANSI',870,42,30,'#fff',true);text('KENDARAAN BERMOTOR',870,78,30,'#fff',true);text('Car Insurance Proposal',870,108,18,'#fff');
 text('RINCIAN PERHITUNGAN PREMI ASURANSI KENDARAAN',35,164,30,dark,true);
 text(d.template==='proposal'?'PROPOSAL MULTI-TAHUN':'SINGLE VEHICLE INVOICE',36,198,22,green,true);
 text('Perlindungan kendaraan berdasarkan rate aktif SurePath dan pilihan perluasan.',36,228,18,ink);
 // vector car illustration
 x.fillStyle='#f9fcfd';x.strokeStyle='#365b4d';x.lineWidth=5;x.beginPath();x.moveTo(790,214);x.lineTo(825,171);x.quadraticCurveTo(845,139,900,138);x.lineTo(1010,138);x.quadraticCurveTo(1050,141,1085,185);x.lineTo(1150,202);x.lineTo(1158,235);x.lineTo(775,235);x.closePath();x.fill();x.stroke();
 x.fillStyle='#b9e5f1';x.fillRect(865,153,88,48);x.fillRect(964,153,65,48);x.fillStyle='#20382e';x.beginPath();x.arc(850,232,23,0,Math.PI*2);x.arc(1080,232,23,0,Math.PI*2);x.fill();
 box(28,286,1144,76,'#fbfefd');text('KENDARAAN',50,313,15,muted,true);text(fit(vehicle,430,27),50,344,27,dark,true);
 text('JENIS',530,313,15,muted,true);text(d.vehicleClass==='CAR'?'Mobil':d.vehicleClass==='MOTORCYCLE'?'Sepeda Motor':'Alat Berat',530,344,22,ink,true);
 text('NILAI PERTANGGUNGAN',720,313,15,muted,true);text(rupiah(d.vehicleValue),720,344,22,dark,true);text('TENOR',965,313,15,muted,true);text(d.months+' Bulan',965,344,22,dark,true);
 const summary=[['NILAI KENDARAAN',rupiah(d.vehicleValue)],['RATE DASAR',(d.result.rate*100).toFixed(3)+'%'],['MASA PERTANGGUNGAN',d.months+' Bulan'],['DISKON',(d.result.discountRate*100).toFixed(0)+'%'],['BIAYA ADMIN',rupiah(d.result.adminFee)]];
 summary.forEach((v,i)=>{const a=28+i*230;box(a,378,218,84,'#f8fcf5','#b8d9c0');text(v[0],a+14,407,14,muted,true);text(v[1],a+14,442,22,i===4?orange:dark,true);});
 const top=482;box(28,top,345,250);box(390,top,510,250);box(917,top,255,250);
 [[28,345,'SKEMA & CAKUPAN'],[390,510,'DASAR PERHITUNGAN RATE'],[917,255,'RATE DASAR']].forEach(v=>{box(v[0],top,v[1],42,green,green);text(v[2],v[0]+20,top+29,20,'#fff',true);});
 const coverage=d.result.coverage==='COMPREHENSIVE'?'Comprehensive (All Risk)':'Total Loss Only (TLO)';
 const addOns=Object.entries(d.result.addonsDetail||{});
 [coverage,...addOns.map(v=>addonNames[v[0]]||v[0]),'Biaya administrasi sesuai rate aktif'].slice(0,7).forEach((s,i)=>{text('✓',48,top+78+i*27,20,green,true);text(fit(s,285,17),77,top+78+i*27,17);});
 const rateRows=[['Rate kendaraan',(d.result.rate*100).toFixed(4)+'%'],['Zona wilayah','Wilayah '+d.zone],['Diskon aktif',(d.result.discountRate*100).toFixed(2)+'%'],['Penyusutan',(d.result.depreciationRate*100).toFixed(1)+'% / tahun'],['Nilai basis',rupiah(d.vehicleValue)]];
 rateRows.forEach((r,i)=>{text(r[0],412,top+78+i*34,17,muted);text(r[1],870,top+78+i*34,18,dark,true,'right');});
 box(937,top+66,215,74,'#f2fae7','#c6e69a');text('RATE YANG DIPAKAI',1050,top+94,14,muted,true,'center');text((d.result.rate*100).toFixed(3)+'%',1050,top+127,30,green,true,'center');
 box(937,top+154,215,74,'#f2fae7');text('TOTAL PREMI',1050,top+182,14,muted,true,'center');text(rupiah(total),1050,top+215,23,green,true,'center');
 const ty=752,th=d.result.schedule.length?320:275;box(28,ty,1144,th);box(28,ty,1144,42,green,green);text(d.template==='proposal'?'RINCIAN PERHITUNGAN PREMI PER TAHUN':'RINCIAN PERHITUNGAN PREMI',50,ty+29,22,'#fff',true);
 x.fillStyle=lime;x.fillRect(42,ty+52,1116,38);text('KOMPONEN',55,ty+76,15,dark,true);text('NILAI BASIS',390,ty+76,15,dark,true,'right');text('RATE',575,ty+76,15,dark,true,'right');text('KETERANGAN',780,ty+76,15,dark,true);text('PREMI (RP)',1138,ty+76,15,dark,true,'right');
 const rows:Array<[string,string,string,string,number]>=[['Premi kendaraan (gross)',rupiah(d.vehicleValue),(d.result.rate*100).toFixed(4)+'%','Sesuai rate aktif',d.result.premiumGross],['Diskon','—',(d.result.discountRate*100).toFixed(2)+'%','Potongan premi dasar',-d.result.discountAmount]];
 addOns.forEach(v=>rows.push([addonNames[v[0]]||v[0],'—','—','Perluasan terpilih',v[1]]));
 if(d.result.planLoading)rows.push(['Loading paket','—','—','Sesuai konfigurasi',d.result.planLoading]);
 rows.push(['Biaya administrasi','—','—','Sesuai rate set aktif',d.result.adminFee]);
 rows.forEach((r,i)=>{const y=ty+116+i*34;if(i%2===0){x.fillStyle='#f7fbf5';x.fillRect(42,y-23,1116,32);}text(fit(r[0],300,16),55,y,16,ink);text(r[1],390,y,16,ink,false,'right');text(r[2],575,y,16,ink,false,'right');text(r[3],780,y,15,muted);text(rupiah(r[4]),1138,y,16,r[4]<0?'#c43d2e':dark,true,'right');});
 const totalY=ty+116+rows.length*34;x.fillStyle='#e4f6bf';x.fillRect(42,totalY-23,1116,38);text('TOTAL ESTIMASI PREMI',55,totalY+3,18,dark,true);text(rupiah(total),1138,totalY+3,21,green,true,'right');
 let low=ty+th+22;
 if(d.result.schedule.length){box(28,low,1144,190);box(28,low,1144,40,green,green);text('JADWAL NILAI PERTANGGUNGAN & PREMI',50,low+27,20,'#fff',true);text('TAHUN',55,low+70,15,dark,true);text('NILAI PERTANGGUNGAN',260,low+70,15,dark,true);text('BULAN',520,low+70,15,dark,true);text('RATE',760,low+70,15,dark,true);text('PREMI GROSS',1135,low+70,15,dark,true,'right');
 d.result.schedule.slice(0,5).forEach((r,i)=>{const y=low+108+i*28;text(String(r.year),55,y,16);text(rupiah(r.sumInsured),260,y,16);text(String(r.months),520,y,16);text((d.result.rate*100).toFixed(3)+'%',760,y,16);text(rupiah(r.premiumGross),1135,y,16,dark,true,'right');});low+=205;}
 box(28,low,555,160);box(28,low,555,40,orange,orange);text('REKAPITULASI PEMBAYARAN',48,low+27,20,'#fff',true);
 const recap=[['Premi kendaraan (gross)',d.result.premiumGross],['Diskon',-d.result.discountAmount],['Perluasan / TPL / PA',d.result.addonPremium],['Loading paket',d.result.planLoading],['Biaya administrasi',d.result.adminFee]];
 recap.forEach((r,i)=>{text(r[0],48,low+65+i*20,16);text(rupiah(r[1]),555,low+70+i*24,16,ink,true,'right');});
 box(605,low,567,160);box(605,low,567,40,green,green);text('INFORMASI PERTANGGUNGAN',625,low+27,20,'#fff',true);
 const info=['Customer: '+(d.customer||'Belum diisi'),'Kendaraan: '+vehicle,'Nomor polisi: '+(d.plate||'Belum diisi'),'Wilayah: '+d.province+' (Zona '+d.zone+')','Tenor: '+d.months+' bulan · TPL limit: '+rupiah(d.tplLimit)];
 info.forEach((s,i)=>text(fit(s,520,16),625,low+65+i*20,16));
 low+=170;box(28,low,1144,70,'#f7fbf4');text('KETERANGAN',50,low+29,18,green,true);text('Estimasi indikatif berdasarkan rate set aktif SurePath. Premi, syarat, dan penerimaan risiko final',50,low+56,15,muted);text('mengikuti konfirmasi serta proses underwriting perusahaan asuransi. Bukan bukti penerbitan polis.',50,low+68,15,muted);
 if(d.notes)text('Catatan: '+fit(d.notes,1000,14),50,low+91,14,muted);
 x.fillStyle=dark;x.fillRect(0,H-74,W,74);text('www.myinsurepath.com',45,H-30,18,'#fff',true);text('cs@myinsurepath.com',430,H-30,18,'#fff');text('SurePath · Your Path to Protection',1150,H-30,18,'#fff',true,'right');
}

const B2BQuickQuotation:React.FC<Props>=({lang})=>{
 const [template,setTemplate]=useState<Template>('proposal');
 const [customer,setCustomer]=useState('');const [phone,setPhone]=useState('');
 const [make,setMake]=useState('Toyota');const [model,setModel]=useState('Zenix');const [year,setYear]=useState(String(new Date().getFullYear()));const [plate,setPlate]=useState('');
 const [province,setProvince]=useState('DKI Jakarta');const [vehicleClass,setVehicleClass]=useState<VehicleClass>('CAR');const [coverage,setCoverage]=useState<FleetCoverage>('COMPREHENSIVE');
 const [otr,setOtr]=useState('250000000');const [sumInsured,setSumInsured]=useState('250000000');const [tenor,setTenor]=useState('60');const [depreciation,setDepreciation]=useState('10');const [discount,setDiscount]=useState('25');const [tpl,setTpl]=useState('25000000');
 const [flood,setFlood]=useState(true);const [earthquake,setEarthquake]=useState(false);const [srcc,setSrcc]=useState(true);const [authorizedWorkshop,setAuthorizedWorkshop]=useState(false);const [paDriver,setPaDriver]=useState(false);const [paSeats,setPaSeats]=useState('0');const [notes,setNotes]=useState('');
 const [quoteNo]=useState(()=> 'SPQ-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+Math.floor(1000+Math.random()*9000));const [preview,setPreview]=useState('');
 const config=getActiveBulkRateConfig(),months=Math.max(1,Math.min(72,Number(tenor)||12)),value=Math.max(0,Number(sumInsured)||0),zone=getZone(province);
 const addons:FleetAddOns={flood,earthquake,srcc,tplLimit:Number(tpl)||0,authorizedWorkshop,paDriver,paPassengerSeats:Number(paSeats)||0};
 const result=useMemo(()=>value?calcBulkPremium({vehicleClass,zone,financingValue:value,otr:Math.max(0,Number(otr)||value),tenorMonths:months,coverage,depreciationRate:months>12?Math.min(.5,Math.max(0,Number(depreciation)/100)):0,discountRateOverride:Math.min(vehicleClass==='HEAVY_EQUIPMENT'?config.discountRateHeavy:config.discountRateStandard,Math.max(0,Number(discount)/100)),addons},config):null,[value,vehicleClass,zone,otr,months,coverage,depreciation,discount,tpl,flood,earthquake,srcc,authorizedWorkshop,paDriver,paSeats,config]);
 const date=new Date().toLocaleDateString(lang==='EN'?'en-GB':'id-ID',{day:'2-digit',month:'long',year:'numeric'});
 useEffect(()=>{if(!result){setPreview('');return;}const canvas=document.createElement('canvas');renderDocument(canvas,{template,quoteNo,date,customer,phone,make,model,year,plate,province,zone,vehicleClass,vehicleValue:value,months,tplLimit:Number(tpl)||0,notes,result});setPreview(canvas.toDataURL('image/png'));},[result,template,quoteNo,date,customer,phone,make,model,year,plate,province,zone,vehicleClass,value,months,tpl,notes]);
 const pdf=()=>{if(!preview)return;const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});doc.addImage(preview,'PNG',0,0,210,297,undefined,'FAST');doc.save(quoteNo+'-'+template+'.pdf');};
 const png=()=>{if(!preview)return;const a=document.createElement('a');a.href=preview;a.download=quoteNo+'-'+template+'.png';a.click();};
 const cls='w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100';
 const Field=({label,children}:{label:string;children:React.ReactNode})=><label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span>{children}</label>;
 const Toggle=({label,checked,onChange}:{label:string;checked:boolean;onChange:(v:boolean)=>void})=><label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-xs"><span>{label}</span><input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} className="h-4 w-4 accent-emerald-700"/></label>;
 const heavy=vehicleClass==='HEAVY_EQUIPMENT';
 return <div className="mx-auto max-w-[1500px] space-y-4">
 <header className="flex flex-wrap items-center justify-between gap-3"><div><div className="mb-1 flex items-center gap-2 text-emerald-700"><Calculator size={17}/><span className="text-xs font-black uppercase tracking-[.18em]">SurePath Quotation Studio</span></div><h1 className="text-2xl font-black text-slate-900">Quick Quotation</h1><p className="mt-1 text-sm text-slate-500">Isi data di kiri dan lihat dokumen quotation SurePath di kanan.</p></div><div className="flex gap-2"><button type="button" onClick={()=>setTemplate('invoice')} className={'rounded-lg border px-3 py-2 text-xs font-bold '+(template==='invoice'?'border-emerald-700 bg-emerald-700 text-white':'border-slate-200 bg-white text-slate-600')}><FileText size={14} className="mr-1 inline"/>Single Vehicle Invoice</button><button type="button" onClick={()=>setTemplate('proposal')} className={'rounded-lg border px-3 py-2 text-xs font-bold '+(template==='proposal'?'border-emerald-700 bg-emerald-700 text-white':'border-slate-200 bg-white text-slate-600')}><Printer size={14} className="mr-1 inline"/>Multi-Year Proposal</button></div></header>
 <div className="grid items-start gap-4 2xl:grid-cols-[360px_minmax(0,1fr)]">
 <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-center gap-2 border-b border-slate-100 pb-3"><ShieldCheck size={18} className="text-emerald-700"/><div><h2 className="font-bold text-slate-900">Data Penawaran</h2><p className="text-xs text-slate-500">Rate aktif dari SurePath</p></div></div><div className="grid grid-cols-2 gap-3">
 <Field label="Nama customer"><input className={cls} value={customer} onChange={e=>setCustomer(e.target.value)} placeholder="Nama nasabah"/></Field><Field label="Telepon"><input className={cls} value={phone} onChange={e=>setPhone(e.target.value)}/></Field>
 <Field label="Jenis kendaraan"><select className={cls} value={vehicleClass} onChange={e=>{const v=e.target.value as VehicleClass;setVehicleClass(v);if(v==='HEAVY_EQUIPMENT')setCoverage('TLO');}}><option value="CAR">Mobil</option><option value="MOTORCYCLE">Motor</option><option value="HEAVY_EQUIPMENT">Alat berat</option></select></Field>
 <Field label="Pertanggungan"><select className={cls} value={coverage} disabled={heavy} onChange={e=>setCoverage(e.target.value as FleetCoverage)}><option value="COMPREHENSIVE">Comprehensive</option><option value="TLO">TLO</option></select></Field>
 <Field label="Merek"><input className={cls} value={make} onChange={e=>setMake(e.target.value)}/></Field><Field label="Model / tipe"><input className={cls} value={model} onChange={e=>setModel(e.target.value)}/></Field>
 <Field label="Tahun kendaraan"><input className={cls} inputMode="numeric" value={year} onChange={e=>setYear(e.target.value.replace(/[^0-9]/g,''))}/></Field><Field label="Nomor polisi"><input className={cls} value={plate} onChange={e=>setPlate(e.target.value.toUpperCase())}/></Field>
 <Field label="Provinsi"><select className={cls} value={province} onChange={e=>setProvince(e.target.value)}>{PROVINCES.map(p=><option key={p} value={p}>{p}</option>)}</select></Field><Field label="Nilai pertanggungan (Rp)"><input className={cls} inputMode="numeric" value={sumInsured} onChange={e=>setSumInsured(e.target.value.replace(/[^0-9]/g,''))}/></Field>
 <Field label="Harga OTR (Rp)"><input className={cls} inputMode="numeric" value={otr} onChange={e=>setOtr(e.target.value.replace(/[^0-9]/g,''))}/></Field><Field label="Tenor"><select className={cls} value={tenor} onChange={e=>setTenor(e.target.value)}>{[6,12,18,24,36,48,60,72].map(n=><option key={n} value={n}>{n} bulan</option>)}</select></Field>
 <Field label="Depresiasi / tahun (%)"><input className={cls} type="number" min="0" max="50" value={depreciation} disabled={months<=12} onChange={e=>setDepreciation(e.target.value)}/></Field><Field label="Diskon (%)"><input className={cls} type="number" min="0" max="25" value={discount} onChange={e=>setDiscount(e.target.value)}/></Field>
 <Field label="TPL limit"><select className={cls} value={tpl} onChange={e=>setTpl(e.target.value)}>{TPL_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></Field></div>
 <div className="border-t border-slate-100 pt-3"><p className="mb-2 text-xs font-black uppercase tracking-wider text-slate-500">Perluasan / manfaat</p><div className="grid grid-cols-2 gap-2"><Toggle label="Banjir" checked={flood} onChange={setFlood}/><Toggle label="Gempa bumi" checked={earthquake} onChange={setEarthquake}/><Toggle label="SRCC" checked={srcc} onChange={setSrcc}/><Toggle label="Authorized garage" checked={authorizedWorkshop} onChange={setAuthorizedWorkshop}/><Toggle label="PA pengemudi" checked={paDriver} onChange={setPaDriver}/><Field label="PA penumpang"><select className={cls} value={paSeats} onChange={e=>setPaSeats(e.target.value)}>{[0,1,2,3,4,5,6,7].map(n=><option key={n} value={n}>{n} kursi</option>)}</select></Field></div></div>
 <Field label="Catatan penawaran"><textarea className={cls+' min-h-20'} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Catatan untuk customer"/></Field>
 <div className="rounded-lg bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900">Perhitungan memakai engine B2B yang sudah ada. Biaya administrasi, diskon, dan perluasan mengikuti konfigurasi aktif. Estimasi bukan konfirmasi penerbitan polis.</div></section>
 <section className="min-w-0 space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-bold text-slate-900">Preview Dokumen Quotation</h2><p className="text-xs text-slate-500">Layout portrait mengikuti referensi desain SurePath.</p></div><div className="flex gap-2"><button type="button" onClick={pdf} disabled={!preview} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"><Download size={15} className="mr-1 inline"/>Export PDF</button><button type="button" onClick={png} disabled={!preview} className="rounded-lg border border-emerald-700 px-4 py-2.5 text-sm font-bold text-emerald-800 disabled:opacity-40"><ImageIcon size={15} className="mr-1 inline"/>Export PNG</button></div></div>
 <div className="overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-2 sm:p-4"><div className="mx-auto w-full max-w-[760px] bg-white shadow-xl">{preview?<img src={preview} alt="Preview quotation SurePath" className="block h-auto w-full"/>:<div className="p-10 text-center text-sm text-slate-500">Masukkan nilai pertanggungan untuk melihat preview.</div>}</div></div>{result&&<div className="flex justify-between rounded-lg border border-emerald-100 bg-white px-4 py-3 text-sm"><span className="text-slate-500">Total estimasi premi</span><strong className="text-lg text-emerald-800">{money(result.totalPremium)}</strong></div>}</section>
 </div></div>;
};
export default B2BQuickQuotation;
