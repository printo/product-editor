'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';

export interface SegmentedNavItem {
  href: string;
  label: string;
  active: boolean;
}

interface SegmentedNavProps {
  items: SegmentedNavItem[];
}

/** Reusable pill-style segmented toggle nav — e.g. Header's Dashboard/Templates switch.
 *  The active background slides (spring physics) between items instead of snapping. */
export const SegmentedNav = ({ items }: SegmentedNavProps) => {
  const activeIndex = items.findIndex((item) => item.active);

  return (
    <nav className="flex items-center bg-slate-100/80 p-1 rounded-xl border border-slate-200/40 shrink-0 shadow-inner overflow-hidden">
      {/* Positioning context for the pill is this padding-free wrapper, not `nav` itself —
          `nav`'s own p-1 padding sits outside a positioned descendant's containing block
          (percentages resolve against the padding box), so calc-ing left/width against
          `nav` directly drifted the pill by exactly that padding on one side only. */}
      <div className="relative flex items-center w-full">
        {activeIndex >= 0 && (
          <motion.div
            className="absolute inset-y-0 rounded-lg bg-gradient-to-r from-[#64318E] to-[#F17A26] shadow-md"
            initial={false}
            animate={{
              left: `${(activeIndex / items.length) * 100}%`,
              width: `${100 / items.length}%`,
            }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          />
        )}
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`relative z-10 flex-1 px-2 md:px-5 py-1.5 md:py-2.5 rounded-lg text-[9px] md:text-[13px] font-black uppercase tracking-tight md:tracking-wider transition-colors duration-300 min-w-[58px] md:min-w-[100px] text-center whitespace-nowrap ${
              item.active ? 'text-white' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
};
