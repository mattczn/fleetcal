'use client';

/**
 * LifecycleEditor — shared component for editing an entity's
 * active_from / active_to dates. Used by AssetsModal + DriversModal
 * (and trailers whenever a modal exists for them). Mirrors the
 * existing modal field style.
 *
 * Behavior:
 *   - Active from is required (entity has to start sometime). Defaults
 *     to whatever's stored; falls back to today if missing.
 *   - Retire date is optional. Empty input = currently active. Setting
 *     a date retires; clearing a previously-set date un-retires.
 *   - Validates: retire date must be >= active from. Inline error chip
 *     when violated; Save disabled.
 *   - Save button only enabled when something actually changed.
 *   - Optimistic save via the store action passed in; no spinner UI —
 *     parent rolls back on error if needed.
 *
 * Why a separate component vs inline in both modals: keeps the date
 * validation + dirty-state + save-button logic in one place. Asset
 * and driver lifecycles are semantically identical.
 */
import { useEffect, useState } from 'react';

interface Props {
  /** Initial active-from date as YYYY-MM-DD; if missing/blank, defaults to today. */
  activeFrom?: string;
  /** Initial retire date as YYYY-MM-DD or null/undefined (= currently active). */
  activeTo?: string | null;
  /** Colored accent used for the Save button + focus borders.
   *  Asset modals pass the asset's color; driver modals pass blue. */
  accent: string;
  /** Save handler — gets only the changed fields. Caller is the store
   *  action (updateAsset / updateDriver), which does optimistic + API. */
  onSave: (changes: { activeFrom?: string; activeTo?: string | null }) => void;
  /** Optional gate — when false, inputs render disabled. */
  canEdit?: boolean;
}

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function LifecycleEditor({ activeFrom, activeTo, accent, onSave, canEdit = true }: Props) {
  const initialFrom = activeFrom ?? todayKey();
  const initialTo   = activeTo ?? '';

  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate,   setToDate]   = useState(initialTo);

  // Re-sync when the parent's props change (e.g. switching between
  // assets in the modal sidebar).
  useEffect(() => { setFromDate(initialFrom); }, [initialFrom]);
  useEffect(() => { setToDate(initialTo); },     [initialTo]);

  const dirty = fromDate !== initialFrom || toDate !== initialTo;
  const invalid = !!toDate && toDate < fromDate;
  const canSave = canEdit && dirty && !invalid && !!fromDate;

  const inputStyle: React.CSSProperties = {
    width:        '100%',
    padding:      '9px 12px',
    fontSize:     14,
    border:       '1px solid var(--gc-border)',
    borderRadius: 6,
    background:   'var(--gc-surface)',
    color:        'var(--gc-text-1)',
    outline:      'none',
    transition:   'border-color 120ms',
  };
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => (e.currentTarget.style.borderColor = accent);
  const onBlur  = (e: React.FocusEvent<HTMLInputElement>) => (e.currentTarget.style.borderColor = 'var(--gc-border)');

  function save() {
    if (!canSave) return;
    const changes: { activeFrom?: string; activeTo?: string | null } = {};
    if (fromDate !== initialFrom) changes.activeFrom = fromDate;
    if (toDate !== initialTo)     changes.activeTo   = toDate === '' ? null : toDate;
    onSave(changes);
  }

  return (
    <div className="mt-8 pt-6" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--gc-text-3)' }}>
        Lifecycle
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
            Active from
          </label>
          <input
            type="date"
            value={fromDate}
            disabled={!canEdit}
            onChange={(e) => setFromDate(e.target.value)}
            onFocus={onFocus}
            onBlur={onBlur}
            style={inputStyle}
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
            Retire date
          </label>
          <input
            type="date"
            value={toDate}
            disabled={!canEdit}
            onChange={(e) => setToDate(e.target.value)}
            onFocus={onFocus}
            onBlur={onBlur}
            style={inputStyle}
          />
          <div className="mt-1.5 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
            {toDate ? `Retired on ${toDate}` : 'Leave blank if currently active'}
          </div>
        </div>
      </div>

      {invalid && (
        <div className="mt-3 text-[12px]" style={{ color: '#d93025' }}>
          Retire date must be on or after Active from.
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-opacity"
          style={{ background: canSave ? accent : 'var(--gc-text-3)', opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'not-allowed' }}
        >
          Save dates
        </button>
        {dirty && !invalid && (
          <button
            type="button"
            onClick={() => { setFromDate(initialFrom); setToDate(initialTo); }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
