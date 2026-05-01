'use client';

import { useRef, useState } from 'react';
import { Upload, Plus, Loader2, Check, X, ChevronDown } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { PRESET_COLORS } from '@/lib/asset-colors';
import type { ParsedAsset } from '@/app/api/onboarding/parse-assets/route';

type Tab = 'manual' | 'csv';

const CATEGORIES = ['OTR', 'Local', 'Dedicated', 'Regional'];

const INPUT: React.CSSProperties = {
  border: '1px solid var(--gc-border)',
  borderRadius: 8,
  padding: '9px 12px',
  fontSize: 14,
  color: 'var(--gc-text-1)',
  outline: 'none',
  background: 'var(--gc-surface)',
  width: '100%',
  boxSizing: 'border-box',
};

// ─── Manual Tab ───────────────────────────────────────────────────────────────

function ManualTab({ onAdded }: { onAdded: () => void }) {
  const { addAsset, assetCategories } = useCalendarStore();
  const cats = assetCategories.length ? assetCategories : CATEGORIES;
  const [name,    setName]    = useState('');
  const [unit,    setUnit]    = useState('');
  const [truck,   setTruck]   = useState('');
  const [type,    setType]    = useState(cats[0]);
  const [color,   setColor]   = useState(PRESET_COLORS[0]);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    addAsset({ name: name.trim(), unit: unit.trim() || undefined, truck: truck.trim() || undefined, type, color, hidden: false, sortOrder: 0 });
    await new Promise(r => setTimeout(r, 600));
    setSaving(false); setSaved(true);
    setTimeout(() => { setSaved(false); setName(''); setUnit(''); setTruck(''); onAdded(); }, 800);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-medium" style={{ color: 'var(--gc-text-3)' }}>Asset Name *</label>
          <input style={INPUT} placeholder="e.g. Truck 42 or John D." value={name} onChange={e => setName(e.target.value)}
            onFocus={e => (e.currentTarget.style.borderColor = color)}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-medium" style={{ color: 'var(--gc-text-3)' }}>Unit #</label>
          <input style={INPUT} placeholder="e.g. 42" value={unit} onChange={e => setUnit(e.target.value)}
            onFocus={e => (e.currentTarget.style.borderColor = color)}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-medium" style={{ color: 'var(--gc-text-3)' }}>Truck</label>
          <input style={INPUT} placeholder="e.g. 2024 Freightliner" value={truck} onChange={e => setTruck(e.target.value)}
            onFocus={e => (e.currentTarget.style.borderColor = color)}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-medium" style={{ color: 'var(--gc-text-3)' }}>Category</label>
          <div className="relative">
            <select style={{ ...INPUT, appearance: 'none', paddingRight: 32, cursor: 'pointer' }}
              value={type} onChange={e => setType(e.target.value)}>
              {cats.map(c => <option key={c}>{c}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--gc-text-3)' }} />
          </div>
        </div>
      </div>

      {/* Color picker */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium" style={{ color: 'var(--gc-text-3)' }}>Color</label>
        <div className="flex flex-wrap gap-2">
          {PRESET_COLORS.slice(0, 12).map(c => (
            <button key={c} onClick={() => setColor(c)}
              className="rounded-full transition-transform"
              style={{
                width: 24, height: 24, background: c, border: 'none',
                outline: color === c ? `3px solid ${c}` : '2px solid transparent',
                outlineOffset: 2, transform: color === c ? 'scale(1.2)' : 'scale(1)',
              }} />
          ))}
        </div>
      </div>

      <button
        onClick={save}
        disabled={!name.trim() || saving || saved}
        className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-[14px] font-semibold text-white mt-1"
        style={{ background: saved ? '#16a34a' : color, opacity: !name.trim() ? 0.5 : 1, transition: 'background 300ms' }}
      >
        {saving ? <Loader2 size={15} className="animate-spin" /> : saved ? <><Check size={15} /> Added!</> : <><Plus size={15} /> Add Asset</>}
      </button>
    </div>
  );
}

// ─── CSV Tab ──────────────────────────────────────────────────────────────────

interface ParsedRow extends ParsedAsset { selected: boolean; color: string }

function CsvTab({ onImported }: { onImported: () => void }) {
  const { addAsset } = useCalendarStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading,  setLoading]  = useState(false);
  const [rows,     setRows]     = useState<ParsedRow[]>([]);
  const [error,    setError]    = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  const handleFile = async (file: File) => {
    setError(null); setRows([]);
    setLoading(true);
    const text = await file.text();
    try {
      const res  = await fetch('/api/onboarding/parse-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csvContent: text }),
      });
      const json = await res.json() as { assets?: ParsedAsset[]; error?: string };
      if (json.error) { setError(json.error); return; }
      setRows((json.assets ?? []).map((a, i) => ({
        ...a,
        selected: true,
        color: PRESET_COLORS[i % PRESET_COLORS.length],
      })));
    } catch { setError('Failed to parse CSV. Please try again.'); }
    finally { setLoading(false); }
  };

  const toggle = (i: number) => setRows(r => r.map((row, j) => j === i ? { ...row, selected: !row.selected } : row));
  const changeColor = (i: number, c: string) => setRows(r => r.map((row, j) => j === i ? { ...row, color: c } : row));

  const importSelected = () => {
    rows.filter(r => r.selected).forEach(r => {
      addAsset({ name: r.name, unit: r.unit, truck: r.truck, type: r.type ?? 'OTR', color: r.color, hidden: false, notes: r.notes, sortOrder: 0 });
    });
    setImported(true);
    setTimeout(onImported, 600);
  };

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div
          className="border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3 py-10 cursor-pointer transition-colors"
          style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-bg)' }}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--gc-blue)'; }}
          onDragLeave={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--gc-border)'; const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        >
          {loading
            ? <Loader2 size={24} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
            : <Upload size={24} style={{ color: 'var(--gc-text-3)' }} />}
          <div className="text-center">
            <p className="text-[14px] font-medium" style={{ color: 'var(--gc-text-1)' }}>
              {loading ? 'Analyzing your CSV...' : 'Drop your CSV here or click to browse'}
            </p>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              Export your trucks, drivers, or fleet list from any system
            </p>
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        {error && <p className="text-[13px] text-center" style={{ color: 'var(--gc-red)' }}>{error}</p>}
      </div>
    );
  }

  const selectedCount = rows.filter(r => r.selected).length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px]" style={{ color: 'var(--gc-text-2)' }}>
        AI found <strong>{rows.length}</strong> assets. Select the ones to import and assign colors.
      </p>
      <div className="overflow-y-auto rounded-xl" style={{ maxHeight: 260, border: '1px solid var(--gc-border)' }}>
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5"
            style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--gc-border-light)' : 'none', background: row.selected ? 'var(--gc-surface)' : 'var(--gc-bg)', opacity: row.selected ? 1 : 0.5 }}>
            <input type="checkbox" checked={row.selected} onChange={() => toggle(i)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium truncate" style={{ color: 'var(--gc-text-1)' }}>{row.name}</p>
              <p className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>{[row.unit && `#${row.unit}`, row.truck, row.type].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="flex gap-1 shrink-0">
              {PRESET_COLORS.slice(0, 6).map(c => (
                <button key={c} onClick={() => changeColor(i, c)}
                  className="rounded-full"
                  style={{ width: 16, height: 16, background: c, border: 'none', outline: row.color === c ? `2px solid ${c}` : '1px solid transparent', outlineOffset: 1 }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={importSelected}
        disabled={selectedCount === 0 || imported}
        className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-[14px] font-semibold text-white"
        style={{ background: imported ? '#16a34a' : 'var(--gc-blue)', opacity: selectedCount === 0 ? 0.5 : 1 }}
      >
        {imported ? <><Check size={15} /> Imported!</> : `Import ${selectedCount} Asset${selectedCount !== 1 ? 's' : ''}`}
      </button>
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function SetupWizard() {
  const { completeOnboarding } = useOnboardingStore();
  const [tab, setTab] = useState<Tab>('manual');
  const [addedCount, setAddedCount] = useState(0);

  const handleAdded = () => setAddedCount(c => c + 1);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className="flex flex-col rounded-2xl overflow-hidden" style={{ width: 520, background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)' }}>

        {/* Header */}
        <div className="px-6 py-5" style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <h2 className="text-[17px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>Add your first asset</h2>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>Add trucks, drivers, or units one by one or import from a CSV.</p>
        </div>

        {/* Tabs */}
        <div className="flex" style={{ borderBottom: '1px solid var(--gc-border)' }}>
          {(['manual', 'csv'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className="flex-1 py-3 text-[13px] font-medium transition-colors"
              style={{
                color:        tab === t ? 'var(--gc-blue)' : 'var(--gc-text-3)',
                borderBottom: tab === t ? '2px solid var(--gc-blue)' : '2px solid transparent',
                background:   'transparent',
              }}>
              {t === 'manual' ? 'Add Manually' : 'Import from CSV'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-6 py-5" style={{ minHeight: 280 }}>
          {tab === 'manual'
            ? <ManualTab onAdded={handleAdded} />
            : <CsvTab onImported={handleAdded} />}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: '1px solid var(--gc-border)' }}>
          <span className="text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
            {addedCount > 0 ? `${addedCount} asset${addedCount !== 1 ? 's' : ''} added` : 'You can add more later in Settings'}
          </span>
          <button
            onClick={completeOnboarding}
            className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
            style={{ border: '1px solid var(--gc-border)', color: addedCount > 0 ? 'var(--gc-blue)' : 'var(--gc-text-2)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {addedCount > 0 ? 'Done →' : 'Skip for now'}
          </button>
        </div>
      </div>
    </div>
  );
}
