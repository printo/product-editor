'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import {
  Layout,
  Plus,
  Trash2,
  Save,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
  Eye,
  Edit2,
  Copy,
  Type,
} from 'lucide-react';
import { LayoutSVG } from '@/components/LayoutSVG';
import { SearchInput } from '@/components/ui/SearchInput';
import { useHeader } from '@/context/HeaderContext';
import { LayoutFabricPreview } from './LayoutFabricPreview';

interface LayoutFrame {
  id?: string;
  x: number; // percentage (Area + Bleed)
  y: number; // percentage (Area + Bleed)
  width: number; // percentage (Area + Bleed)
  height: number; // percentage (Area + Bleed)
  xMm?: number | string; // Print Area X
  yMm?: number | string; // Print Area Y
  widthMm?: number | string; // Print Area Width
  heightMm?: number | string; // Print Area Height
  bleedMm?: number | string; // Margin for Bleed
}

interface LayoutConfig {
  name: string;
  canvas: {
    width: number;
    height: number;
    widthMm?: number;
    heightMm?: number;
    dpi?: number;
  };
  printableArea?: {
    x: number;
    y: number;
    width: number;
    height: number;
    xMm?: number;
    yMm?: number;
    widthMm?: number;
    heightMm?: number;
    bleedMm?: number;
  };
  grid?: {
    rows: number;
    cols: number;
    padding: number;
  };
  frames?: LayoutFrame[];
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  updatedBy?: string;
  metadata?: {
    key: string;
    label: string;
    value: any;
  }[];
  maskUrl?: string;
  maskOnExport?: boolean;
}

interface SurfaceEditorState {
  key: string;
  label: string;
  widthMm: number;
  heightMm: number;
  dpi: number;
  frames: LayoutFrame[];
  maskFile: File | null;
  maskUrl: string | null;
  maskOnExport: boolean;
}

const AVAILABLE_TAGS = [
  'Polaroid', 'Square', 'Landscape', 'Portrait', 'Portfolio',
  'Vintage', 'Modern', 'Grid', 'Strip', 'Business Card', 'Postcard'
];

export default function LayoutCreatorPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();

  const [layouts, setLayouts] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form State
  const [isEditMode, setIsEditMode] = useState(false);
  const [layoutName, setLayoutName] = useState('');
  const [tags, setTags] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const [dpi, setDpi] = useState(300);
  const [widthMm, setWidthMm] = useState(101.6); // 4 inches
  const [heightMm, setHeightMm] = useState(152.4); // 6 inches

  // Removed global printable area state in favor of per-area (frame) definitions

  // Custom frames
  const [frames, setFrames] = useState<LayoutFrame[]>([]);
  const [snapGrid, setSnapGrid] = useState(true);

  // Grid generator helper state
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [padding, setPadding] = useState(2); // padding in mm natively
  const [showGridGen, setShowGridGen] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [selectedLayout, setSelectedLayout] = useState<LayoutConfig | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    if (isModalOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'auto';
    }
    return () => { document.body.style.overflow = 'auto'; };
  }, [isModalOpen]);

  // Mask State
  const [maskFile, setMaskFile] = useState<File | null>(null);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [maskOnExport, setMaskOnExport] = useState(false);
  const maskInputRef = useRef<HTMLInputElement>(null);
  const [originalLayoutName, setOriginalLayoutName] = useState<string | null>(null);

  // Multi-surface state
  const [layoutType, setLayoutType] = useState<'single' | 'product'>('single');
  const [surfaces, setSurfaces] = useState<SurfaceEditorState[]>([]);
  const [activeSurfaceIdx, setActiveSurfaceIdx] = useState(0);

  const [selectedFonts, setSelectedFonts] = useState<string[]>(['sans-serif', 'serif', 'monospace']);
  const [fontsLoaded, setFontsLoaded] = useState<Set<string>>(new Set());
  const [showFontModal, setShowFontModal] = useState(false);
  const [fontSearch, setFontSearch] = useState('');

  // Selected frame in Fabric preview
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);

  useEffect(() => {
    if (isModalOpen) {
      setTitle(isEditMode ? 'Edit Template' : 'Create Template');
      setDescription('Define canvas dimensions and print areas');
      setCenterActions(null);
      setRightActions(
        <button
          onClick={() => setIsModalOpen(false)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded border border-slate-200 hover:border-slate-300 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
          Close Editor
        </button>
      );
    } else {
      setTitle('Template Library');
      setDescription('Manage reusable designs');
      setCenterActions(<SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={`Filter templates for ${layouts.length} templates...`} />);
      setRightActions(
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFontModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded border border-slate-200 hover:border-slate-300 transition-colors"
          >
            <Type className="w-3.5 h-3.5" />
            Fonts ({selectedFonts.length})
          </button>
          <button
            onClick={() => {
              setIsEditMode(false);
              setLayoutName('');
              setTags('');
              setFrames([]);
              setSurfaces([]);
              setLayoutType('single');
              setMaskUrl(null);
              setMaskFile(null);
              setMaskOnExport(false);
              setIsModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-[10px] font-bold uppercase rounded hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            Create
          </button>
        </div>
      );
    }
  }, [isModalOpen, isEditMode, setTitle, setDescription, setCenterActions, setRightActions, searchQuery, selectedFonts.length, layouts.length]);

  const [isSavingFonts, setIsSavingFonts] = useState(false);

  const googleFontsList = [
    'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Oswald', 'Raleway',
    'Poppins', 'Nunito', 'Ubuntu', 'Playfair Display', 'Merriweather',
    'Inter', 'Rubik', 'Work Sans', 'Quicksand', 'Barlow', 'Fira Sans',
    'Karla', 'Cabin', 'Arvo', 'Bitter', 'Crimson Text', 'Josefin Sans',
    'Pacifico', 'Dancing Script', 'Lobster', 'Bebas Neue', 'Anton',
    'Permanent Marker', 'Satisfy', 'Great Vibes', 'Abril Fatface',
    'Archivo', 'Source Sans 3', 'DM Sans', 'Space Grotesk', 'Outfit',
    'Sora', 'Manrope', 'Plus Jakarta Sans', 'Lexend',
  ];

  const loadGoogleFont = useCallback((fontName: string) => {
    if (fontsLoaded.has(fontName) || ['sans-serif', 'serif', 'monospace', 'cursive'].includes(fontName)) return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    setFontsLoaded(prev => new Set(prev).add(fontName));
  }, [fontsLoaded]);

  // Fetch selected fonts from the backend on mount
  useEffect(() => {
    if (!session?.accessToken) return;
    fetch('/api/fonts', {
      headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' },
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.fonts) setSelectedFonts(data.fonts); })
      .catch(() => {});
  }, [session?.accessToken]);

  // Save selected fonts to the backend
  const saveFontsToBackend = useCallback(async (fonts: string[]) => {
    if (!session?.accessToken) return;
    setIsSavingFonts(true);
    try {
      await fetch('/api/fonts', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ fonts }),
      });
    } catch {}
    setIsSavingFonts(false);
  }, [session?.accessToken]);

  // Pre-load selected Google Fonts for preview
  useEffect(() => {
    selectedFonts.forEach(f => loadGoogleFont(f));
  }, [selectedFonts, loadGoogleFont]);

  // Resolve active frames/dimensions based on layout type
  const activeFrames = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].frames : frames;
  const activeWidthMm = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].widthMm : widthMm;
  const activeHeightMm = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].heightMm : heightMm;
  const activeDpi = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].dpi : dpi;
  const activeMaskFile = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].maskFile : maskFile;
  const activeMaskUrl = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].maskUrl : maskUrl;
  const activeMaskOnExport = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].maskOnExport : maskOnExport;

  const setActiveFrames = useCallback((updater: LayoutFrame[] | ((prev: LayoutFrame[]) => LayoutFrame[])) => {
    if (layoutType === 'product') {
      setSurfaces(prev => prev.map((s, i) => {
        if (i !== activeSurfaceIdx) return s;
        const newFrames = typeof updater === 'function' ? updater(s.frames) : updater;
        return { ...s, frames: newFrames };
      }));
    } else {
      if (typeof updater === 'function') {
        setFrames(updater);
      } else {
        setFrames(updater);
      }
    }
  }, [layoutType, activeSurfaceIdx]);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
    } else if (status === 'authenticated' && !session?.is_ops_team) {
      router.push('/dashboard');
    }
  }, [status, session, router]);

  const fetchLayouts = useCallback(async () => {
    try {
      const res = await fetch('/api/ops/layouts', {
        headers: {
          'Authorization': `Bearer ${session?.accessToken}`,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      if (data.layouts) {
        const layoutDetails = (data.layouts || []).map((item: any) => {
          if (typeof item === 'string') return { name: item };
          return {
            ...item,
            id: item.name,
            tags: item.tags || []
          };
        });
        setLayouts(layoutDetails);
      }
    } catch (err) {
      console.error('Failed to fetch layouts', err);
    } finally {
      setIsLoading(false);
    }
  }, [session?.accessToken]);

  useEffect(() => {
    if (session?.accessToken) {
      fetchLayouts();
    }
  }, [session?.accessToken, fetchLayouts]);

  const internalId = layoutName.toLowerCase().replace(/\s+/g, '_');
  const mmToPx = (mm: number, dpiVal: number) => Math.round((mm / 25.4) * dpiVal);
  const pxToMm = (px: number, dpiVal: number) => round2((px / dpiVal) * 25.4);
  const round2 = (val: number) => Math.round((val + Number.EPSILON) * 100) / 100;

  const handleGenerateGrid = () => {
    const newFrames: LayoutFrame[] = [];
    const cellW = (widthMm - (cols + 1) * padding) / cols;
    const cellH = (heightMm - (rows + 1) * padding) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = padding + c * (cellW + padding);
        const y = padding + r * (cellH + padding);
        newFrames.push({
          id: Math.random().toString(36).substr(2, 9),
          xMm: round2(x),
          yMm: round2(y),
          widthMm: round2(cellW),
          heightMm: round2(cellH),
          bleedMm: 0,
          x: 0, y: 0, width: 0, height: 0
        });
      }
    }
    setFrames(newFrames);
    setShowGridGen(false);
  };

  const _mapFrames = (frameList: LayoutFrame[], wMmVal: number, hMmVal: number, dpiVal: number) => {
    const canvasW = mmToPx(wMmVal, dpiVal);
    const canvasH = mmToPx(hMmVal, dpiVal);
    return frameList.map(f => {
      const bleed = round2(Number(f.bleedMm || 0));
      const xMm = round2(Number(f.xMm || 0));
      const yMm = round2(Number(f.yMm || 0));
      const wMm = round2(Number(f.widthMm || 0));
      const hMm = round2(Number(f.heightMm || 0));
      const pxX = mmToPx(xMm - bleed, dpiVal);
      const pxY = mmToPx(yMm - bleed, dpiVal);
      const pxW = mmToPx(wMm + (bleed * 2), dpiVal);
      const pxH = mmToPx(hMm + (bleed * 2), dpiVal);
      return {
        ...f,
        xMm, yMm, widthMm: wMm, heightMm: hMm, bleedMm: bleed,
        x: pxX / canvasW,
        y: pxY / canvasH,
        width: pxW / canvasW,
        height: pxH / canvasH,
      };
    });
  };

  const handleCreateLayout = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    setSuccess(null);

    // Validate bounds for active frame set
    const framesToCheck = layoutType === 'product' ? surfaces.flatMap(s => s.frames.map(f => ({ f, w: s.widthMm, h: s.heightMm }))) : frames.map(f => ({ f, w: widthMm, h: heightMm }));
    const outOfBounds = framesToCheck.some(({ f, w, h }) => {
      const bleed = round2(Number(f.bleedMm || 0));
      const xVal = Number(f.xMm || 0);
      const yVal = Number(f.yMm || 0);
      const wVal = Number(f.widthMm || 0);
      const hVal = Number(f.heightMm || 0);
      return (
        round2(xVal - bleed) < 0 ||
        round2(wVal + (bleed * 2)) > w ||
        round2(xVal + wVal + bleed) > w ||
        round2(yVal - bleed) < 0 ||
        round2(hVal + (bleed * 2)) > h ||
        round2(yVal + hVal + bleed) > h
      );
    });

    if (outOfBounds && !window.confirm("Some Print Areas are out of the canvas bounds. Save anyway?")) {
      setIsSaving(false);
      return;
    }

    let layoutData: any;
    const formData = new FormData();

    if (layoutType === 'product') {
      // Multi-surface product layout
      const surfacesData = surfaces.map(s => ({
        key: s.key,
        label: s.label,
        canvas: {
          width: mmToPx(s.widthMm, s.dpi),
          height: mmToPx(s.heightMm, s.dpi),
          widthMm: round2(s.widthMm),
          heightMm: round2(s.heightMm),
          dpi: s.dpi,
        },
        frames: _mapFrames(s.frames, s.widthMm, s.heightMm, s.dpi),
        maskUrl: s.maskUrl || null,
        maskOnExport: s.maskOnExport,
      }));

      layoutData = {
        name: internalId,
        type: 'product',
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        surfaces: surfacesData,
      };

      // Append per-surface mask files
      surfaces.forEach(s => {
        if (s.maskFile) {
          formData.append(`mask_${s.key}`, s.maskFile);
        }
      });
    } else {
      // Single-surface layout (existing format)
      const canvasW = mmToPx(widthMm, dpi);
      const canvasH = mmToPx(heightMm, dpi);

      layoutData = {
        name: internalId,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        canvas: {
          width: canvasW,
          height: canvasH,
          widthMm: round2(widthMm),
          heightMm: round2(heightMm),
          dpi,
        },
        frames: _mapFrames(frames, widthMm, heightMm, dpi),
        maskUrl: maskUrl || null,
        maskOnExport: maskOnExport,
      };

      if (maskFile) {
        formData.append('mask', maskFile);
      }
      if (!maskFile && !maskUrl) {
        formData.append('remove_mask', 'true');
      }
      formData.append('maskOnExport', maskOnExport.toString());
    }

    formData.append('name', internalId);
    formData.append('layout', JSON.stringify(layoutData));
    if (isEditMode && originalLayoutName && originalLayoutName !== internalId) {
      formData.append('old_name', originalLayoutName);
    }

    try {
      const res = await fetch('/api/ops/layouts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.accessToken}`,
          'Accept': 'application/json'
          // NOTE: Do NOT set Content-Type here – the browser sets it automatically
          // with the correct multipart boundary for FormData
        },
        body: formData
      });

      const result = await res.json();
      if (res.ok) {
        setSuccess(`Layout "${layoutName}" saved successfully!`);
        fetchLayouts();
        setIsModalOpen(false);
      } else {
        setError(result.detail || 'Failed to save layout');
      }
    } catch (err) {
      setError('An error occurred while saving.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteLayout = async (layoutName: string) => {
    try {
      const res = await fetch(`/api/ops/layouts/${layoutName}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session?.accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (res.ok) {
        setSuccess(`Layout ${layoutName} deleted.`);
        fetchLayouts();
      } else {
        const text = await res.text();
        let detail = 'Failed to delete layout';
        try {
          const result = JSON.parse(text);
          detail = result.detail || detail;
        } catch (e) { }
        setError(detail);
      }
    } catch (err) {
      setError('An error occurred while deleting.');
    }
  };

  const fetchLayoutDetail = async (targetLayout: string) => {
    if (!targetLayout) return null;
    try {
      const res = await fetch(`/api/ops/layouts/${targetLayout}`, {
        headers: {
          'Authorization': `Bearer ${session?.accessToken}`,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) return null;
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        console.error('Invalid JSON in layout detail', e);
        return null;
      }
    } catch (err) {
      console.error('Failed to fetch layout detail', err);
      return null;
    }
  };

  const openViewModal = async (layoutName: string) => {
    const data = await fetchLayoutDetail(layoutName);
    if (data) setSelectedLayout(data);
  };

  const _loadFramesFromData = (data: any, canvas: any) => {
    const displayDpi = canvas.dpi || 300;
    if (data.frames) {
      return data.frames.map((f: any) => ({
        ...f,
        id: Math.random().toString(36).substr(2, 9),
        xMm: round2(f.xMm ?? pxToMm(f.x * canvas.width, displayDpi)),
        yMm: round2(f.yMm ?? pxToMm(f.y * canvas.height, displayDpi)),
        widthMm: round2(f.widthMm ?? pxToMm(f.width * canvas.width, displayDpi)),
        heightMm: round2(f.heightMm ?? pxToMm(f.height * canvas.height, displayDpi)),
        bleedMm: round2(Number(f.bleedMm || 0))
      }));
    }
    return [];
  };

  const openEditModal = async (layoutId: string) => {
    const data = await fetchLayoutDetail(layoutId);
    if (data) {
      setLayoutName(data.name.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()));
      setTags(data.tags?.join(', ') || '');
      setOriginalLayoutName(layoutId);

      // Multi-surface product layout
      if (data.type === 'product' && Array.isArray(data.surfaces)) {
        setLayoutType('product');
        const loadedSurfaces: SurfaceEditorState[] = data.surfaces.map((s: any) => {
          const sDpi = s.canvas?.dpi || 300;
          return {
            key: s.key || 'unknown',
            label: s.label || s.key || 'Unknown',
            widthMm: round2(s.canvas?.widthMm || pxToMm(s.canvas?.width || 0, sDpi)),
            heightMm: round2(s.canvas?.heightMm || pxToMm(s.canvas?.height || 0, sDpi)),
            dpi: sDpi,
            frames: _loadFramesFromData(s, s.canvas || {}),
            maskFile: null,
            maskUrl: s.maskUrl || null,
            maskOnExport: s.maskOnExport || false,
          };
        });
        setSurfaces(loadedSurfaces);
        setActiveSurfaceIdx(0);
        // Also set flat state from first surface as fallback
        if (loadedSurfaces.length > 0) {
          setDpi(loadedSurfaces[0].dpi);
          setWidthMm(loadedSurfaces[0].widthMm);
          setHeightMm(loadedSurfaces[0].heightMm);
          setFrames(loadedSurfaces[0].frames);
        }
      } else {
        // Single-surface layout
        setLayoutType('single');
        setSurfaces([]);
        const displayDpi = data.canvas?.dpi || 300;
        setDpi(displayDpi);
        setWidthMm(round2(data.canvas?.widthMm || pxToMm(data.canvas?.width || 0, displayDpi)));
        setHeightMm(round2(data.canvas?.heightMm || pxToMm(data.canvas?.height || 0, displayDpi)));

        const loadedFrames = _loadFramesFromData(data, data.canvas || {});
        if (loadedFrames.length > 0) {
          setFrames(loadedFrames);
        } else if (data.grid) {
          setRows(data.grid.rows || 2);
          setCols(data.grid.cols || 2);
          const paddMm = data.grid.padding ? pxToMm(data.grid.padding, displayDpi) : 2;
          setPadding(paddMm);
          const cW = (data.canvas?.widthMm || pxToMm(data.canvas?.width || 0, displayDpi));
          const cH = (data.canvas?.heightMm || pxToMm(data.canvas?.height || 0, displayDpi));
          const cellW = (cW - (data.grid.cols + 1) * paddMm) / data.grid.cols;
          const cellH = (cH - (data.grid.rows + 1) * paddMm) / data.grid.rows;
          const fallbackFrames: any[] = [];
          for (let r = 0; r < data.grid.rows; r++) {
            for (let c = 0; c < data.grid.cols; c++) {
              fallbackFrames.push({
                id: Math.random().toString(36).substr(2, 9),
                xMm: Number((paddMm + c * (cellW + paddMm)).toFixed(2)),
                yMm: Number((paddMm + r * (cellH + paddMm)).toFixed(2)),
                widthMm: Number(cellW.toFixed(2)),
                heightMm: Number(cellH.toFixed(2)),
                x: 0, y: 0, width: 0, height: 0
              });
            }
          }
          setFrames(fallbackFrames);
        }

        setMaskUrl(data.maskUrl || null);
        setMaskOnExport(data.maskOnExport || false);
        setMaskFile(null);
      }

      setIsEditMode(true);
      setIsModalOpen(true);
    }
  };

  const openCopyModal = async (layoutId: string) => {
    const data = await fetchLayoutDetail(layoutId);
    if (data) {
      const displayDpi = data.canvas.dpi || 300;
      setDpi(displayDpi);
      setWidthMm(round2(data.canvas.widthMm || pxToMm(data.canvas.width, displayDpi)));
      setHeightMm(round2(data.canvas.heightMm || pxToMm(data.canvas.height, displayDpi)));
      // Pre-fill name with 'copy_' prefix displayed nicely
      const copyName = `copy ${layoutId.replace(/_/g, ' ')}`;
      setLayoutName(copyName);
      setTags(data.tags?.join(', ') || '');
      if (data.frames) {
        const loadedFrames = data.frames.map((f: any) => ({
          ...f,
          id: Math.random().toString(36).substr(2, 9),
          xMm: round2(f.xMm ?? pxToMm(f.x * data.canvas.width, displayDpi)),
          yMm: round2(f.yMm ?? pxToMm(f.y * data.canvas.height, displayDpi)),
          widthMm: round2(f.widthMm ?? pxToMm(f.width * data.canvas.width, displayDpi)),
          heightMm: round2(f.heightMm ?? pxToMm(f.height * data.canvas.height, displayDpi)),
          bleedMm: round2(Number(f.bleedMm || 0))
        }));
        setFrames(loadedFrames);
      }
      setMaskUrl(data.maskUrl || null);
      setMaskOnExport(data.maskOnExport || false);
      setMaskFile(null);
      setOriginalLayoutName(null); // Not a rename — it's a brand new copy, no old file to delete
      setIsEditMode(false); // Treat as new creation so it won't conflict
      setIsModalOpen(true);
    }
  };

  const openCreateModal = () => {
    setIsEditMode(false);
    setLayoutName('');
    setTags('');
    setWidthMm(101.6);
    setHeightMm(152.4);
    setDpi(300);
    setFrames([]);
    setMaskUrl(null);
    setMaskFile(null);
    setMaskOnExport(false);
    setLayoutType('single');
    setSurfaces([]);
    setActiveSurfaceIdx(0);
    setOriginalLayoutName(null);
    setIsModalOpen(true);
  };
  const updateFrame = (id: string, field: string, value: string) => {
    const cW = activeWidthMm;
    const cH = activeHeightMm;
    setActiveFrames(prev => prev.map(f => {
      if (f.id !== id) return f;

      const newFrame = { ...f, [field]: value };
      const bleed = round2(Number(newFrame.bleedMm || 0));
      const xVal = Number(newFrame.xMm || 0);
      const yVal = Number(newFrame.yMm || 0);
      const wVal = Number(newFrame.widthMm || 0);
      const hVal = Number(newFrame.heightMm || 0);

      let hasError = false;
      let msg = "";

      if (round2(xVal - bleed) < 0) {
        msg = "Area #"+(prev.indexOf(f)+1)+": Out of bounds (Left)";
        hasError = true;
      } else if (round2(wVal + (bleed * 2)) > cW) {
        msg = "Area #"+(prev.indexOf(f)+1)+": Exceeds canvas width";
        hasError = true;
      } else if (round2(xVal + wVal + bleed) > cW) {
        msg = "Area #"+(prev.indexOf(f)+1)+": Out of bounds (Right)";
        hasError = true;
      } else if (round2(yVal - bleed) < 0) {
        msg = "Area #"+(prev.indexOf(f)+1)+": Out of bounds (Top)";
        hasError = true;
      } else if (round2(hVal + (bleed * 2)) > cH) {
        msg = "Area #"+(prev.indexOf(f)+1)+": Exceeds canvas height";
        hasError = true;
      } else if (round2(yVal + hVal + bleed) > cH) {
        msg = "Area #"+(prev.indexOf(f)+1)+": Out of bounds (Bottom)";
        hasError = true;
      }

      if (hasError) {
        setValidationError(msg);
        setTimeout(() => setValidationError(null), 3000);
      }

      return newFrame;
    }));
  };


  if (status === 'loading' || isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent flex flex-col">
      <main className="max-w-[1440px] mx-auto px-8 py-8 w-full">

        {error && (
          <div className="mb-6 p-4 bg-rose-50 border border-rose-100 text-rose-800 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {success && (
          <div className="mb-6 p-4 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
            <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
            <p className="text-sm font-medium">{success}</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {layouts
            .filter((l: any) => {
              const q = searchQuery.toLowerCase();
              const name = typeof l === 'string' ? l : (l.name || '');
              const tags = l.tags || [];
              return name.toLowerCase().includes(q) || tags.some((t: string) => t.toLowerCase().includes(q));
            })
            .map((layoutObj: any) => {
              const layoutStr = typeof layoutObj === 'string' ? layoutObj : layoutObj.name;
              return (
                <div
                  key={layoutStr}
                  className="bg-white border border-slate-200 rounded-2xl p-6 hover:shadow-lg hover:border-indigo-200 transition-all group relative"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-4">
                      {/* Thumbnail Preview */}
                      <div className="w-16 h-16 bg-slate-50 rounded-xl overflow-hidden border border-slate-100 flex items-center justify-center flex-shrink-0 group-hover:border-indigo-100 transition-colors">
                        <LayoutSVG layout={layoutObj} className="w-full h-full object-contain" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 capitalize tracking-tight">{(layoutStr || '').replace(/_/g, ' ')}</h3>
                        <p className="text-[10px] text-slate-400 font-mono mt-0.5 tracking-wider">{(layoutStr || '')}.json</p>
                        {layoutObj.tags && layoutObj.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {layoutObj.tags.slice(0, 2).map((t: string) => (
                              <span key={t} className="px-2 py-0.5 bg-slate-100 text-slate-500 text-[9px] rounded-full font-bold uppercase tracking-tight">{t}</span>
                            ))}
                            {layoutObj.tags.length > 2 && (
                                <span className="text-[9px] text-slate-400 font-bold ml-0.5">+{layoutObj.tags.length - 2}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center">
                      <button
                        onClick={() => openCopyModal(layoutStr)}
                        className="p-2 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all"
                        title="Duplicate Layout"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => openEditModal(layoutStr)}
                        className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
                        title="Edit Layout"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(layoutStr)}
                        className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                        title="Delete Layout"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t border-slate-100/50 flex flex-col gap-1.5">
                    {/* Structured Metadata (Prefer this if available) */}
                    {layoutObj.metadata ? (
                      <div className="space-y-3 pt-2">
                        {layoutObj.metadata.filter((m: any) => m.key !== 'tags' || (Array.isArray(m.value) && m.value.length > 0)).map((meta: any) => (
                          <div key={meta.key} className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                            <span className="text-slate-400 font-medium">{meta.label}</span>
                            <span className="text-slate-900 font-bold">
                              {meta.key.includes('At') ? new Date(meta.value).toLocaleString() : meta.value || 'N/A'}
                            </span>
                          </div>
                        ))}
                        {/* Fallback for dimensions if not in metadata */}
                        {!layoutObj.metadata.some((m: any) => m.key === 'dimensions') && layoutObj.canvas && (
                          <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                            <span className="text-slate-400 font-medium">Dimensions</span>
                            <span className="text-slate-900 font-bold">{layoutObj.canvas.widthMm?.toFixed(2)} x {layoutObj.canvas.heightMm?.toFixed(2)}mm</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                          <span className="text-slate-400 font-medium">Created By</span>
                          <span className="text-slate-900 font-bold">{layoutObj.createdBy || 'System'}</span>
                        </div>
                        {layoutObj.canvas && (
                          <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                            <span className="text-slate-400 font-medium">Canvas Size</span>
                            <span className="text-slate-900 font-bold">{layoutObj.canvas.widthMm?.toFixed(2)} x {layoutObj.canvas.heightMm?.toFixed(2)}mm</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                          <span className="text-slate-400 font-medium">Created At</span>
                          <span className="text-slate-900 font-bold">{layoutObj.createdAt ? new Date(layoutObj.createdAt).toLocaleString() : 'N/A'}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between mt-6">
                    <button
                      onClick={() => openViewModal(layoutStr)}
                      className="text-sm font-semibold text-slate-500 hover:text-indigo-600 flex items-center gap-1 transition-colors"
                    >
                      <Eye className="w-4 h-4" />
                      View Raw JSON
                    </button>
                    <ChevronRight className="w-4 h-4 text-slate-300 transition-transform group-hover:translate-x-1" />
                  </div>
                </div>
              );
            })}

          {layouts.length === 0 && (
            <div className="col-span-full py-20 bg-white border border-dashed border-slate-300 rounded-3xl flex flex-col items-center justify-center text-slate-400">
              <div className="p-4 bg-slate-50 rounded-full mb-4">
                <Layout className="w-8 h-8 opacity-20" />
              </div>
              <p className="font-medium">No layouts found in backend storage.</p>
              <button
                onClick={openCreateModal}
                className="mt-4 text-indigo-600 font-bold hover:underline"
              >
                Create your first layout
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Create / Edit Modal (Full Screen mode - sits under the persistent Header) */}
      {isModalOpen && (
        <div className="fixed top-16 inset-x-0 bottom-0 z-[1000] flex flex-col bg-white overflow-hidden animate-in fade-in duration-200">
          <div className="flex-1 flex flex-col min-h-0">
            {/* Redundant local header removed — Titles now in global header */}

            <div className="flex-1 min-h-0 bg-slate-50/50">
              <form id="layout-form" onSubmit={handleCreateLayout} className="grid grid-cols-1 lg:grid-cols-12 h-full overflow-hidden">

                {/* Left Column: Form Controls (Scrollable) */}
                <div className="lg:col-span-7 h-full overflow-y-auto px-6 py-6 space-y-6 custom-scrollbar">

                  {/* Basic Info & Canvas */}
                  <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Layout Name</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Classic Print 4x6"
                        value={layoutName}
                        onChange={(e) => setLayoutName(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-slate-900"
                      />
                      {layoutName && <p className="text-xs text-slate-400 mt-1.5 font-mono">ID: {internalId}</p>}
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Primary Tag</label>
                      <select
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-slate-900 bg-white"
                      >
                        <option value="">Select a Tag...</option>
                        {AVAILABLE_TAGS.map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>

                    {/* Layout Type Toggle */}
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Layout Type</label>
                      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => {
                            if (layoutType === 'product' && surfaces.length > 0) {
                              // Copy first surface to flat state
                              const s = surfaces[0];
                              setWidthMm(s.widthMm); setHeightMm(s.heightMm); setDpi(s.dpi);
                              setFrames(s.frames); setMaskFile(s.maskFile); setMaskUrl(s.maskUrl); setMaskOnExport(s.maskOnExport);
                            }
                            setLayoutType('single');
                          }}
                          className={`flex-1 px-4 py-2 text-xs font-bold transition-all ${layoutType === 'single' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                        >
                          Single Canvas
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (layoutType === 'single') {
                              // Init surfaces from current flat state
                              setSurfaces([{
                                key: 'front', label: 'Front',
                                widthMm, heightMm, dpi, frames,
                                maskFile, maskUrl, maskOnExport,
                              }]);
                              setActiveSurfaceIdx(0);
                            }
                            setLayoutType('product');
                          }}
                          className={`flex-1 px-4 py-2 text-xs font-bold transition-all ${layoutType === 'product' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                        >
                          Multi-Surface Product
                        </button>
                      </div>
                    </div>

                    {/* Surface Tab Bar (multi-surface only) */}
                    {layoutType === 'product' && (
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Surfaces</label>
                        <div className="flex flex-wrap items-center gap-2">
                          {surfaces.map((s, i) => (
                            <div key={i} className="flex items-center">
                              <button
                                type="button"
                                onClick={() => setActiveSurfaceIdx(i)}
                                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${activeSurfaceIdx === i ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                              >
                                {s.label || s.key}
                              </button>
                              {surfaces.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSurfaces(prev => prev.filter((_, j) => j !== i));
                                    setActiveSurfaceIdx(prev => Math.min(prev, surfaces.length - 2));
                                  }}
                                  className="ml-0.5 p-0.5 text-slate-300 hover:text-rose-500 transition-colors"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              const n = surfaces.length + 1;
                              setSurfaces(prev => [...prev, {
                                key: `surface-${n}`, label: `Surface ${n}`,
                                widthMm: 101.6, heightMm: 152.4, dpi: 300,
                                frames: [], maskFile: null, maskUrl: null, maskOnExport: false,
                              }]);
                              setActiveSurfaceIdx(surfaces.length);
                            }}
                            className="px-3 py-1.5 text-xs font-bold bg-slate-50 border border-dashed border-slate-300 text-slate-500 rounded-lg hover:border-indigo-400 hover:text-indigo-600 transition-all flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Surface Label & auto-derived Key (multi-surface only) */}
                    {layoutType === 'product' && surfaces[activeSurfaceIdx] && (
                      <div className="grid grid-cols-2 gap-3 p-3 bg-indigo-50/50 rounded-lg border border-indigo-100">
                        <div>
                          <label className="block text-[10px] font-bold text-indigo-600 uppercase mb-1">Display Label</label>
                          <input
                            type="text"
                            value={surfaces[activeSurfaceIdx].label}
                            onChange={(e) => {
                              const label = e.target.value;
                              const key = label.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                              setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, label, key: key || s.key } : s));
                            }}
                            className="w-full px-2 py-1.5 text-xs rounded border border-indigo-200"
                            placeholder="e.g. Front"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Surface Key</label>
                          <input
                            type="text"
                            value={surfaces[activeSurfaceIdx].key}
                            readOnly
                            className="w-full px-2 py-1.5 text-xs rounded border border-slate-200 font-mono bg-slate-100 text-slate-500 cursor-not-allowed"
                          />
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Width (mm)</label>
                        <input
                          type="number" step="0.01" min="0" required
                          value={layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].widthMm : widthMm}
                          onChange={(e) => {
                            const v = round2(Number(e.target.value));
                            if (layoutType === 'product') {
                              setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, widthMm: v } : s));
                            } else {
                              setWidthMm(v);
                            }
                          }}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Height (mm)</label>
                        <input
                          type="number" step="0.01" min="0" required
                          value={layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].heightMm : heightMm}
                          onChange={(e) => {
                            const v = round2(Number(e.target.value));
                            if (layoutType === 'product') {
                              setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, heightMm: v } : s));
                            } else {
                              setHeightMm(v);
                            }
                          }}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Resol. (DPI)</label>
                        <input
                          type="number" min="300" required
                          value={layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].dpi : dpi}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (layoutType === 'product') {
                              setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, dpi: v } : s));
                            } else {
                              setDpi(v);
                            }
                          }}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-indigo-500"
                        />
                      </div>
                    </div>
                    <div className="text-xs text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg font-medium inline-block">
                      Final Canvas Size: {Math.round(mmToPx(activeWidthMm, activeDpi))} x {Math.round(mmToPx(activeHeightMm, activeDpi))} px
                    </div>
                  </div>

                  {/* Masking Support */}

                  {/* Masking Support */}
                  <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                    <label className="block text-xs font-bold text-indigo-600 uppercase tracking-wider">Canvas Mask & Overlay (Optional)</label>
                    <div className="flex items-center gap-4">
                      <div className="flex-1">
                        <input
                          type="file"
                          ref={maskInputRef}
                          className="hidden"
                          accept="image/png"
                          onChange={(e) => {
                            if (e.target.files?.[0]) {
                              if (layoutType === 'product') {
                                setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, maskFile: e.target.files![0] } : s));
                              } else {
                                setMaskFile(e.target.files[0]);
                              }
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => maskInputRef.current?.click()}
                          className="w-full px-4 py-2.5 border border-slate-200 border-dashed rounded-lg text-xs font-bold text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition-all flex items-center justify-center gap-2"
                        >
                          <Plus className="w-4 h-4" />
                          {activeMaskFile ? 'Change Mask Image' : 'Upload PNG Mask'}
                        </button>
                      </div>
                      {(activeMaskFile || activeMaskUrl) && (
                        <button
                          type="button"
                          onClick={() => {
                            if (layoutType === 'product') {
                              setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, maskFile: null, maskUrl: null } : s));
                            } else {
                              setMaskFile(null); setMaskUrl(null);
                            }
                          }}
                          className="px-3 py-2.5 bg-rose-50 text-rose-600 rounded-lg text-xs font-bold hover:bg-rose-100"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    {(activeMaskFile || activeMaskUrl) && (
                      <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-slate-700">Mask on Export</span>
                          <span className="text-[10px] text-slate-500">Apply this mask to high-res output?</span>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            className="sr-only peer"
                            checked={activeMaskOnExport}
                            onChange={(e) => {
                              if (layoutType === 'product') {
                                setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, maskOnExport: e.target.checked } : s));
                              } else {
                                setMaskOnExport(e.target.checked);
                              }
                            }}
                          />
                          <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Print Areas Management */}
                  <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-bold text-indigo-600 uppercase tracking-wider focus:outline-none">Print Areas Management (mm)</label>
                      <div className="flex items-center gap-4">
                        <label className="flex items-center text-xs font-medium text-slate-600 gap-1.5 cursor-pointer">
                          <input type="checkbox" checked={snapGrid} onChange={(e) => setSnapGrid(e.target.checked)} className="rounded text-indigo-600 focus:ring-indigo-500" />
                          Snap Grid
                        </label>
                        <button type="button" onClick={() => setShowGridGen(!showGridGen)} className="text-xs text-slate-500 hover:text-indigo-600 font-semibold transition-colors">Grid Gen</button>
                        <button type="button" onClick={() => setActiveFrames(prev => [...prev, { id: Math.random().toString(36).substr(2, 9), xMm: 0, yMm: 0, widthMm: 50, heightMm: 50, bleedMm: 0, x: 0, y: 0, width: 0, height: 0 }])} className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1"><Plus className="w-3 h-3" /> Add Area</button>
                      </div>
                    </div>

                    {validationError && (
                      <div className="px-3 py-2 bg-amber-50 border border-amber-200 text-amber-700 text-[10px] font-bold rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                        <AlertCircle className="w-3.5 h-3.5" />
                        {validationError}
                      </div>
                    )}

                    {showGridGen && (
                      <div className="p-4 bg-slate-50 rounded-lg border border-slate-100 flex items-end gap-3 animate-in fade-in slide-in-from-top-2">
                        <div><label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Rows</label><input type="number" min="1" value={rows} onChange={e => setRows(Number(e.target.value))} className="w-16 px-2 py-1.5 text-sm rounded border border-slate-200" /></div>
                        <div><label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Cols</label><input type="number" min="1" value={cols} onChange={e => setCols(Number(e.target.value))} className="w-16 px-2 py-1.5 text-sm rounded border border-slate-200" /></div>
                        <div><label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Pad (mm)</label><input type="number" min="0" step="0.01" value={padding} onChange={e => setPadding(round2(Number(e.target.value)))} className="w-20 px-2 py-1.5 text-sm rounded border border-slate-200" /></div>
                        <button type="button" onClick={handleGenerateGrid} className="px-4 py-1.5 bg-slate-800 text-white rounded text-xs font-bold hover:bg-slate-700">Replace & Generate</button>
                      </div>
                    )}

                    <div className="flex items-center gap-2 px-2 pb-1 border-b border-slate-100">
                      <span className="w-6"></span>
                      <label className="w-full text-[10px] font-bold text-slate-400 uppercase">X</label>
                      <label className="w-full text-[10px] font-bold text-slate-400 uppercase">Y</label>
                      <label className="w-full text-[10px] font-bold text-slate-400 uppercase">W</label>
                      <label className="w-full text-[10px] font-bold text-slate-400 uppercase">H</label>
                      <label className="w-16 text-[10px] font-bold text-rose-400 uppercase">Bleed</label>
                      <span className="p-1.5 w-6 md:opacity-0"></span>
                    </div>

                    <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                      {activeFrames.length === 0 ? (
                        <div className="text-center py-6 text-sm text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">No print areas added yet. Use Grid Gen or Add Area.</div>
                      ) : activeFrames.map((f, i) => (
                        <div key={f.id} className="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-100 group">
                          <span className="w-6 text-center text-xs font-bold text-slate-400">#{i + 1}</span>
                          <input type="number" min="0" step="0.01" value={f.xMm} onChange={e => updateFrame(f.id!, 'xMm', e.target.value)} className="w-full min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" title="X (mm)" />
                          <input type="number" min="0" step="0.01" value={f.yMm} onChange={e => updateFrame(f.id!, 'yMm', e.target.value)} className="w-full min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" title="Y (mm)" />
                          <input type="number" min="0" step="0.01" value={f.widthMm} onChange={e => updateFrame(f.id!, 'widthMm', e.target.value)} className="w-full min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" title="W (mm)" />
                          <input type="number" min="0" step="0.01" value={f.heightMm} onChange={e => updateFrame(f.id!, 'heightMm', e.target.value)} className="w-full min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" title="H (mm)" />
                          <input type="number" min="0" step="0.01" value={f.bleedMm} onChange={e => updateFrame(f.id!, 'bleedMm', e.target.value)} className="w-16 px-2 py-1.5 text-xs rounded border border-rose-100 bg-rose-50 text-rose-600 font-bold" title="Bleed (mm)" />
                          <button type="button" onClick={() => setActiveFrames(prev => prev.filter(fr => fr.id !== f.id))} className="p-1.5 text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded md:opacity-0 group-hover:opacity-100 transition-all"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  </div>

                </div>

                {/* Right Column: Live Preview (Fixed Viewport) */}
                <div className="lg:col-span-5 h-full bg-slate-50 border-l border-slate-200">
                  <div className="h-full flex flex-col overflow-hidden">
                    <div className="p-3 border-b border-slate-100 bg-white shrink-0">
                      <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Live Preview (To Scale)</label>
                    </div>
                    <div className="flex-1 relative flex items-center justify-center overflow-hidden">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <LayoutFabricPreview
                          widthMm={activeWidthMm}
                          heightMm={activeHeightMm}
                          dpi={activeDpi}
                          frames={activeFrames}
                          maskUrl={activeMaskUrl}
                          maskFile={activeMaskFile}
                          snapGrid={snapGrid}
                          onFramesChange={setActiveFrames}
                          onFrameSelect={setSelectedFrameId}
                          selectedFrameId={selectedFrameId}
                        />
                      </div>
                    </div>
                    <div className="p-3 border-t border-slate-100 bg-white shrink-0 text-center">
                      <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">Areas: {activeFrames.length} &middot; {activeDpi} DPI</p>
                      <div className="flex justify-center gap-4 mt-1.5 font-bold uppercase tracking-[0.05em]">
                        <span className="flex items-center text-[8px] text-emerald-600 gap-1"><div className="w-1.5 h-1.5 rounded-sm border border-emerald-400 border-dashed"></div> Safe Area</span>
                        <span className="flex items-center text-[8px] text-rose-500 gap-1"><div className="w-1.5 h-1.5 rounded-sm border border-rose-400 border-dashed"></div> Bleed Zone</span>
                      </div>
                    </div>
                  </div>
                </div>

              </form>
            </div>

            <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/30 flex justify-end gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-tight text-slate-500 hover:bg-slate-100 hover:text-slate-700 rounded-lg transition-all"
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                type="submit"
                form="layout-form"
                disabled={isSaving || !layoutName}
                className="px-5 py-1.5 bg-indigo-600 text-white text-[11px] font-bold uppercase tracking-tight rounded-lg hover:bg-indigo-700 shadow-sm transition-all flex items-center gap-2 disabled:opacity-50 active:scale-95"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {isEditMode ? 'Update Template' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compact Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm animate-in fade-in" onClick={() => setDeleteConfirm(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-in zoom-in-95 duration-200">
            <div className="flex flex-col items-center text-center">
              <div className="w-12 h-12 bg-rose-50 text-rose-500 rounded-full flex items-center justify-center mb-4">
                <Trash2 className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-slate-900 mb-1">Delete Layout?</h3>
              <p className="text-sm text-slate-500 mb-6 leading-relaxed">
                Delete <span className="font-bold text-slate-900">&quot;{deleteConfirm}&quot;</span>? This action is permanent and affects all users.
              </p>

              <div className="flex w-full gap-2">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="flex-1 px-4 py-2 text-sm bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition-all active:scale-95"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    handleDeleteLayout(deleteConfirm);
                    setDeleteConfirm(null);
                  }}
                  className="flex-1 px-4 py-2 text-sm bg-rose-600 text-white font-bold rounded-xl hover:bg-rose-700 shadow-lg shadow-rose-200 transition-all active:scale-95"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

          {/* View Specification Modal */}
          {selectedLayout && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
              <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setSelectedLayout(null)} />
              <div className="relative bg-slate-900 rounded-3xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col border border-slate-800 animate-in zoom-in-95 duration-200">
                <div className="flex items-center justify-between p-6 border-b border-slate-800">
                  <h2 className="text-xl font-bold text-white">JSON Specification</h2>
                  <button onClick={() => setSelectedLayout(null)} className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
                  <pre className="text-indigo-400 font-mono text-xs leading-relaxed">
                    {JSON.stringify(selectedLayout, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {/* Google Fonts Picker Modal */}
          {showFontModal && (
            <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowFontModal(false)}>
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="px-6 py-4 border-b flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">Google Fonts</h3>
                  <button onClick={() => setShowFontModal(false)} className="p-1 text-slate-400 hover:text-slate-900 rounded"><X className="w-4 h-4" /></button>
                </div>
                <div className="px-6 py-3 border-b">
                  <input type="text" placeholder="Search fonts..." value={fontSearch} onChange={e => setFontSearch(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-3 space-y-1">
                  {/* System fonts — always available */}
                  {['sans-serif', 'serif', 'monospace', 'cursive'].filter(f => f.toLowerCase().includes(fontSearch.toLowerCase())).map(f => (
                    <label key={f} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50 cursor-pointer">
                      <input type="checkbox" checked={selectedFonts.includes(f)}
                        onChange={e => {
                          const next = e.target.checked ? [...selectedFonts, f] : selectedFonts.filter(x => x !== f);
                          setSelectedFonts(next);
                          saveFontsToBackend(next);
                        }}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                      <span className="text-sm text-slate-700" style={{ fontFamily: f }}>{f}</span>
                      <span className="text-[9px] text-slate-400 ml-auto uppercase">System</span>
                    </label>
                  ))}
                  {/* Google Fonts */}
                  {googleFontsList.filter(f => f.toLowerCase().includes(fontSearch.toLowerCase())).map(f => (
                    <label key={f} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50 cursor-pointer"
                      onMouseEnter={() => loadGoogleFont(f)}>
                      <input type="checkbox" checked={selectedFonts.includes(f)}
                        onChange={e => {
                          let next: string[];
                          if (e.target.checked) {
                            loadGoogleFont(f);
                            next = [...selectedFonts, f];
                          } else {
                            next = selectedFonts.filter(x => x !== f);
                          }
                          setSelectedFonts(next);
                          saveFontsToBackend(next);
                        }}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                      <span className="text-sm text-slate-700" style={{ fontFamily: fontsLoaded.has(f) ? f : 'inherit' }}>{f}</span>
                      <span className="text-[9px] text-slate-400 ml-auto uppercase">Google</span>
                    </label>
                  ))}
                </div>
                <div className="px-6 py-3 border-t bg-slate-50 flex items-center justify-between">
                  <span className="text-xs text-slate-500">
                    {selectedFonts.length} font{selectedFonts.length !== 1 ? 's' : ''} selected
                  </span>
                  {isSavingFonts && <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />}
                </div>
              </div>
            </div>
          )}
        </div>
      );
}
