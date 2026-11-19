// Direktori bengkel rekanan — dipakai bersama oleh CMS admin dan portal B2B.
//
// Data TIDAK dikirim sebagai aset statis: semua baris datang dari aksi gateway
// `list_workshop_partners`, yang digerbang peran di server. Filter kategori,
// tab asuransi, pencarian, dan sorting kota/brand/kategori terjadi di gateway
// supaya aturannya sama di kedua portal dan tidak bisa dimanipulasi klien.
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight,
  Loader2, MapPin, RefreshCw, Search,
} from 'lucide-react';
import { callGateway } from '../../services/db';
import {
  WORKSHOP_CATEGORY_LABELS, WORKSHOP_INSURERS,
  type WorkshopCategoryFilter, type WorkshopFacets, type WorkshopInsurerFilter,
  type WorkshopPartner, type WorkshopSortBy, type WorkshopSortDir,
} from '../../supabase/functions/_shared/workshopDirectory.ts';

interface Props {
  /** 'admin' memakai kontras CMS; 'b2b' memakai kontras portal korporat. */
  variant?: 'admin' | 'b2b';
}

const PAGE_SIZE = 25;

const SORT_OPTIONS: ReadonlyArray<{ value: WorkshopSortBy; label: string }> = [
  { value: 'name', label: 'Nama bengkel' },
  { value: 'city', label: 'Kota' },
  { value: 'province', label: 'Provinsi' },
  { value: 'brand', label: 'Brand' },
  { value: 'category', label: 'Kategori' },
  { value: 'insurer', label: 'Asuransi' },
];

const CATEGORY_TABS: ReadonlyArray<{ value: WorkshopCategoryFilter; label: string }> = [
  { value: 'all', label: 'Semua' },
  { value: 'authorized', label: WORKSHOP_CATEGORY_LABELS.authorized },
  { value: 'umum', label: WORKSHOP_CATEGORY_LABELS.umum },
  { value: 'other', label: WORKSHOP_CATEGORY_LABELS.other },
];

const formatNumber = (value: number) => new Intl.NumberFormat('id-ID').format(value);

const WorkshopDirectory: React.FC<Props> = ({ variant = 'admin' }) => {
  const [insurer, setInsurer] = useState<WorkshopInsurerFilter>('ALL');
  const [category, setCategory] = useState<WorkshopCategoryFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<WorkshopSortBy>('name');
  const [sortDir, setSortDir] = useState<WorkshopSortDir>('asc');
  const [rows, setRows] = useState<WorkshopPartner[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<WorkshopFacets | null>(null);
  const [categoryCounts, setCategoryCounts] = useState<Record<WorkshopCategoryFilter, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  // Cari sambil mengetik tanpa membanjiri gateway: satu panggilan setelah
  // pengguna berhenti 250 ms, bukan satu panggilan per huruf.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => { setPage(0); }, [insurer, category, search, sortBy, sortDir]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await callGateway('list_workshop_partners', {
          insurer, categoryGroup: category, search, sortBy, sortDir,
        });
        if (cancelled) return;
        if (res.error) {
          setError(res.error);
          setRows([]);
          setTotal(0);
          setCategoryCounts(null);
          return;
        }
        const data = res.data as {
          rows?: WorkshopPartner[];
          total?: number;
          facets?: WorkshopFacets;
          categoryCounts?: Record<WorkshopCategoryFilter, number>;
        } | undefined;
        setRows(Array.isArray(data?.rows) ? data.rows : []);
        setTotal(Number(data?.total) || 0);
        setFacets(data?.facets ?? null);
        setCategoryCounts(data?.categoryCounts ?? null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Gagal memuat direktori bengkel.');
          setRows([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [insurer, category, search, sortBy, sortDir, reloadKey]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRows = useMemo(
    () => rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE),
    [rows, currentPage],
  );

  const isAdmin = variant === 'admin';
  const titleClass = isAdmin ? 'text-ds-ink' : 'text-slate-900';
  const mutedClass = isAdmin ? 'text-ds-ink3' : 'text-slate-500';
  const cardClass = isAdmin
    ? 'bg-ds-card border-ds-border'
    : 'bg-white border-slate-200';
  const controlClass = isAdmin
    ? 'bg-ds-card2 border-ds-border text-ds-ink placeholder:text-ds-ink3'
    : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400';

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={`text-lg font-black tracking-tight ${titleClass}`}>Direktori Bengkel Rekanan</h2>
          <p className={`text-xs mt-1 ${mutedClass}`}>
            Bengkel rekanan ZURICH, OONA, Intra Asia, dan MAG. Data diambil dari lampiran resmi tiap asuransi.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey(k => k + 1)}
          className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${cardClass} ${titleClass} hover:opacity-80 disabled:opacity-50`}
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Muat ulang
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-bold">Direktori belum dapat dimuat.</p>
            <p className="mt-0.5">{error}</p>
          </div>
          <button type="button" onClick={() => setReloadKey(k => k + 1)} className="font-bold underline">Coba lagi</button>
        </div>
      )}

      <div className={`rounded-2xl border p-4 ${cardClass}`}>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter asuransi">
          {(['ALL', ...WORKSHOP_INSURERS.map(i => i.code)] as WorkshopInsurerFilter[]).map(code => {
            const label = code === 'ALL'
              ? 'Semua asuransi'
              : WORKSHOP_INSURERS.find(i => i.code === code)?.label ?? code;
            const count = facets?.insurers[code];
            return (
              <button
                key={code}
                type="button"
                role="tab"
                aria-selected={insurer === code}
                onClick={() => setInsurer(code)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition-colors ${
                  insurer === code
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : `${cardClass} ${titleClass} hover:opacity-80`
                }`}
              >
                {label}
                {typeof count === 'number' && <span className={`ml-1.5 ${mutedClass}`}>{formatNumber(count)}</span>}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter kategori">
          {CATEGORY_TABS.map(tab => {
            const count = categoryCounts?.[tab.value];
            return (
              <button
                key={tab.value}
                type="button"
                aria-pressed={category === tab.value}
                onClick={() => setCategory(tab.value)}
                className={`rounded-full border px-3 py-1 text-[11px] font-bold transition-colors ${
                  category === tab.value
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : `${cardClass} ${titleClass} hover:opacity-80`
                }`}
              >
                {tab.label}
                {typeof count === 'number' && <span className={`ml-1 ${mutedClass}`}>{formatNumber(count)}</span>}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-[220px] flex-1">
            <span className={`block text-[11px] font-bold mb-1 ${mutedClass}`}>Cari bengkel / kota / brand</span>
            <span className="relative block">
              <Search size={14} className={`absolute left-3 top-1/2 -translate-y-1/2 ${mutedClass}`} />
              <input
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Contoh: Toyota Bandung"
                className={`w-full rounded-xl border pl-9 pr-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-400 ${controlClass}`}
              />
            </span>
          </label>
          <label>
            <span className={`block text-[11px] font-bold mb-1 ${mutedClass}`}>Urutkan</span>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as WorkshopSortBy)}
              aria-label="Kolom pengurutan"
              className={`rounded-xl border px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-400 ${controlClass}`}
            >
              {SORT_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
            aria-label={sortDir === 'asc' ? 'Ubah ke urutan menurun' : 'Ubah ke urutan menaik'}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold ${cardClass} ${titleClass} hover:opacity-80`}
          >
            {sortDir === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
            {sortDir === 'asc' ? 'Menaik' : 'Menurun'}
          </button>
        </div>
      </div>

      <div className={`rounded-2xl border ${cardClass} overflow-hidden`}>
        <div className={`flex items-center justify-between border-b px-4 py-3 text-xs ${cardClass}`}>
          <span className={`font-bold ${titleClass}`}>
            {loading ? 'Memuat…' : `${formatNumber(total)} bengkel ditemukan`}
          </span>
          {loading && <Loader2 size={14} className={`animate-spin ${mutedClass}`} />}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className={isAdmin ? 'bg-ds-card2' : 'bg-slate-50'}>
              <tr className={mutedClass}>
                <th scope="col" className="px-4 py-2 font-bold">Nama Bengkel</th>
                <th scope="col" className="px-4 py-2 font-bold">Asuransi</th>
                <th scope="col" className="px-4 py-2 font-bold">Kategori</th>
                <th scope="col" className="px-4 py-2 font-bold">Lokasi</th>
                <th scope="col" className="px-4 py-2 font-bold">Brand</th>
                <th scope="col" className="px-4 py-2 font-bold">Kontak</th>
              </tr>
            </thead>
            <tbody className={isAdmin ? 'divide-y divide-ds-border' : 'divide-y divide-slate-100'}>
              {visibleRows.map(row => (
                <tr key={row.id} className="align-top hover:bg-indigo-50/40">
                  <td className="px-4 py-3">
                    <p className={`font-bold ${titleClass}`}>{row.name}</p>
                    {row.address && <p className={`mt-0.5 text-[11px] ${mutedClass}`}>{row.address}</p>}
                  </td>
                  <td className={`px-4 py-3 whitespace-nowrap ${titleClass}`}>
                    {WORKSHOP_INSURERS.find(i => i.code === row.insurerCode)?.label ?? row.insurerCode}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                      {WORKSHOP_CATEGORY_LABELS[row.categoryGroup]}
                    </span>
                    {row.sourceCategory && (
                      <p className={`mt-1 text-[11px] ${mutedClass}`}>{row.sourceCategory}</p>
                    )}
                  </td>
                  <td className={`px-4 py-3 ${titleClass}`}>
                    <span className="inline-flex items-start gap-1">
                      <MapPin size={12} className={`mt-0.5 shrink-0 ${mutedClass}`} />
                      <span>
                        {row.city}
                        {row.province && <span className={mutedClass}>, {row.province}</span>}
                      </span>
                    </span>
                  </td>
                  <td className={`px-4 py-3 ${titleClass}`}>{row.brandLabel || '—'}</td>
                  <td className={`px-4 py-3 ${titleClass}`}>
                    {row.phone && <p>{row.phone}</p>}
                    {row.email && <p className={`text-[11px] break-all ${mutedClass}`}>{row.email}</p>}
                    {row.contact && <p className={`text-[11px] ${mutedClass}`}>PIC: {row.contact}</p>}
                    {!row.phone && !row.email && !row.contact && '—'}
                  </td>
                </tr>
              ))}
              {!loading && visibleRows.length === 0 && (
                <tr>
                  <td colSpan={6} className={`px-4 py-10 text-center ${mutedClass}`}>
                    Tidak ada bengkel yang cocok dengan filter ini.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {total > PAGE_SIZE && (
          <div className={`flex items-center justify-between border-t px-4 py-3 text-xs ${cardClass}`}>
            <span className={mutedClass}>
              Halaman {currentPage + 1} dari {pageCount}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                aria-label="Halaman sebelumnya"
                className={`rounded-lg border p-1.5 disabled:opacity-40 ${cardClass} ${titleClass}`}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                aria-label="Halaman berikutnya"
                className={`rounded-lg border p-1.5 disabled:opacity-40 ${cardClass} ${titleClass}`}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkshopDirectory;
