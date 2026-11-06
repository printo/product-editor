'use client';

/**
 * Which size a template is for: the size (the print areas plus their bleed),
 * the way it faces, and the layout it is designed on. Used by Create a
 * template and by Import a design, so the two always offer the same choices.
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { OrientationToggle } from '@/components/ui/OrientationToggle';
import { drawnFacing, layoutsInFacing, type BoxFacing, type SizeGroup } from '@/app/editor/layout/[name]/template-authoring';

const inputClass = 'px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const labelClass = 'flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500';

/** The way a size faces by default: the way its first layout is drawn. */
const defaultFacing = (g: SizeGroup | null): BoxFacing | null => {
  if (!g || g.facings.includes('square')) return null;
  const drawn = g.layouts[0] ? drawnFacing(g.layouts[0]) : null;
  return drawn && g.facings.includes(drawn) ? drawn : g.facings[0] ?? null;
};

export interface TemplateSizePick {
  group: SizeGroup | null;
  /** The way it faces; null for a square size, which gets no toggle. */
  facing: BoxFacing | null;
  layoutName: string;
  layouts: Array<{ layout: SizeGroup['layouts'][number]; turned: boolean }>;
  cannotTurn: number;
  /** `&orientation=…` for the authoring page's address, or nothing. */
  orientationParam: string;
  pickSize: (key: string) => void;
  pickFacing: (facing: BoxFacing) => void;
  pickLayout: (name: string) => void;
  reset: () => void;
}

/** The choice as derived state: it falls back to the first of whatever is on offer. */
export function useTemplateSizePick(sizeGroups: SizeGroup[]): TemplateSizePick {
  const [size, setSize] = useState('');
  const [chosenFacing, setChosenFacing] = useState<BoxFacing | null>(null);
  const [chosenLayout, setChosenLayout] = useState('');

  const group = sizeGroups.find(g => g.key === size) ?? sizeGroups[0] ?? null;
  const facing = !group || group.facings.includes('square')
    ? null
    : chosenFacing && group.facings.includes(chosenFacing) ? chosenFacing : defaultFacing(group);
  const layouts = useMemo(
    () => (group ? (facing ? layoutsInFacing(group, facing) : group.layouts.map(layout => ({ layout, turned: false }))) : []),
    [group, facing],
  );
  const layoutName = layouts.some(l => l.layout.name === chosenLayout) ? chosenLayout : layouts[0]?.layout.name ?? '';

  return {
    group,
    facing,
    layoutName,
    layouts,
    cannotTurn: group && facing ? group.layouts.length - layouts.length : 0,
    orientationParam: facing === 'portrait' || facing === 'landscape' ? `&orientation=${facing}` : '',
    pickSize: key => { setSize(key); setChosenFacing(null); setChosenLayout(''); },
    pickFacing: f => { setChosenFacing(f); setChosenLayout(''); },
    pickLayout: setChosenLayout,
    reset: () => { setSize(''); setChosenFacing(null); setChosenLayout(''); },
  };
}

export function TemplateSizePicker({ idPrefix, sizeGroups, pick, disabled = false }: {
  /** `create-template` gives `create-template-size`, `-facing` and `-layout`. */
  idPrefix: string;
  sizeGroups: SizeGroup[];
  pick: TemplateSizePick;
  disabled?: boolean;
}) {
  const { group, facing, layouts, layoutName, cannotTurn } = pick;
  return (
    <>
      <label className={clsx(labelClass, 'mb-4')}>
        Size
        <select
          id={`${idPrefix}-size`}
          value={group?.key ?? ''}
          disabled={disabled}
          onChange={e => pick.pickSize(e.target.value)}
          className={clsx(inputClass, 'normal-case tracking-normal')}
        >
          {sizeGroups.map(g => (
            <option key={g.key} value={g.key}>
              {g.label} · {g.layouts.length} {g.layouts.length === 1 ? 'layout' : 'layouts'}
            </option>
          ))}
        </select>
      </label>
      {group && !group.facings.includes('square') && (
        <div className={clsx(labelClass, 'mb-4')}>
          <span id={`${idPrefix}-facing`}>Faces</span>
          <OrientationToggle
            value={facing === 'portrait' || facing === 'landscape' ? facing : null}
            onChange={pick.pickFacing}
            size="md"
            title="Which way the template faces: customers see it on orders facing that way"
            disabled={Object.fromEntries((['portrait', 'landscape'] as const)
              .filter(f => !group.facings.includes(f))
              .map(f => [f, `No layout of this size can be shown in ${f}`]))}
          />
          <span className="text-[10px] font-medium normal-case tracking-normal text-slate-400">
            A layout drawn the other way opens turned a quarter turn, as a customer ordering {facing ?? 'it that way'} sees it.
          </span>
        </div>
      )}
      <label className={clsx(labelClass, 'mb-6')}>
        Design it on
        <select
          id={`${idPrefix}-layout`}
          value={layoutName}
          onChange={e => pick.pickLayout(e.target.value)}
          disabled={disabled || !group || layouts.length === 0}
          className={clsx(inputClass, 'normal-case tracking-normal')}
        >
          {layouts.map(({ layout: c, turned }) => (
            <option key={c.name} value={c.name}>
              {c.displayName}{turned ? ' (opens turned)' : ''}{c.templateCount > 0 ? ` (${c.templateCount})` : ''}
            </option>
          ))}
        </select>
        {layouts.length > 1 && (
          <span className="text-[10px] font-medium normal-case tracking-normal text-slate-400">
            Any of these works as the drawing surface; the others are ticked for you on the next page.
          </span>
        )}
        {cannotTurn > 0 && (
          <span className="text-[10px] font-medium normal-case tracking-normal text-amber-700">
            {cannotTurn} {cannotTurn === 1 ? 'layout' : 'layouts'} of this size cannot be turned and will not offer a {facing} template.
          </span>
        )}
      </label>
    </>
  );
}
