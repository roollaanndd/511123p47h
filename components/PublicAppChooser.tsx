import React from 'react';
import { ArrowRight, BriefcaseBusiness, Building2, ShieldCheck, UserRound } from 'lucide-react';

type AppChoice = {
  href: string;
  title: string;
  description: string;
  Icon: React.FC<{ size?: number }>;
};

const CHOICES: AppChoice[] = [
  { href: '/custapp', title: 'Nasabah', description: 'Beli polis, ajukan klaim, dan pantau perlindungan.', Icon: UserRound },
  { href: '/agapps', title: 'Mitra', description: 'Kelola nasabah, buat penawaran, dan pantau komisi.', Icon: BriefcaseBusiness },
  { href: '/operatorapp', title: 'Operator', description: 'Kelola verifikasi, klaim, dan antrean layanan.', Icon: ShieldCheck },
  { href: '/admin', title: 'Admin', description: 'Kelola produk, pengguna, dan operasional platform.', Icon: Building2 },
];

const PublicAppChooser: React.FC = () => (
  <main className="min-h-screen bg-ds-bg px-5 py-12 font-sora text-ds-ink">
    <div className="mx-auto flex w-full max-w-lg flex-col items-center">
      <img src="/logo-sm.png" width={72} height={72} alt="SurePath" className="mb-5 object-contain" />
      <p className="text-2xs font-bold uppercase tracking-[0.22em] text-ds-green">SurePath</p>
      <h1 className="mt-2 text-center text-2xl font-black tracking-tight sm:text-3xl">Pilih aplikasi untuk masuk</h1>
      <p className="mt-3 max-w-md text-center text-sm leading-relaxed text-ds-ink3">
        Pilihan ini menentukan ruang kerja dan aplikasi yang akan kamu pasang. Akses tetap diverifikasi setelah login.
      </p>

      <div className="mt-8 grid w-full gap-3 sm:grid-cols-2">
        {CHOICES.map(({ href, title, description, Icon }) => (
          <a
            key={href}
            href={href}
            className="group flex min-h-[132px] flex-col justify-between rounded-2xl border border-ds-border bg-ds-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-400 hover:shadow-ds-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <span className="flex items-start justify-between gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-ds-green">
                <Icon size={22} />
              </span>
              <ArrowRight size={18} className="text-ds-ink3 transition group-hover:translate-x-1 group-hover:text-ds-green" />
            </span>
            <span>
              <span className="block text-sm font-black text-ds-ink">{title}</span>
              <span className="mt-1 block text-xs leading-relaxed text-ds-ink3">{description}</span>
            </span>
          </a>
        ))}
      </div>

      <a href="/" className="mt-8 text-xs font-bold text-ds-ink3 underline-offset-4 hover:text-ds-green hover:underline">Kembali ke website</a>
    </div>
  </main>
);

export default PublicAppChooser;
