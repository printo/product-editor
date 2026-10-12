'use client';

/**
 * Ops screen for the holiday files calendars print (`HolidaysView`).
 *
 * One locale + year at a time. Edits stay in the browser until Save, which
 * PUTs the whole year — the endpoint replaces the file, it has no per-entry
 * write. Reads go through the public `holidays/` route, writes through
 * `ops/holidays/`; the internal proxy gates those writes to the Ops tier, and
 * this screen hides its write controls by the same rule (`lib/roles.ts`).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  ArrowLeft,
  CalendarDays,
  Edit2,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import { Dropdown, type DropdownOption } from '@/components/ui/Dropdown';
import { Toast, ToastStack, type ToastTone } from '@/components/ui/Toast';
import { useHeader } from '@/context/HeaderContext';
import { resolveDefaultYear } from '@/lib/calendar';
import { canManageTemplates } from '@/lib/roles';
import { useModalA11y } from '@/lib/use-modal-a11y';
import type { HolidayEntry } from '@/types/calendar';
import {
  EMPTY_FIELDS,
  HOLIDAY_LOCALES,
  HOLIDAY_TYPES,
  MAX_HOLIDAY_NAME,
  entryToFields,
  fieldsToEntry,
  formatHolidayDate,
  isSafeLocale,
  sortHolidays,
  toEntries,
  validateHoliday,
  type HolidayErrors,
  type HolidayFields,
  type HolidayRow,
} from './holiday-utils';

type Loaded =
  | { key: string; status: 'ready'; exists: boolean }
  | { key: string; status: 'error'; error: string };

type FormMode = { kind: 'add' } | { kind: 'edit'; id: string };

type Confirm =
  | { kind: 'switch'; locale: string; year: number }
  | { kind: 'clear' };

/** Only the fields that print, so a stored key ops can't see never reads as an edit. */
function comparable(list: HolidayEntry[]): string {
  return JSON.stringify(
    sortHolidays(list).map((h) => [h.date, h.name, h.type || '', h.color || '']),
  );
}

async function errorDetail(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  const detail = (body as { detail?: unknown } | null)?.detail;
  return typeof detail === 'string' && detail ? detail : `${fallback} (HTTP ${res.status}).`;
}

const inputClass =
  'w-full rounded-lg border px-3 py-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500';
const dropdownTrigger =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900';

export function HolidayManager() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();

  const canEdit = canManageTemplates({
    is_staff: session?.is_staff,
    is_ops_team: session?.is_ops_team,
  });

  // The year the print would use for an English calendar today, in IST.
  const [currentYear] = useState(() => resolveDefaultYear('current', 'english'));

  const [locale, setLocale] = useState(() => {
    const q = searchParams.get('locale');
    return q && isSafeLocale(q) ? q : 'en-IN';
  });
  const [year, setYear] = useState(() => {
    const q = Number(searchParams.get('year'));
    return Number.isInteger(q) && q >= 1900 && q <= 2100 ? q : currentYear;
  });
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadKey = `${locale}|${year}|${reloadNonce}`;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fileMeta, setFileMeta] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState<HolidayEntry[]>([]);
  const [rows, setRows] = useState<HolidayRow[]>([]);
  const nextId = useRef(0);

  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [fields, setFields] = useState<HolidayFields>(EMPTY_FIELDS);
  const [errors, setErrors] = useState<HolidayErrors>({});

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);

  useEffect(() => {
    setTitle('Holidays');
    setDescription('Holidays printed on calendars');
    setCenterActions(null);
    setRightActions(
      <Link
        href="/editor/layouts"
        aria-label="Back to Templates"
        className="flex items-center gap-1.5 p-2.5 md:px-3 md:py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-full md:rounded border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="hidden md:inline">Templates</span>
      </Link>,
    );
    return () => {
      setTitle('');
      setDescription('');
      setCenterActions(null);
      setRightActions(null);
    };
  }, [setTitle, setDescription, setCenterActions, setRightActions]);

  const toRows = useCallback(
    (list: HolidayEntry[]): HolidayRow[] =>
      sortHolidays(list).map((h) => ({ ...h, id: `h${nextId.current++}` })),
    [],
  );

  const applyFile = useCallback(
    (meta: Record<string, unknown>, events: HolidayEntry[]) => {
      setFileMeta(meta);
      setSaved(events);
      setRows(toRows(events));
      setFormMode(null);
      setErrors({});
    },
    [toRows],
  );

  useEffect(() => {
    let cancelled = false;
    const key = `${locale}|${year}|${reloadNonce}`;
    async function load() {
      try {
        // no-store: the read route is cached for a day, so a reload right
        // after a save would otherwise show the old list.
        const res = await fetch(
          `/api/internal/proxy/holidays/${encodeURIComponent(locale)}/${year}`,
          { cache: 'no-store' },
        );
        if (cancelled) return;
        if (res.status === 404) {
          applyFile({}, []);
          setLoaded({ key, status: 'ready', exists: false });
          return;
        }
        if (!res.ok) {
          const error = await errorDetail(res, 'Could not load holidays');
          if (!cancelled) setLoaded({ key, status: 'error', error });
          return;
        }
        const body = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        const { events, ...meta } = body;
        applyFile(meta, Array.isArray(events) ? (events as HolidayEntry[]) : []);
        setLoaded({ key, status: 'ready', exists: true });
      } catch (e) {
        if (!cancelled) {
          setLoaded({
            key,
            status: 'error',
            error: e instanceof Error ? e.message : 'Could not load holidays.',
          });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [locale, year, reloadNonce, applyFile]);

  const isLoading = loaded?.key !== loadKey;
  const entries = useMemo(() => toEntries(rows), [rows]);
  const dirty = !isLoading && comparable(entries) !== comparable(saved);

  // Leaving the page with unsaved edits — the browser's own prompt is the only
  // one that can stop a tab close.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const switchTo = (nextLocale: string, nextYear: number) => {
    setLocale(nextLocale);
    setYear(nextYear);
    setFormMode(null);
  };

  const requestSwitch = (nextLocale: string, nextYear: number) => {
    if (nextLocale === locale && nextYear === year) return;
    if (dirty) setConfirm({ kind: 'switch', locale: nextLocale, year: nextYear });
    else switchTo(nextLocale, nextYear);
  };

  const openAdd = () => {
    setFormMode({ kind: 'add' });
    setFields({ ...EMPTY_FIELDS, date: `${year}-01-01` });
    setErrors({});
  };

  const openEdit = (row: HolidayRow) => {
    setFormMode({ kind: 'edit', id: row.id });
    setFields(entryToFields(row));
    setErrors({});
  };

  const closeForm = () => {
    setFormMode(null);
    setErrors({});
  };

  const submitForm = () => {
    if (!formMode) return;
    const editingId = formMode.kind === 'edit' ? formMode.id : null;
    const others = rows.filter((r) => r.id !== editingId);
    const found = validateHoliday(fields, year, others);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const entry = fieldsToEntry(fields);
    if (editingId) {
      setRows((prev) =>
        sortHolidays(
          prev.map((r) => {
            if (r.id !== editingId) return r;
            // Keep any stored keys this screen doesn't edit; type and colour
            // are dropped first so clearing them here actually clears them.
            const { type: _type, color: _color, ...rest } = r;
            return { ...rest, ...entry, id: r.id };
          }),
        ),
      );
    } else {
      setRows((prev) => sortHolidays([...prev, { ...entry, id: `h${nextId.current++}` }]));
    }
    closeForm();
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (formMode?.kind === 'edit' && formMode.id === id) closeForm();
  };

  const discard = () => {
    setRows(toRows(saved));
    closeForm();
  };

  const save = async () => {
    setBusy('save');
    try {
      const res = await fetch(
        `/api/internal/proxy/ops/holidays/${encodeURIComponent(locale)}/${year}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...fileMeta, events: entries }),
        },
      );
      if (!res.ok) {
        setToast({ message: await errorDetail(res, 'Save failed'), tone: 'error' });
        return;
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const { events, ...meta } = body ?? {};
      applyFile(meta, Array.isArray(events) ? (events as HolidayEntry[]) : entries);
      setLoaded({ key: loadKey, status: 'ready', exists: true });
      setToast({ message: 'Holidays saved', tone: 'success' });
    } catch (e) {
      setToast({
        message: e instanceof Error ? e.message : 'Save failed.',
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  };

  const clearYear = async () => {
    setConfirm(null);
    setBusy('clear');
    try {
      const res = await fetch(
        `/api/internal/proxy/ops/holidays/${encodeURIComponent(locale)}/${year}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        setToast({ message: await errorDetail(res, 'Could not clear the year'), tone: 'error' });
        return;
      }
      applyFile({}, []);
      setLoaded({ key: loadKey, status: 'ready', exists: false });
      setToast({ message: `Cleared ${locale} ${year}`, tone: 'success' });
    } catch (e) {
      setToast({
        message: e instanceof Error ? e.message : 'Could not clear the year.',
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  };

  const localeOptions: DropdownOption[] = useMemo(() => {
    const known = HOLIDAY_LOCALES.some((l) => l.value === locale);
    return known ? HOLIDAY_LOCALES : [...HOLIDAY_LOCALES, { value: locale, label: locale }];
  }, [locale]);

  const yearOptions: DropdownOption[] = useMemo(() => {
    const years = new Set<number>();
    for (let y = currentYear - 1; y <= currentYear + 5; y++) years.add(y);
    years.add(year);
    return [...years].sort((a, b) => a - b).map((y) => ({ value: String(y), label: String(y) }));
  }, [currentYear, year]);

  const typeOptions: DropdownOption[] = useMemo(() => {
    const opts: DropdownOption[] = [
      { value: '', label: 'None' },
      ...HOLIDAY_TYPES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) })),
    ];
    if (fields.type && !opts.some((o) => o.value === fields.type)) {
      opts.push({ value: fields.type, label: fields.type });
    }
    return opts;
  }, [fields.type]);

  const exists = loaded?.status === 'ready' && loaded.exists;
  const editingId = formMode?.kind === 'edit' ? formMode.id : null;

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-5">
      <ToastStack>
        <Toast message={toast?.message ?? null} tone={toast?.tone ?? 'success'} onDismiss={() => setToast(null)} />
      </ToastStack>

      {!canEdit && (
        <div
          data-testid="holidays-read-only"
          className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
        >
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <p>You can view holidays here. Changing them needs the Operations Team role — ask an admin if you need it.</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex gap-3">
          <div className="flex flex-col gap-1 w-48">
            <span className="text-xs font-semibold text-slate-600">Locale</span>
            <Dropdown
              value={locale}
              onChange={(v) => requestSwitch(v, year)}
              options={localeOptions}
              triggerClassName={dropdownTrigger}
              panelClassName="w-full"
              testId="holiday-locale-picker"
            />
          </div>
          <div className="flex flex-col gap-1 w-28">
            <span className="text-xs font-semibold text-slate-600">Year</span>
            <Dropdown
              value={String(year)}
              onChange={(v) => requestSwitch(locale, Number(v))}
              options={yearOptions}
              triggerClassName={dropdownTrigger}
              panelClassName="w-full"
              testId="holiday-year-picker"
            />
          </div>
        </div>
        <p className="text-xs text-slate-500 sm:pb-2.5 sm:ml-2">
          Calendars that auto-load holidays for this locale print this list on the next render.
        </p>
      </div>

      {canEdit && !isLoading && loaded?.status === 'ready' && (
        <div className="flex flex-wrap items-center gap-2" data-testid="holiday-actions">
          {dirty ? (
            <span data-testid="unsaved-badge" className="px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold">
              Unsaved changes
            </span>
          ) : (
            <span className="text-xs text-slate-500">
              {exists ? 'All changes saved' : 'Nothing saved for this year'}
            </span>
          )}
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <button
              type="button"
              onClick={openAdd}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm font-semibold hover:bg-indigo-100"
            >
              <Plus className="w-4 h-4" /> Add holiday
            </button>
            {dirty && (
              <button
                type="button"
                onClick={discard}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm font-semibold hover:border-slate-300 disabled:opacity-50"
              >
                <RotateCcw className="w-4 h-4" /> Discard changes
              </button>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!dirty || busy !== null}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save changes
            </button>
            {exists && (
              <button
                type="button"
                onClick={() => setConfirm({ kind: 'clear' })}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 bg-white text-red-600 text-sm font-semibold hover:bg-red-50 disabled:opacity-50"
              >
                {busy === 'clear' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Clear year
              </button>
            )}
          </div>
        </div>
      )}

      {canEdit && formMode && (
        <HolidayForm
          mode={formMode.kind}
          year={year}
          fields={fields}
          errors={errors}
          typeOptions={typeOptions}
          onChange={(patch) => setFields((f) => ({ ...f, ...patch }))}
          onSubmit={submitForm}
          onCancel={closeForm}
        />
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-12 justify-center text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading holidays…
        </div>
      ) : loaded?.status === 'error' ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{loaded.error}</p>
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="mt-2 font-semibold underline"
          >
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="holidays-empty" className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <CalendarDays className="w-8 h-8 mx-auto text-slate-300" />
          <p className="mt-3 text-sm font-semibold text-slate-800">
            {exists || dirty ? `The ${locale} ${year} list is empty` : `No holidays for ${locale} ${year} yet`}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {dirty
              ? 'Save to print no holidays this year, or discard to bring the list back.'
              : 'Calendars for this year print without auto-loaded holidays.'}
          </p>
          {canEdit && !formMode && (
            <button
              type="button"
              onClick={openAdd}
              className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
            >
              <Plus className="w-4 h-4" /> Add holiday
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm" data-testid="holidays-table">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold text-slate-500">
                <th scope="col" className="px-4 py-2.5">Date</th>
                <th scope="col" className="px-4 py-2.5">Name</th>
                <th scope="col" className="px-4 py-2.5">Type</th>
                <th scope="col" className="px-4 py-2.5">Colour</th>
                {canEdit && <th scope="col" className="px-4 py-2.5 text-right"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid="holiday-row"
                  className={`border-b border-slate-100 last:border-0 ${editingId === row.id ? 'bg-indigo-50' : ''}`}
                >
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-700">
                    <time dateTime={row.date}>{formatHolidayDate(row.date)}</time>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-slate-900">{row.name}</td>
                  <td className="px-4 py-2.5 text-slate-600 capitalize">{row.type || '—'}</td>
                  <td className="px-4 py-2.5">
                    {row.color ? (
                      <span className="inline-flex items-center gap-2 text-xs text-slate-600">
                        <span className="w-3.5 h-3.5 rounded-full border border-black/10" style={{ backgroundColor: row.color }} />
                        {row.color}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">Default</span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openEdit(row)}
                        aria-label={`Edit ${row.name}`}
                        className="p-2 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        aria-label={`Delete ${row.name}`}
                        className="p-2 rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirm?.kind === 'switch' && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message={`Your changes to ${locale} ${year} aren't saved. Switching to ${confirm.locale} ${confirm.year} throws them away.`}
          confirmLabel="Discard and switch"
          onConfirm={() => {
            setConfirm(null);
            switchTo(confirm.locale, confirm.year);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'clear' && (
        <ConfirmDialog
          title={`Clear ${locale} ${year}?`}
          message={`Every holiday for ${locale} ${year} is deleted and calendars for that year print without them. The bundled list does not come back — you can add holidays again afterwards.`}
          confirmLabel="Clear year"
          onConfirm={clearYear}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function HolidayForm({
  mode,
  year,
  fields,
  errors,
  typeOptions,
  onChange,
  onSubmit,
  onCancel,
}: {
  mode: 'add' | 'edit';
  year: number;
  fields: HolidayFields;
  errors: HolidayErrors;
  typeOptions: DropdownOption[];
  onChange: (patch: Partial<HolidayFields>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const field = (name: keyof HolidayFields) => `${ids}-${name}`;
  const border = (name: keyof HolidayFields) => (errors[name] ? 'border-red-400' : 'border-slate-300');
  const swatch = /^#[0-9A-Fa-f]{6}$/.test(fields.color) ? fields.color : '#64318E';

  return (
    <form
      data-testid="holiday-form"
      aria-label={mode === 'add' ? 'Add holiday' : 'Edit holiday'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="rounded-2xl border border-indigo-200 bg-white p-4 md:p-5 space-y-4"
    >
      <h2 className="text-sm font-bold text-slate-900">{mode === 'add' ? 'Add holiday' : 'Edit holiday'}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={field('date')} className="text-xs font-semibold text-slate-600">Date</label>
          <input
            id={field('date')}
            type="date"
            min={`${year}-01-01`}
            max={`${year}-12-31`}
            value={fields.date}
            onChange={(e) => onChange({ date: e.target.value })}
            aria-invalid={!!errors.date}
            aria-describedby={errors.date ? `${field('date')}-error` : undefined}
            className={`${inputClass} ${border('date')}`}
          />
          {errors.date && <p id={`${field('date')}-error`} className="text-xs text-red-600">{errors.date}</p>}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={field('name')} className="text-xs font-semibold text-slate-600">Name</label>
          <input
            id={field('name')}
            type="text"
            value={fields.name}
            placeholder="e.g. Republic Day"
            onChange={(e) => onChange({ name: e.target.value })}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? `${field('name')}-error` : undefined}
            className={`${inputClass} ${border('name')}`}
          />
          {errors.name ? (
            <p id={`${field('name')}-error`} className="text-xs text-red-600">{errors.name}</p>
          ) : (
            <p className="text-xs text-slate-400">{fields.name.trim().length}/{MAX_HOLIDAY_NAME}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-slate-600">Type</span>
          <Dropdown
            value={fields.type}
            onChange={(v) => onChange({ type: v })}
            options={typeOptions}
            triggerClassName={dropdownTrigger}
            panelClassName="w-full"
            testId="holiday-type"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={field('color')} className="text-xs font-semibold text-slate-600">Colour <span className="font-normal text-slate-400">(optional)</span></label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={swatch}
              onChange={(e) => onChange({ color: e.target.value.toUpperCase() })}
              aria-label="Pick a colour"
              className="h-9 w-10 shrink-0 rounded border border-slate-300 bg-white p-0.5 cursor-pointer"
            />
            <input
              id={field('color')}
              type="text"
              value={fields.color}
              placeholder="Default"
              onChange={(e) => onChange({ color: e.target.value })}
              aria-invalid={!!errors.color}
              aria-describedby={errors.color ? `${field('color')}-error` : undefined}
              className={`${inputClass} ${border('color')} min-w-0`}
            />
          </div>
          {errors.color && <p id={`${field('color')}-error`} className="text-xs text-red-600">{errors.color}</p>}
          {fields.color && !errors.color && (
            <button type="button" onClick={() => onChange({ color: '' })} className="self-start text-xs text-slate-500 underline">
              Use the default colour
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700">
          {mode === 'add' ? 'Add to list' : 'Update'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-semibold hover:border-slate-300">
          Cancel
        </button>
        <p className="text-xs text-slate-500 self-center">Changes are kept here until you press Save changes.</p>
      </div>
    </form>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalA11y(dialogRef, onCancel, true, cancelRef);
  const titleId = useId();
  const messageId = useId();
  return (
    <div className="fixed inset-0 z-[2001] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6"
      >
        <p id={titleId} className="text-sm font-bold text-slate-900 mb-2">{title}</p>
        <p id={messageId} className="text-xs text-slate-600 leading-relaxed mb-5">{message}</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 py-2.5 text-sm font-semibold bg-red-500 text-white rounded-xl hover:bg-red-600"
          >
            {confirmLabel}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 text-sm font-semibold bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
