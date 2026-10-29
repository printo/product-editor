'use client';

/**
 * Ops screen for the layout tag list (`/api/layout-tags`).
 *
 * Create a tag (name plus a fixed key), rename it, switch it off or back on.
 * There is no delete: a switched-off tag stays on the layouts that carry it.
 * Writes go to `ops/layout-tags`, which the internal proxy gates to the Ops
 * tier; this screen hides its write controls by the same rule.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { ArrowLeft, Check, Edit2, Loader2, Lock, Plus, X } from 'lucide-react';
import { Toast, ToastStack, type ToastTone } from '@/components/ui/Toast';
import { useHeader } from '@/context/HeaderContext';
import { canManageTemplates } from '@/lib/roles';
import {
  TAG_KEY_MAX,
  TAG_NAME_MAX,
  isTagKey,
  keyForName,
  useLayoutTags,
  type LayoutTagInfo,
} from '@/lib/layout-tags';

async function errorDetail(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  const detail = (body as { detail?: unknown } | null)?.detail;
  return typeof detail === 'string' && detail ? detail : `${fallback} (HTTP ${res.status}).`;
}

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

export function TagManager() {
  const { data: session, status } = useSession();
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();
  const { tags, error: loadError, loading, reload } = useLayoutTags(status === 'authenticated');

  const canEdit = canManageTemplates({
    is_staff: session?.is_staff,
    is_ops_team: session?.is_ops_team,
  });

  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  // The key follows the name until someone types a key of their own.
  const [keyTouched, setKeyTouched] = useState(false);
  const [editing, setEditing] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);

  useEffect(() => {
    setTitle('Tags');
    setDescription('Tags ops can put on layouts');
    setCenterActions(null);
    setRightActions(
      <Link
        href="/editor/layouts"
        aria-label="Back to Layouts"
        className="flex items-center gap-1.5 p-2.5 md:px-3 md:py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-full md:rounded border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="hidden md:inline">Layouts</span>
      </Link>,
    );
    return () => {
      setTitle('');
      setDescription('');
      setCenterActions(null);
      setRightActions(null);
    };
  }, [setTitle, setDescription, setCenterActions, setRightActions]);

  const key = keyTouched ? newKey : keyForName(newName);
  const nameTaken = tags.some(t => t.name.toLowerCase() === newName.trim().toLowerCase());
  const keyTaken = tags.some(t => t.key === key);
  const createError = !newName.trim()
    ? null
    : nameTaken
      ? 'A tag with this name already exists.'
      : !isTagKey(key)
        ? 'Key: lowercase letters, digits and single underscores, e.g. photo_prints.'
        : keyTaken
          ? 'This key is already used.'
          : null;

  const create = async () => {
    if (!newName.trim() || createError) return;
    setBusy('create');
    try {
      const res = await fetch('/api/internal/proxy/ops/layout-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, name: newName.trim() }),
      });
      if (!res.ok) throw new Error(await errorDetail(res, 'Could not create the tag'));
      setToast({ message: `Created “${newName.trim()}” (${key}).`, tone: 'success' });
      setNewName('');
      setNewKey('');
      setKeyTouched(false);
      reload();
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'Could not create the tag.', tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const update = async (tag: LayoutTagInfo, body: { name?: string; isActive?: boolean }, done: string) => {
    setBusy(tag.key);
    try {
      const res = await fetch(`/api/internal/proxy/ops/layout-tags/${encodeURIComponent(tag.key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorDetail(res, 'Could not update the tag'));
      setToast({ message: done, tone: 'success' });
      setEditing(null);
      reload();
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'Could not update the tag.', tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const sorted = [...tags].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 space-y-5">
      <ToastStack>
        <Toast message={toast?.message ?? null} tone={toast?.tone ?? 'success'} onDismiss={() => setToast(null)} />
      </ToastStack>

      {!canEdit && status === 'authenticated' && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <p>You can view tags here. Creating or changing them needs the Operations Team role — ask an admin if you need it.</p>
        </div>
      )}

      <p className="text-sm text-slate-600">
        A layout can carry several tags. Each tag has a <strong>key</strong> that never changes, which is what
        layouts store and what other systems look layouts up by, and a <strong>name</strong> people see, which you
        can rename at any time. Tags are switched off rather than deleted, so no layout loses one.
      </p>

      {canEdit && (
        <form
          onSubmit={e => { e.preventDefault(); create(); }}
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm space-y-3"
        >
          <h2 className="text-xs font-bold text-indigo-600 uppercase tracking-wider">New tag</h2>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
            <label className="text-xs font-semibold text-slate-600 space-y-1">
              <span>Name</span>
              <input
                className={inputClass}
                value={newName}
                maxLength={TAG_NAME_MAX}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Wedding"
                data-testid="new-tag-name"
              />
            </label>
            <label className="text-xs font-semibold text-slate-600 space-y-1">
              <span>Key (fixed once created)</span>
              <input
                className={`${inputClass} font-mono`}
                value={key}
                maxLength={TAG_KEY_MAX}
                onChange={e => { setKeyTouched(true); setNewKey(e.target.value.toLowerCase()); }}
                placeholder="e.g. wedding"
                data-testid="new-tag-key"
              />
            </label>
            <button
              type="submit"
              disabled={!newName.trim() || !!createError || busy === 'create'}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create
            </button>
          </div>
          {createError && <p className="text-xs text-rose-600">{createError}</p>}
        </form>
      )}

      {loadError && <p className="text-sm text-rose-600">{loadError}</p>}

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-4 py-2.5">Name</th>
              <th className="text-left px-4 py-2.5">Key</th>
              <th className="text-right px-4 py-2.5">Layouts</th>
              <th className="text-left px-4 py-2.5">Status</th>
              {canEdit && <th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map(tag => {
              const isEditing = editing?.key === tag.key;
              return (
                <tr key={tag.key} className={tag.isActive ? '' : 'text-slate-400'}>
                  <td className="px-4 py-2.5 font-semibold">
                    {isEditing ? (
                      <form
                        className="flex items-center gap-1.5"
                        onSubmit={e => {
                          e.preventDefault();
                          const name = editing.name.trim();
                          if (name && name !== tag.name) update(tag, { name }, `Renamed to “${name}”.`);
                          else setEditing(null);
                        }}
                      >
                        <input
                          autoFocus
                          aria-label={`New name for ${tag.name}`}
                          className={`${inputClass} py-1`}
                          value={editing.name}
                          maxLength={TAG_NAME_MAX}
                          onChange={e => setEditing({ key: tag.key, name: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Escape') setEditing(null); }}
                        />
                        <button type="submit" aria-label="Save name" className="p-1.5 rounded text-indigo-600 hover:bg-indigo-50">
                          <Check className="w-4 h-4" />
                        </button>
                        <button type="button" aria-label="Cancel rename" onClick={() => setEditing(null)} className="p-1.5 rounded text-slate-400 hover:bg-slate-100">
                          <X className="w-4 h-4" />
                        </button>
                      </form>
                    ) : (
                      tag.name
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{tag.key}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{tag.layoutCount}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${tag.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {tag.isActive ? 'On' : 'Off'}
                    </span>
                  </td>
                  {canEdit && (
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {!isEditing && (
                          <button
                            type="button"
                            aria-label={`Rename ${tag.name}`}
                            onClick={() => setEditing({ key: tag.key, name: tag.name })}
                            className="p-1.5 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy === tag.key}
                          onClick={() => update(
                            tag,
                            { isActive: !tag.isActive },
                            tag.isActive ? `Switched off “${tag.name}”.` : `Switched on “${tag.name}”.`,
                          )}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:border-indigo-400 hover:text-indigo-600 disabled:opacity-50"
                        >
                          {tag.isActive ? 'Switch off' : 'Switch on'}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {sorted.length === 0 && !loadError && (
              <tr>
                <td colSpan={canEdit ? 5 : 4} className="px-4 py-6 text-center text-slate-400">
                  {loading ? 'Loading…' : 'No tags yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
