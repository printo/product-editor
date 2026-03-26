import React from 'react';
import { Search } from 'lucide-react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export const SearchInput = ({ value, onChange, placeholder = "Search...", className = "" }: SearchInputProps) => {
  return (
    <div className={`relative w-full max-w-[400px] group ${className}`}>
      <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 group-focus-within:text-slate-600 transition-colors" />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full pl-10 pr-4 py-1.5 bg-slate-50 border border-slate-100 rounded-lg focus:outline-none focus:ring-1 focus:ring-slate-200 focus:bg-white transition-all text-[11px] font-medium placeholder:text-slate-400"
      />
    </div>
  );
};
