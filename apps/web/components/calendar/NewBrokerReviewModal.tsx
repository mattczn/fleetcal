'use client';

import { useState } from 'react';
import { Plus, X, Mail, User, Phone, Sparkles, Loader2, AlertCircle } from 'lucide-react';
import type { Customer, CustomerContact } from '@/lib/types';
import { railway } from '@/lib/railway';

/**
 * Review-and-create dialog shown after the rate-con parser identifies a
 * broker that isn't in the customer list yet. The user fills in the
 * fields manually, OR if a rate con was provided to the modal, clicks
 * "Extract from rate con" to run the AI harvest on those bytes and
 * pre-fill contact + invoicing fields.
 *
 * Mirrors the BrokerProfileModal contact-card pattern so users see one
 * consistent shape for managing rep contacts whether they're creating
 * a customer here or editing one in the profile modal later.
 */
export interface NewBrokerReviewModalProps {
  initialName: string;
  /** The rate con in whatever form the parent has it — a base64 data
   *  URL (right after upload + parse), a Supabase signed URL (when
   *  the user re-opens an existing load), or a raw storage path.
   *  When set, the "Extract from rate con" button appears; the
   *  modal converts to base64 internally on click via fetch +
   *  arrayBuffer + bufferToBase64. */
  rateConPdf?: string;
  /** Optional pre-resolved object URL for the PDF (created via
   *  URL.createObjectURL in the parent). When present, prefer
   *  fetching from this URL over the rateConPdf path — same trick
   *  used by handleFullReparse to avoid double-fetching the blob
   *  the parent has already paged into memory. */
  pdfObjectUrl?: string;
  accentColor?: string;
  onCancel:    () => void;
  onConfirm:   (payload: Omit<Customer, 'id'>) => Promise<void> | void;
}

export function NewBrokerReviewModal({
  initialName, rateConPdf, pdfObjectUrl, accentColor = '#0369a1', onCancel, onConfirm,
}: NewBrokerReviewModalProps) {
  const ACCENT = accentColor;

  const [name,                setName]                = useState(initialName);
  const [shortName,           setShortName]           = useState('');
  const [contacts,            setContacts]            = useState<CustomerContact[]>([]);
  const [invoiceMethod,       setInvoiceMethod]       = useState<'' | 'email' | 'portal'>('');
  const [invoiceEmail,        setInvoiceEmail]        = useState('');
  const [invoicePortal,       setInvoicePortal]       = useState('');
  const [invoiceInstructions, setInvoiceInstructions] = useState('');
  const [busy, setBusy] = useState(false);

  // Rate-con AI harvest state.
  const [extracting,    setExtracting]    = useState(false);
  const [extractError,  setExtractError]  = useState<string | null>(null);
  const [extracted,     setExtracted]     = useState(false);

  // Per-contact two-step delete confirmation, matching the
  // BrokerProfileModal behavior — single click arms, second click
  // commits. Reset to null on every state mutation that isn't the
  // confirm itself.
  const [confirmDeleteContactId, setConfirmDeleteContactId] = useState<string | null>(null);

  const trimmedName = name.trim();
  const canCreate   = trimmedName.length > 0 && !busy;

  /** Resolve the parent-provided rateConPdf (data URL, signed URL, or
   *  storage path) into raw base64 the harvest endpoint expects.
   *  Mirrors the bufferToBase64 + fetch pattern in EventModal's
   *  handleFullReparse. Chunked encoding because spreading a Uint8Array
   *  into String.fromCharCode hits the JS arg limit on PDFs over ~100 KB. */
  const resolvePdfBase64 = async (): Promise<string> => {
    if (!rateConPdf) throw new Error('no rate con available');
    // Fast path: caller already has a data URL — strip the prefix.
    if (rateConPdf.startsWith('data:')) return rateConPdf.split(',')[1];
    // Otherwise fetch the bytes. Prefer the pre-resolved object URL
    // when the parent created one (avoids a second roundtrip to
    // Supabase storage); fall back to the raw value.
    const src = pdfObjectUrl || rateConPdf;
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000; // 32 KB — safely under any spread limit
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  };

  /** Extract invoicing + contact fields from the rate-con PDF and
   *  drop them into form state. Doesn't blow away anything the user
   *  has already typed — only fills empty fields. */
  const handleExtract = async () => {
    if (!rateConPdf || extracting) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const pdfBase64 = await resolvePdfBase64();
      const res = await railway.harvestRateConFromPdf({ pdfBase64 });
      const p = res.parsed;

      // Invoicing fields — only set if currently empty so re-running
      // the extract doesn't overwrite manual edits.
      if (!invoiceMethod && (p.invoiceMethod === 'email' || p.invoiceMethod === 'portal')) {
        setInvoiceMethod(p.invoiceMethod);
      }
      if (!invoiceEmail.trim()        && p.invoiceEmail)        setInvoiceEmail(p.invoiceEmail);
      if (!invoicePortal.trim()       && p.invoicePortal)       setInvoicePortal(p.invoicePortal);
      if (!invoiceInstructions.trim() && p.invoiceInstructions) setInvoiceInstructions(p.invoiceInstructions);

      // Contact — append a new card if the user has no contacts yet
      // AND the harvest found any contact info. Don't merge into
      // existing entries; the user's already-typed contacts are
      // intentional.
      const hasContactSignal = p.contactName || p.contactEmail || p.contactPhone;
      if (contacts.length === 0 && hasContactSignal) {
        setContacts([{
          id:    crypto.randomUUID(),
          name:  p.contactName  ?? undefined,
          email: p.contactEmail ?? undefined,
          phone: p.contactPhone ?? undefined,
        }]);
      }

      setExtracted(true);
    } catch (err) {
      setExtractError(`Extract failed: ${(err as Error)?.message ?? 'unknown'}`);
    } finally {
      setExtracting(false);
    }
  };

  async function handleConfirm() {
    if (!canCreate) return;
    setBusy(true);
    try {
      // Strip empty contacts (all three fields blank) and trim each
      // remaining field so persisted data isn't littered with
      // half-finished entries. Mirrors BrokerProfileModal's save.
      const cleanContacts = contacts
        .map(c => ({
          id:    c.id,
          name:  c.name?.trim()  || undefined,
          email: c.email?.trim() || undefined,
          phone: c.phone?.trim() || undefined,
        }))
        .filter(c => c.name || c.email || c.phone);

      // Legacy single-contact mirror — some older code paths still
      // read customer.contactName/email/phone. Seed from the first
      // contact so they stay in sync. Drops to undefined if the user
      // didn't add any contacts.
      const primary = cleanContacts[0];

      await onConfirm({
        name:                trimmedName,
        aliases:             [],
        contacts:            cleanContacts,
        shortName:           shortName.trim()             || undefined,
        contactName:         primary?.name                || undefined,
        contactEmail:        primary?.email               || undefined,
        contactPhone:        primary?.phone               || undefined,
        invoiceMethod:       invoiceMethod                || undefined,
        invoiceEmail:        invoiceMethod === 'email'  ? (invoiceEmail.trim()  || undefined) : undefined,
        invoicePortal:       invoiceMethod === 'portal' ? (invoicePortal.trim() || undefined) : undefined,
        invoiceInstructions: invoiceInstructions.trim()  || undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="flex flex-col overflow-hidden"
        style={{
          background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)',
          width: 600, maxHeight: '90vh',
          border: '1px solid var(--gc-border-light)',
          // Single border-radius on the wrapper. With `overflow-hidden`
          // the footer's borderTop and the form body's bottom edge
          // both clip to the rounded corners — without this the
          // footer rendered square-cornered against the wrapper.
          borderRadius: 16,
        }}>
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-start gap-3">
            <div style={{ background: '#f0f9ff', borderRadius: 10, padding: 8, flexShrink: 0 }}>
              <Plus size={18} style={{ color: ACCENT }} />
            </div>
            <div>
              <div className="text-base font-semibold mb-0.5" style={{ color: 'var(--gc-text-1)' }}>
                Review new customer
              </div>
              <div className="text-xs" style={{ color: 'var(--gc-text-2)' }}>
                Add this customer to your directory.
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
            <Input value={name} onChange={setName} placeholder="Customer name" autoFocus accent={ACCENT} />
          </Field>

          <Field label="Nickname" hint="Shortened name or abbreviation for the customer.">
            <Input value={shortName} onChange={setShortName} placeholder="e.g. UBR" accent={ACCENT} />
          </Field>

          {/* Contacts — same pattern as BrokerProfileModal so the UX
              matches what users see when editing later. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-extrabold uppercase tracking-wider"
                style={{ color: 'var(--gc-text-1)' }}>
                Contacts
              </span>
              <button type="button"
                onClick={() => {
                  setConfirmDeleteContactId(null);
                  setContacts(cs => [...cs, { id: crypto.randomUUID() }]);
                }}
                className="text-[11px] font-bold flex items-center gap-1 px-2 py-1 rounded-md transition-colors"
                style={{ color: ACCENT, background: 'transparent', border: `1px solid ${ACCENT}40`, cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = `${ACCENT}10`)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Plus size={11} /> Add contact
              </button>
            </div>
            {contacts.length === 0 ? (
              <div className="text-[12px] px-3 py-3 rounded-md" style={{
                color: 'var(--gc-text-3)',
                background: 'var(--gc-bg)',
                border: '1px dashed var(--gc-border)',
              }}>
                No contacts yet. Click <strong>Add contact</strong> to log a rep.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {contacts.map((c, idx) => (
                  <div key={c.id} className="rounded-md p-2.5"
                    style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border)' }}>
                    <div className="grid grid-cols-3 gap-2">
                      <Field label="Name" icon={<User size={11} />}>
                        <Input value={c.name ?? ''} placeholder="Full name…"
                          onChange={v => setContacts(cs => cs.map((x, i) => i === idx ? { ...x, name: v } : x))}
                          accent={ACCENT} />
                      </Field>
                      <Field label="Email" icon={<Mail size={11} />}>
                        <Input value={c.email ?? ''} placeholder="email@customer.com" type="email"
                          onChange={v => setContacts(cs => cs.map((x, i) => i === idx ? { ...x, email: v } : x))}
                          accent={ACCENT} />
                      </Field>
                      <Field label="Phone" icon={<Phone size={11} />}>
                        <div className="flex items-center gap-1">
                          <Input value={c.phone ?? ''} placeholder="(555) 555-5555" type="tel"
                            onChange={v => setContacts(cs => cs.map((x, i) => i === idx ? { ...x, phone: v } : x))}
                            accent={ACCENT} />
                          {(() => {
                            const confirming = confirmDeleteContactId === c.id;
                            return (
                              <button type="button"
                                title={confirming ? 'Click again to confirm' : 'Remove contact'}
                                onClick={() => {
                                  if (confirming) {
                                    setContacts(cs => cs.filter((_, i) => i !== idx));
                                    setConfirmDeleteContactId(null);
                                  } else {
                                    setConfirmDeleteContactId(c.id);
                                  }
                                }}
                                className="flex items-center justify-center rounded-md transition-colors px-2"
                                style={{
                                  minWidth: 28, height: 28,
                                  color: confirming ? '#fff' : 'var(--gc-text-3)',
                                  background: confirming ? '#b91c1c' : 'transparent',
                                  border: `1px solid ${confirming ? '#b91c1c' : 'var(--gc-border)'}`,
                                  cursor: 'pointer', flexShrink: 0,
                                  fontSize: 11, fontWeight: 800,
                                  whiteSpace: 'nowrap',
                                }}
                                onMouseEnter={e => {
                                  if (confirming) return;
                                  e.currentTarget.style.background = '#fee2e2';
                                  e.currentTarget.style.color = '#b91c1c';
                                  e.currentTarget.style.borderColor = '#fecaca';
                                }}
                                onMouseLeave={e => {
                                  if (confirming) return;
                                  e.currentTarget.style.background = 'transparent';
                                  e.currentTarget.style.color = 'var(--gc-text-3)';
                                  e.currentTarget.style.borderColor = 'var(--gc-border)';
                                }}>
                                {confirming ? 'Confirm' : <X size={12} />}
                              </button>
                            );
                          })()}
                        </div>
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Invoice settings */}
          <div className="pt-2" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <div className="flex items-center justify-between mt-3 mb-1.5">
              <div className="text-[11px] font-extrabold uppercase tracking-wider"
                style={{ color: 'var(--gc-text-1)' }}>
                Invoice settings
              </div>
              {/* AI harvest button — only when the modal was opened from a
                  rate-con parse path that handed us the PDF bytes. Pulls
                  invoiceMethod / email / portal / instructions + the
                  first rep contact off the document into empty form
                  fields (won't overwrite user edits). */}
              {rateConPdf && (
                <button type="button"
                  onClick={() => void handleExtract()}
                  disabled={extracting}
                  className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md transition-colors disabled:opacity-60"
                  style={{
                    color:      ACCENT,
                    background: `${ACCENT}0d`,
                    border:     `1px solid ${ACCENT}40`,
                    cursor:     extracting ? 'wait' : 'pointer',
                  }}
                  title="Extract invoicing instructions + rep contact from this rate con">
                  {extracting
                    ? <Loader2 size={10} className="animate-spin" />
                    : <Sparkles size={10} />}
                  {extracting ? 'Extracting…' : extracted ? 'Re-extract' : 'Extract from rate con'}
                </button>
              )}
            </div>
            {extractError && (
              <div className="flex items-start gap-1.5 mb-2 px-2 py-1.5 rounded-md text-[11px]"
                style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                <AlertCircle size={11} style={{ marginTop: 1, flexShrink: 0 }} />
                {extractError}
              </div>
            )}
            <div className="flex gap-1.5 mb-2">
              {(['email', 'portal'] as const).map(m => {
                const active = invoiceMethod === m;
                return (
                  <button key={m} type="button"
                    onClick={() => setInvoiceMethod(active ? '' : m)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                    style={{
                      border: `1px solid ${active ? ACCENT : 'var(--gc-border)'}`,
                      background: active ? `${ACCENT}10` : 'transparent',
                      color: active ? ACCENT : 'var(--gc-text-2)',
                      cursor: 'pointer',
                    }}>
                    {m === 'email' ? 'Email' : 'Online portal'}
                  </button>
                );
              })}
            </div>
            {invoiceMethod === 'email' ? (
              <Field label="Billing email" icon={<Mail size={11} />}>
                <Input value={invoiceEmail} onChange={setInvoiceEmail} placeholder="ap@customer.com" accent={ACCENT} type="email" />
              </Field>
            ) : invoiceMethod === 'portal' ? (
              <Field label="Portal">
                <Input value={invoicePortal} onChange={setInvoicePortal} placeholder="TriumphPay (https://...)" accent={ACCENT} />
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
                  onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
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
            style={{ background: canCreate ? ACCENT : 'var(--gc-border)', cursor: canCreate ? 'pointer' : 'default' }}>
            {busy ? 'Creating…' : 'Create customer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, icon, hint, children }: {
  label:    string;
  icon?:    React.ReactNode;
  hint?:    string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--gc-text-1)' }}>
        {icon}{label}
      </label>
      {children}
      {hint && (
        <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function Input({ value, onChange, placeholder, type, autoFocus, accent }: {
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  type?:        string;
  autoFocus?:   boolean;
  accent:       string;
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
