import Link from 'next/link';

/** Reusable site brand mark — logo + wordmark, links home to the dashboard. */
export const HeaderBrand = () => {
  return (
    <Link href="/dashboard" className="flex items-center gap-3 shrink-0 group transition-opacity hover:opacity-80">
      <div className="w-9 h-9 md:w-10 md:h-10 rounded-lg overflow-hidden group-hover:scale-105 transition-transform shadow-[0_1px_1px_rgba(0,0,0,0.05)] shrink-0">
        <img src="/favicon.png" alt="Logo" className="w-full h-full object-cover" />
      </div>
      <h1 className="text-[13px] md:text-sm font-black text-slate-900 uppercase tracking-tight whitespace-nowrap">
        Product Editor
      </h1>
    </Link>
  );
};
