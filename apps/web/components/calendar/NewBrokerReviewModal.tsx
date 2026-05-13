'use client';

import { useState } from 'react';
import { Plus, X, Mail } from 'lucide-react';
import type { Customer } from '@/lib/types';
import type { BrokerProfile } from '@/lib/prompt';
import { cleanBrokerName } from '@/lib/brokerName';

/**
 * Review-and-create dialog shown after the rate-con parser identifies a
 * broker that isn't in the customer list yet. Fields are pre-filled from
 * the pass-1 harvest so the user just confirms / edits — no manual entry.
 *
 * The form intentionally stays compact — short name, notes, parse hints,
 * etc. live in the broker profile and can be edited there after creation.
 */
export interface NewBrokerReviewModalProps {
  initialName: string;
  profile?:    BrokerProfile;
  accentColor?: string;
  onCancel:    () => void;
  onConfirm:   (payload: Omit<Customer, 'id'>) => Promise<void> | void;
}

export function NewBrokerReviewModal({
  initialName, profile, accentColor = '#0369a1', onCancel, onConfirm,
}: NewBrokerReviewModalProps) {
  // Only auto-fill from the profile when its broker name matches what we
  // were given (cleaned-suffix variations match too). Otherwise the user
  // typed a name unrelated to the parse and we don't want to mix data.
  const cleanedParsed = profile?.name ? cleanBrokerName(profile.name) : '';
  const sameBroker = !!profile?.name && (
    profile.name.toLowerCase() === initialName.toLowerCase() ||
    cleanedParsed.toLowerCase() === initialName.toLowerCase()
  );
  const seed = sameBroker ? profile : undefined;

  const [name,                setName]                = useState(initialName);
  const [shortName,           setShortName]           = useState('');
  const [contactName,         setContactName]         = useState(seed?.contactName         ?? '');
  const [contactEmail,        setContactEmail]        = useState(seed?.contactEmail        ?? '');
  const [contactPhone,        setContactPhone]        = useState(seed?.contactPhone        ?? '');
  const [invoiceMethod,       setInvoiceMethod]       = useState<'' | 'email' | 'portal'>(
    seed?.invoiceMethod === 'email' ? 'email' : seed?.invoiceMethod === 'portal' ? 'portal' : '',
  );
  const [invoiceEmail,        setInvoiceEmail]        = useState(seed?.invoiceEmail        ?? '');
  const [invoicePortal,       setInvoicePortal]       = useState(seed?.invoicePortal       ?? '');
  const [invoiceInstructions, setInvoiceInstructions] = useState(seed?.invoiceInstructions ?? '');
  const [busy, setBusy] = useState(false);

  const trimmedName = name.trim();
  const canCreate   = trimmedName.length > 0 && !busy;

  async function handleConfirm() {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onConfirm({
        name:                trimmedName,
        aliases:             [],
        contacts:            [],
        shortName:           shortName.trim()            || undefined,
        contactName:         contactName.trim()          || undefined,
        contactEmail:        contactEmail.trim()         || undefined,
        contactPhone:        contactPhone.trim()         || undefined,
        invoiceMethod:       invoiceMethod || undefined,
        invoiceEmail:        invoiceMethod === 'email'  ? (invoiceEmail.trim()  || undefined) : undefined,
        invoicePortal:       invoiceMethod === 'portal' ? (invoicePortal.trim() || undefined) : undefined,
        invoiceInstructions: invoiceInstructions.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="rounded-2xl flex flex-col"
        style={{
          background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)',
          width: 600, maxHeight: '90vh', border: '1px solid var(--gc-border-light)',
        }}>
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-start gap-3">
            <div style={{ background: '#f0f9ff', borderRadius: 10, padding: 8, flexShrink: 0 }}>
              <Plus size={18} style={{ color: '#0369a1' }} />
            </div>
            <div>
              <div className="text-base font-semibold mb-0.5" style={{ color: 'var(--gc-text-1)' }}>
                Review new customer
              </div>
              <div className="text-xs" style={{ color: 'var(--gc-text-2)' }}>
                {sameBroker
                  ? 'Auto-filled from this rate-con. Edit anything below, then create.'
                  : 'Add this customer to your directory.'}
              </div>
            </div>
          </div>
          <button onClick={() => !busy && onCancel()}
            className="p-1 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <Field label="Name">
            <Input value={name} onChange={setName} placeholder="Customer name" autoFocus accent={accentColor} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Short name">
              <Input value={shortName} onChange={setShortName} placeholder="Echo" accent={accentColor} />
            </Field>
            <Field label="Contact name">
              <Input value={contactName} onChange={setContactName} placeholder="—" accent={accentColor} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact email">
              <Input value={contactEmail} onChange={setContactEmail} placeholder="—" accent={accentColor} type="email" />
            </Field>
            <Field label="Contact phone">
              <Input value={contactPhone} onChange={setContactPhone} placeholder="—" accent={accentColor} type="tel" />
            </Field>
          </div>

          {/* Invoice routing */}
          <div className="pt-2" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1 mt-3"
              style={{ color: 'var(--gc-text-1)' }}>
              Invoice routing
            </div>
            <div className="flex gap-1.5 mb-2">
              {(['email', 'portal'] as const).map(m => {
                const active = invoiceMethod === m;
                return (
                  <button key={m} type="button"
                    onClick={() => setInvoiceMethod(active ? '' : m)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                    style={{
                      border: `1px solid ${active ? accentColor : 'var(--gc-border)'}`,
                      background: active ? `${accentColor}10` : 'transparent',
                      color: active ? accentColor : 'var(--gc-text-2)',
                      cursor: 'pointer',
                    }}>
                    {m === 'email' ? 'Email' : 'Online portal'}
                  </button>
                );
              })}
            </div>
            {invoiceMethod === 'email' ? (
              <Field label="Billing email" icon={<Mail size={11} />}>
                <Input value={invoiceEmail} onChange={setInvoiceEmail} placeholder="ap@customer.com" accent={accentColor} type="email" />
              </Field>
            ) : invoiceMethod === 'portal' ? (
              <Field label="Portal">
                <Input value={invoicePortal} onChange={setInvoicePortal} placeholder="TriumphPay (https://...)" accent={accentColor} />
              </Field>
            ) : null}
            <div className="mt-3">
              <Field label="Other billing notes">
                <textarea value={invoiceInstructions} onChange={e => setInvoiceInstructions(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg outline-none text-sm"
                  style={{
                    border: '1px solid var(--gc-border)', padding: '8px 10px',
                    color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
                    resize: 'vertical', lineHeight: '1.5', fontFamily: 'inherit',
                  }}
                  onFocus={e => (e.currentTarget.style.borderColor = accentColor)}
                  onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
              </Field>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-6 py-3"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <button onClick={() => !busy && onCancel()}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ color: 'var(--gc-text-2)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            disabled={busy}>
            Cancel
          </button>
          <button onClick={handleConfirm}
            disabled={!canCreate}
            className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors"
            style={{ background: canCreate ? accentColor : 'var(--gc-border)', cursor: canCreate ? 'pointer' : 'default' }}>
            {busy ? 'Creating…' : 'Create customer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--gc-text-1)' }}>
        {icon}{label}
      </label>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type, autoFocus, accent }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  accent: string;
}) {
  return (
    <input type={type ?? 'text'} value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder} autoFocus={autoFocus}
      className="w-full rounded-lg outline-none text-sm"
      style={{
        border: '1px solid var(--gc-border)', padding: '8px 10px',
        color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
      }}
      onFocus={e => (e.currentTarget.style.borderColor = accent)}
      onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
  );
}
