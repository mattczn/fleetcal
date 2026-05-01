'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import type { Asset } from '@/lib/types';

import { PRESET_COLORS } from '@/lib/asset-colors';

const INPUT = 'w-full px-3 py-2 rounded-lg text-sm outline-none transition-all';
const INPUT_STYLE = { border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' };
const LABEL = 'block text-[11px] font-semibold uppercase tracking-wider mb-1.5';

export default function EditAssetDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const { updateAsset, assetCategories } = useCalendarStore();
  const [name,  setName]  = useState(asset.name);
  const [unit,  setUnit]  = useState(asset.unit ?? '');
  const [truck, setTruck] = useState(asset.truck ?? '');
  const [color, setColor] = useState(asset.color);
  const [type,  setType]  = useState(asset.type);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    updateAsset(asset.id, {
      name:  name.trim(),
      unit:  unit.trim()  || undefined,
      truck: truck.trim() || undefined,
      color,
      type,
    });
    onClose();
  };

  const focus = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) =>
    (e.currentTarget.style.borderColor = color);
  const blur = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) =>
    (e.currentTarget.style.borderColor = 'var(--gc-border)');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-sm flex flex-col"
        style={{ background: 'var(--gc-surface)', borderRadius: 12, boxShadow: 'var(--shadow-3)', overflow: 'hidden' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: `3px solid ${color}`, background: `${color}16` }}
        >
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider mb-0.5" style={{ color }}>
              Edit Asset
            </div>
            <div className="text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>
              {asset.name}{asset.unit ? ` #${asset.unit}` : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">

          {/* Name + Unit side by side */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={LABEL} style={{ color: 'var(--gc-text-3)' }}>Asset Name *</label>
              <input
                autoFocus
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Eagle"
                className={INPUT}
                style={INPUT_STYLE}
                required
                onFocus={focus}
                onBlur={blur}
              />
            </div>
            <div>
              <label className={LABEL} style={{ color: 'var(--gc-text-3)' }}>Asset # (Unit)</label>
              <input
                type="text"
                value={unit}
                onChange={e => setUnit(e.target.value)}
                placeholder="e.g. 2024"
                className={INPUT}
                style={INPUT_STYLE}
                onFocus={focus}
                onBlur={blur}
              />
            </div>
          </div>

          {/* Truck + Type side by side */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={LABEL} style={{ color: 'var(--gc-text-3)' }}>Truck</label>
              <input
                type="text"
                value={truck}
                onChange={e => setTruck(e.target.value)}
                placeholder="e.g. 2024 Freightliner"
                className={INPUT}
                style={INPUT_STYLE}
                onFocus={focus}
                onBlur={blur}
              />
            </div>
            <div>
              <label className={LABEL} style={{ color: 'var(--gc-text-3)' }}>Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value as Asset['type'])}
                className={INPUT}
                style={{ ...INPUT_STYLE, cursor: 'pointer' }}
                onFocus={focus}
                onBlur={blur}
              >
                {assetCategories.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Color */}
          <div>
            <label className={LABEL} style={{ color: 'var(--gc-text-3)' }}>Color</label>
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
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 rounded-full text-sm font-medium transition-colors"
              style={{ color: 'var(--gc-blue)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="px-5 py-2 rounded-full text-sm font-medium text-white disabled:opacity-40 transition-colors"
              style={{ background: color }}
              onMouseEnter={e => { if (name.trim()) e.currentTarget.style.opacity = '0.88'; }}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
