import { LogOut } from 'lucide-react';

interface HeaderUserMenuProps {
  name?: string | null;
  roleLabel: string;
  /** When set, the role badge is a link (administrators: the Django admin). */
  roleHref?: string;
  onSignOut: () => void;
}

/** Reusable user identity + sign-out control for the app header. */
export const HeaderUserMenu = ({ name, roleLabel, roleHref, onSignOut }: HeaderUserMenuProps) => {
  const badgeClass = 'text-[10px] md:text-[11px] text-slate-600 font-bold uppercase tracking-widest mt-0.5';
  return (
    <div className="flex items-center gap-3 pl-3 shrink-0">
      <div className="hidden lg:flex flex-col items-end whitespace-nowrap overflow-hidden">
        <span className="text-xs md:text-[13px] font-black text-slate-900 leading-none">
          {name || 'User'}
        </span>
        {roleHref ? (
          // A plain <a>, not next/link: /django-admin/ is served by nginx
          // straight to Django and is not a Next.js route, so client-side
          // navigation would 404 against the app router.
          <a
            href={roleHref}
            title="Open the Django admin console"
            className={`${badgeClass} underline decoration-slate-400 underline-offset-2 hover:text-indigo-700 hover:decoration-indigo-700 transition-colors`}
          >
            {roleLabel}
          </a>
        ) : (
          <span className={badgeClass}>
            {roleLabel}
          </span>
        )}
      </div>
      <button
        onClick={onSignOut}
        className="p-1.5 px-2.5 text-rose-500 hover:bg-rose-50 rounded-md border border-transparent hover:border-rose-100 transition-all hover:scale-105 active:scale-95 shrink-0"
        title="Sign Out"
      >
        <LogOut className="w-4 h-4" />
      </button>
    </div>
  );
};
