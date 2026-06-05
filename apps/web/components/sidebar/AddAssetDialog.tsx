'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { PRESET_COLORS } from '@/lib/asset-colors';

const INPUT = 'w-full px-3 py-2 rounded-lg text-sm outline-none transition-all';
const INPUT_STYLE = { border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' };

export default function AddAssetDialog({ onClose }: { onClose: () => void }) {
  const { addAsset, assetCategories } = useCalendarStore();
  const [name,  setName]  = useState('');
  const [unit,  setUnit]  = useState('');
  const [truck, setTruck] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [type,  setType]  = useState(() => assetCategories[0] ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    addAsset({ name: name.trim(), color, type, unit: unit.trim() || undefined, truck: truck.trim() || undefined, hidden: false, sortOrder: 0 });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full flex flex-col"
        style={{ background: 'var(--gc-surface)', maxWidth: 576, borderRadius: 12, boxShadow: 'var(--shadow-3)', overflow: 'hidden' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-7 py-5"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}
        >
          <span className="text-base font-medium" style={{ color: 'var(--gc-text-1)' }}>
            Add truck
          </span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-5 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
              Name *
            </label>
            <input autoFocus type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Truck 107 or John D." className={INPUT} style={INPUT_STYLE} required
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
                Unit #
              </label>
              <input type="text" value={unit} onChange={e => setUnit(e.target.value)}
                placeholder="e.g. 2028" className={INPUT} style={INPUT_STYLE}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
                Type
              </label>
              <select value={type} onChange={e => setType(e.target.value)}
                className={INPUT} style={INPUT_STYLE}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}>
                {assetCategories.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
              Color
            </label>
            <div className="grid grid-cols-10 gap-2">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className="w-7 h-7 rounded-full transition-all"
                  style={{
                    background: c,
                    outline: color === c ? `3px solid ${c}` : '3px solid transparent',
                    outlineOffset: 2,
                    transform: color === c ? 'scale(1.1)' : 'scale(1)',
                  }}
                />
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="px-5 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ color: 'var(--gc-blue)' }}
              onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
              onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
              Cancel
            </button>
            <button type="submit" disabled={!name.trim()}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-colors"
              style={{ background: 'var(--gc-blue)' }}
              onMouseOver={e => { if (name.trim()) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
              onMouseOut={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
              Add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
