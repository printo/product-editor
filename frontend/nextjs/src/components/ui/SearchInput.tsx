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
    <div className={`relative w-[175px] shrink-0 md:w-full md:shrink md:max-w-[640px] max-w-[640px] md:max-w-[900px] group ${className}`}>
      <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-slate-600 transition-colors" />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-100 rounded-lg focus:outline-none focus:ring-1 focus:ring-slate-200 focus:bg-white transition-all text-xs md:text-[13px] font-medium placeholder:text-slate-400"
      />
    </div>
  );
};
