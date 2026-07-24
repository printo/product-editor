'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface DropdownOption {
  value: string;
  label: string;
  labelStyle?: React.CSSProperties;
}

interface DropdownProps {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  triggerClassName?: string;
  panelClassName?: string;
  optionClassName?: string;
  disabled?: boolean;
  testId?: string;
}

/** Reusable dropdown that replaces a native <select> wherever the SELECTED
 *  option's highlight needs to match the brand color. A native select's open
 *  option list is rendered by the OS/browser — it ignores CSS for the
 *  highlighted/selected row (always system blue), which is why the plain
 *  Tailwind `indigo-*` override elsewhere in the app can't fix it here. */
export const Dropdown = ({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  triggerClassName = '',
  panelClassName = '',
  optionClassName = 'text-sm',
  disabled = false,
  testId,
}: DropdownProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        data-testid={testId}
        className={`flex items-center justify-between gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${triggerClassName}`}
      >
        <span style={selected?.labelStyle} className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div
          role="listbox"
          className={`absolute left-0 top-full mt-1 max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 ${panelClassName}`}
        >
          {options.map(opt => {
            const isActive = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => { onChange(opt.value); setIsOpen(false); }}
                style={opt.labelStyle}
                className={`w-full text-left px-3 py-2 truncate transition-colors ${optionClassName} ${
                  isActive ? 'bg-indigo-600 text-white' : 'text-slate-700 hover:bg-indigo-50 hover:text-indigo-600'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
