'use client';

import { clsx } from 'clsx';
import { AlertTriangle, ChevronRight, Download, FileText, Loader2, X } from 'lucide-react';
import { CROP_MARK_LEN_MAX_MM, CROP_MARK_LEN_MIN_MM, MM_TO_IN } from './imposition';
import type { Imposition } from './useImposition';

/** The imposition (print sheet) modal: sheet preview on the left, print
 *  settings and the download on the right. */
export function ImpositionModal({ imposition }: { imposition: Imposition }) {
  const {
    setShowImpositionModal, sheetCount, previewSheetIdx, setPreviewSheetIdx, impositionPreviewBoxRef,
    impositionPreviewRef, impositionResult, impositionSettings, setImpositionSettings, impositionPlacedTotal,
    impositionSheetLabel, executeImposition, isImposing,
  } = imposition;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setShowImpositionModal(false)} />
      <div className="relative w-full max-w-3xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row max-h-[85vh] border border-slate-200">
        {/* Left: Preview */}
        <div className="flex-[1.1] bg-slate-50 p-6 pt-16 flex flex-col items-center relative border-r border-slate-200">
          <div className="absolute top-5 left-6">
            <h3 className="text-sm font-semibold text-slate-900">Sheet preview</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {sheetCount === 0
                ? 'Nothing fits on this sheet'
                : `Sheet ${Math.min(previewSheetIdx + 1, sheetCount)} of ${sheetCount}`}
            </p>
          </div>

          {/* The canvas is sized from this box, measured at runtime. It
              is positioned ABSOLUTELY so it never contributes to the
              box's own size — otherwise resizing the canvas resizes the
              box that determines the canvas size, and the two oscillate
              forever without the scene ever finishing a render. */}
          <div ref={impositionPreviewBoxRef} className="relative flex-1 w-full min-h-[220px] overflow-hidden">
            {sheetCount === 0 ? (
              <p className="absolute inset-0 flex items-center justify-center text-xs text-slate-400 text-center px-4">
                {impositionResult.noUsableArea
                  ? 'The margin leaves no printable area on this sheet.'
                  : 'No canvas fits inside this sheet size.'}
              </p>
            ) : (
              <canvas
                ref={impositionPreviewRef}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded shadow-sm border border-slate-200 bg-white"
              />
            )}
          </div>

          {sheetCount > 1 && (
            <div className="mt-4 flex items-center gap-1 bg-white border border-slate-200 rounded-full p-1 shadow-sm">
              <button
                aria-label="Previous sheet"
                disabled={previewSheetIdx === 0}
                onClick={() => setPreviewSheetIdx(p => Math.max(0, p - 1))}
                className="p-1.5 text-slate-500 hover:text-indigo-600 disabled:opacity-30 transition rounded-full hover:bg-slate-50"
              >
                <ChevronRight className="w-4 h-4 rotate-180" />
              </button>
              <span className="text-xs font-medium text-slate-700 min-w-[70px] text-center">
                {previewSheetIdx + 1} / {sheetCount}
              </span>
              <button
                aria-label="Next sheet"
                disabled={previewSheetIdx >= sheetCount - 1}
                onClick={() => setPreviewSheetIdx(p => Math.min(sheetCount - 1, p + 1))}
                className="p-1.5 text-slate-500 hover:text-indigo-600 disabled:opacity-30 transition rounded-full hover:bg-slate-50"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Right: Controls */}
        <div className="flex-1 p-6 flex flex-col gap-5 bg-white overflow-y-auto custom-scrollbar">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center">
                <FileText className="w-4 h-4" />
              </div>
              <h3 className="text-base font-semibold text-slate-900">Print settings</h3>
            </div>
            <button onClick={() => setShowImpositionModal(false)} className="p-1.5 hover:bg-slate-100 rounded-md transition-colors">
              <X className="w-4 h-4 text-slate-500" />
            </button>
          </div>

          <div className="space-y-5">
            {/* Presets */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-500">Sheet size</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['a4', 'a3', '12x18', '13x19', 'custom'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setImpositionSettings(s => ({ ...s, preset: p }))}
                    className={clsx(
                      'py-2 text-xs font-semibold rounded-md border transition uppercase',
                      impositionSettings.preset === p
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50',
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom W × H — only when preset === 'custom' */}
            {impositionSettings.preset === 'custom' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-500">Width</label>
                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-md border border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition">
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      value={impositionSettings.widthIn}
                      onChange={e => setImpositionSettings(s => ({ ...s, widthIn: Math.max(1, Number(e.target.value) || 0) }))}
                      className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full"
                    />
                    <span className="text-xs text-slate-400">in</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-500">Height</label>
                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-md border border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition">
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      value={impositionSettings.heightIn}
                      onChange={e => setImpositionSettings(s => ({ ...s, heightIn: Math.max(1, Number(e.target.value) || 0) }))}
                      className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full"
                    />
                    <span className="text-xs text-slate-400">in</span>
                  </div>
                </div>
              </div>
            )}

            {/* Orientation */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-500">Orientation</label>
              <div className="grid grid-cols-2 gap-1.5">
                {(['portrait', 'landscape'] as const).map(o => (
                  <button
                    key={o}
                    onClick={() => setImpositionSettings(s => ({ ...s, orientation: o }))}
                    className={clsx(
                      'py-2 text-xs font-semibold rounded-md border transition capitalize',
                      impositionSettings.orientation === o
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50',
                    )}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>

            {/* Gutter & Margin */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-500">Gutter (gap)</label>
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-md border border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition">
                  <input
                    type="number"
                    value={impositionSettings.gutterMm}
                    onChange={e => setImpositionSettings(s => ({ ...s, gutterMm: Number(e.target.value) }))}
                    className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full"
                  />
                  <span className="text-xs text-slate-400">mm</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-500">Margin</label>
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-md border border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition">
                  <input
                    type="number"
                    value={impositionSettings.marginMm}
                    onChange={e => setImpositionSettings(s => ({ ...s, marginMm: Number(e.target.value) }))}
                    className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full"
                  />
                  <span className="text-xs text-slate-400">mm</span>
                </div>
              </div>
            </div>

            {/* Crop marks — on/off plus a requested length. The length is
                a MAXIMUM: resolveCropMarkGeometry clamps it to the room
                the gutter and margin actually leave, so a mark can never
                print over the neighbouring photo. */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={impositionSettings.cropMarksEnabled}
                    onChange={e => setImpositionSettings(s => ({ ...s, cropMarksEnabled: e.target.checked }))}
                    className="w-4 h-4 rounded accent-indigo-600 cursor-pointer"
                  />
                  <span className="text-xs font-medium text-slate-500">Crop marks</span>
                </label>
                <div className={clsx(
                  'flex items-center gap-2 px-3 py-1.5 rounded-md border transition w-28',
                  impositionSettings.cropMarksEnabled
                    ? 'bg-slate-50 border-slate-200 focus-within:border-indigo-400 focus-within:bg-white'
                    : 'bg-slate-50/50 border-slate-100 opacity-50',
                )}>
                  <input
                    type="number"
                    min={CROP_MARK_LEN_MIN_MM}
                    max={CROP_MARK_LEN_MAX_MM}
                    disabled={!impositionSettings.cropMarksEnabled}
                    value={impositionSettings.cropMarkLenMm}
                    onChange={e => setImpositionSettings(s => ({
                      ...s,
                      cropMarkLenMm: Math.min(
                        CROP_MARK_LEN_MAX_MM,
                        Math.max(CROP_MARK_LEN_MIN_MM, Number(e.target.value) || 0),
                      ),
                    }))}
                    aria-label="Crop mark length"
                    className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full disabled:cursor-not-allowed"
                  />
                  <span className="text-xs text-slate-400">mm</span>
                </div>
              </div>
              {impositionSettings.cropMarksEnabled && impositionResult.cropMarks.shortened && impositionResult.cropMarks.maxLenIn > 0 && (
                <p className="text-xs text-slate-500 leading-relaxed">
                  {impositionResult.cropMarks.minLenIn < impositionResult.cropMarks.maxLenIn - 1e-9
                    ? `Marks are ${(impositionResult.cropMarks.minLenIn * MM_TO_IN).toFixed(1)}–${(impositionResult.cropMarks.maxLenIn * MM_TO_IN).toFixed(1)} mm — the shorter ones sit where the gutter or margin is tight, so they stay clear of the artwork.`
                    : `Shortened to ${(impositionResult.cropMarks.maxLenIn * MM_TO_IN).toFixed(1)} mm so they stay clear of the artwork. Widen the gutter and margin for full-length marks.`}
                </p>
              )}
            </div>

            {/* What this will actually produce */}
            <div className="px-4 py-3 bg-indigo-50 rounded-md border border-indigo-100 flex items-start gap-2.5">
              <div className="w-4 h-4 mt-0.5 bg-indigo-600 text-white rounded-full flex items-center justify-center text-[10px] flex-shrink-0">
                ✓
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-indigo-900">
                  {impositionResult.mode === 'gang' ? 'Auto-repeat' : 'Batch layout'}
                </p>
                <p className="text-xs text-indigo-700/80 mt-0.5 leading-relaxed">
                  {impositionResult.mode === 'gang'
                    ? `Your design is repeated ${impositionPlacedTotal}× to fill one ${impositionSheetLabel} sheet.`
                    : `${impositionPlacedTotal} ${impositionPlacedTotal === 1 ? 'canvas' : 'canvases'} laid out across ${sheetCount} ${sheetCount === 1 ? 'sheet' : 'sheets'} of ${impositionSheetLabel}, one copy each.`}
                </p>
              </div>
            </div>

            {/* Nothing may leave the sheet without the operator knowing. */}
            {impositionResult.unplacedCount > 0 && (
              <div className="px-4 py-3 bg-amber-50 rounded-md border border-amber-200 flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-amber-900">
                    {impositionResult.unplacedCount} {impositionResult.unplacedCount === 1 ? 'canvas' : 'canvases'} will not be printed
                  </p>
                  <p className="text-xs text-amber-800/80 mt-0.5 leading-relaxed">
                    Too large for a {impositionSheetLabel} sheet at this margin. Pick a bigger sheet size or reduce the margin.
                  </p>
                </div>
              </div>
            )}

            {impositionResult.cropMarks.maxLenIn === 0 && !impositionResult.cropMarks.disabled && (
              <div className="px-4 py-3 bg-slate-50 rounded-md border border-slate-200 flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-slate-500 flex-shrink-0" />
                <p className="text-xs text-slate-600 leading-relaxed min-w-0">
                  No room for crop marks — they would print over the artwork. Increase the gutter past 4&nbsp;mm and the margin past 2&nbsp;mm to get them back.
                </p>
              </div>
            )}
          </div>

          <div className="mt-auto pt-5 border-t border-slate-100">
            <button
              onClick={executeImposition}
              disabled={isImposing || sheetCount === 0}
              className="w-full py-2.5 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
            >
              {isImposing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {sheetCount > 1 ? `Download ${sheetCount} print sheets` : 'Download print sheet'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
