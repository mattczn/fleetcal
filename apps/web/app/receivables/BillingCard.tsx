'use client';

/**
 * BillingCard — how this broker wants to be invoiced, editable in place.
 *
 * Same four fields BrokerProfileModal owns (routing, destination,
 * billing address, broker-wide notes) and the same
 * refresh-from-rate-con action, because the person chasing a payment is
 * usually the person who just discovered the billing email is wrong, and
 * making them open a second modal to fix it is how it stays wrong.
 *
 * Edits go through PATCH /v1/customers/:id — the same endpoint the modal
 * uses — so there is still one writer. Nothing saves until Save is
 * pressed; the refresh button only populates the fields, matching the
 * modal's behaviour, so an unreadable rate con can't silently overwrite
 * good data.
 */

import { useEffect, useState } from 'react';
import {
  Mail, MapPin, StickyNote, ExternalLink, RefreshCw, Check, Loader2, Pencil, X, Percent,
} from 'lucide-react';
import { railway } from '@/lib/railway';
import { usePermissions } from '@/lib/usePermissions';

export interface BillingCardValues {
  invoiceMethod?:  'email' | 'portal';
  invoiceEmail?:   string;
  invoicePortal?:  string;
  billingAddress?: string;
  billingNotes?:   string;
  /** Fraction withheld under a quick-pay agreement (0.025 = 2.5%). */
  quickPayRate?:   number;
}

export interface BillingCardProps {
  customerId?: string;
  values:      BillingCardValues;
  /** Re-fetch the page after a successful save. */
  onSaved:     () => void;
}

/** Portal values are stored bare ("app.triumphpay.com") as often as not,
 *  so a link needs the scheme put back before it will navigate. */
function href(portal: string): string {
  return /^https?:\/\//i.test(portal) ? portal : `https://${portal}`;
}

export default function BillingCard({ customerId, values, onSaved }: BillingCardProps) {
  const { can } = usePermissions();
  const editable = can('customers.edit') && !!customerId;

  const [editing, setEditing] = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err,     setErr]     = useState<string | null>(null);
  const [note,    setNote]    = useState<string | null>(null);

  const [method,  setMethod]  = useState<'email' | 'portal' | ''>('');
  const [email,   setEmail]   = useState('');
  const [portal,  setPortal]  = useState('');
  const [address, setAddress] = useState('');
  const [notes,   setNotes]   = useState('');
  /** Held as the PERCENT withheld, as a string — that is how the agreement
   *  reads ("2.50% discount") and what someone types. Converted on save. */
  const [qpPct,   setQpPct]   = useState('');

  // Reset the draft whenever the underlying record changes or the form
  // is opened, so a stale edit can't survive a refetch.
  useEffect(() => {
    setMethod(values.invoiceMethod ?? '');
    setEmail(values.invoiceEmail ?? '');
    setPortal(values.invoicePortal ?? '');
    setAddress(values.billingAddress ?? '');
    setNotes(values.billingNotes ?? '');
    setQpPct(values.quickPayRate != null ? String(+(values.quickPayRate * 100).toFixed(4)) : '');
  }, [values, editing]);

  async function save() {
    if (!customerId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await railway.updateCustomer(customerId, {
        invoiceMethod:       method || null,
        invoiceEmail:        email.trim()   || null,
        invoicePortal:       portal.trim()  || null,
        billingAddress:      address.trim() || null,
        invoiceInstructions: notes.trim()   || null,
        // null ENDS the arrangement. An out-of-range value is rejected by
        // the API rather than silently coerced, so a typo can't become a
        // rate that quietly settles short payments.
        quickPayRate: qpPct.trim() === '' ? null : +(Number(qpPct) / 100).toFixed(6),
      });
      setEditing(false);
      setNote(null);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  /** Populates the form from the newest rate con on file. Deliberately
   *  does NOT save — the operator confirms what was read. */
  async function refreshFromRateCon() {
    if (!customerId || refreshing) return;
    setRefreshing(true);
    setErr(null);
    setNote(null);
    try {
      const res = await railway.refreshCustomerInvoicingFromRateCon(customerId);
      const p = res.parsed;
      if (p.invoiceMethod === 'email' || p.invoiceMethod === 'portal') setMethod(p.invoiceMethod);
      if (p.invoiceEmail)        setEmail(p.invoiceEmail);
      if (p.invoicePortal)       setPortal(p.invoicePortal);
      if (p.billingAddress)      setAddress(p.billingAddress);
      if (p.invoiceInstructions) setNotes(p.invoiceInstructions);
      setEditing(true);
      setNote(res.sourceLoadNum
        ? `Read from the rate con on load ${res.sourceLoadNum}. Review, then Save.`
        : 'Read from the latest rate con. Review, then Save.');
    } catch (e) {
      // Same three cases BrokerProfileModal distinguishes — "refresh
      // failed" alone doesn't tell an operator whether to upload a rate
      // con or just try again.
      const msg = (e as Error)?.message ?? '';
      if (/no_rate_con/i.test(msg)) {
        setErr('No rate con on file for this customer yet.');
      } else if (/rate_con_unreadable/i.test(msg)) {
        setErr("Couldn't read the latest rate con — it may be a legacy format. Re-upload it.");
      } else {
        setErr(`Refresh failed: ${msg || 'unknown error'}`);
      }
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div style={{
      flex: 'none', background: 'var(--gc-surface)',
      border: '1px solid var(--gc-border-light)', borderRadius: 14,
      boxShadow: '0 1px 2px rgba(60,64,67,.1)', padding: '12px 16px',
    }}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-wrap items-start" style={{ gap: 14 }}>
              <FieldWrap label="Invoice routing" icon={<Mail size={12} />} width={150}>
                <select value={method} onChange={e => setMethod(e.target.value as 'email' | 'portal' | '')}
                        style={input}>
                  <option value="">Not set</option>
                  <option value="email">Email</option>
                  <option value="portal">Online portal</option>
                </select>
              </FieldWrap>

              {/* Both destinations stay editable while the form is open —
                  switching routing shouldn't discard the other value. */}
              <FieldWrap label="Billing email" icon={<Mail size={12} />} width={230}>
                <input value={email} onChange={e => setEmail(e.target.value)}
                       placeholder="billing@broker.com" style={input} />
              </FieldWrap>
              <FieldWrap label="Portal" icon={<ExternalLink size={12} />} width={230}>
                <input value={portal} onChange={e => setPortal(e.target.value)}
                       placeholder="app.triumphpay.com" style={input} />
              </FieldWrap>
              <FieldWrap label="Billing address" icon={<MapPin size={12} />} width={260}>
                <textarea value={address} onChange={e => setAddress(e.target.value)}
                          rows={2} placeholder="Remit-to address" style={{ ...input, resize: 'vertical' }} />
              </FieldWrap>
              {/* Editable here as well as read-only below. It was display-only
                  at first, which meant the field simply vanished when you
                  clicked Edit — visible, apparently editable, and unreachable. */}
              <FieldWrap label="Quick pay" icon={<Percent size={12} />} width={150}>
                <div className="flex items-center gap-1.5">
                  <input value={qpPct} inputMode="decimal" placeholder="none"
                         onChange={e => setQpPct(e.target.value.replace(/[^\d.]/g, ''))}
                         style={{ ...input, textAlign: 'right' }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-text-2)' }}>%</span>
                </div>
              </FieldWrap>
              <FieldWrap label="Billing notes" icon={<StickyNote size={12} />} grow>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                          rows={2} placeholder="Broker-wide billing policy — terms, required docs, factoring"
                          style={{ ...input, resize: 'vertical' }} />
              </FieldWrap>
            </div>
          ) : (
            <div className="flex items-start flex-wrap" style={{ gap: 24 }}>
              <ReadField icon={values.invoiceMethod === 'portal' ? <ExternalLink size={12} /> : <Mail size={12} />}
                         label="Invoice routing">
                {values.invoiceMethod === 'portal' ? 'Online portal'
                  : values.invoiceMethod === 'email' ? 'Email'
                  : <Muted>not set</Muted>}
              </ReadField>

              {/* Only the destination matching the routing is shown — a
                  stale email under a portal broker is a trap. */}
              <ReadField icon={<Mail size={12} />}
                         label={values.invoiceMethod === 'portal' ? 'Portal' : 'Billing email'}>
                {values.invoiceMethod === 'portal'
                  ? (values.invoicePortal
                      ? <a href={href(values.invoicePortal)} target="_blank" rel="noopener noreferrer"
                           className="hover:underline inline-flex items-center gap-1"
                           style={{ color: 'var(--gc-blue-text)' }}>
                          {values.invoicePortal} <ExternalLink size={11} />
                        </a>
                      : <Muted>no portal on file</Muted>)
                  : (values.invoiceEmail
                      ? <a href={`mailto:${values.invoiceEmail}`} className="hover:underline"
                           style={{ color: 'var(--gc-blue-text)' }}>{values.invoiceEmail}</a>
                      : <Muted>no billing email on file</Muted>)}
              </ReadField>

              {/* Read-only here; edited in the broker profile alongside the
                  rest of the billing terms. Shown even when unset, because
                  an unset rate on a broker who takes a discount is the
                  thing that quietly builds an uncollectable balance. */}
              <ReadField icon={<Percent size={12} />} label="Quick pay">
                {values.quickPayRate != null
                  ? <span>
                      {+(values.quickPayRate * 100).toFixed(4)}% withheld
                      <span style={{ color: 'var(--gc-text-3)' }}>
                        {' · '}pays {+(100 - values.quickPayRate * 100).toFixed(4)}%
                      </span>
                    </span>
                  : <Muted>no arrangement</Muted>}
              </ReadField>

              <ReadField icon={<MapPin size={12} />} label="Billing address">
                {values.billingAddress
                  ? <span style={{ whiteSpace: 'pre-line' }}>{values.billingAddress}</span>
                  : <Muted>not set</Muted>}
              </ReadField>

              <ReadField icon={<StickyNote size={12} />} label="Billing notes" grow>
                {values.billingNotes
                  ? <span style={{ whiteSpace: 'pre-line' }}>{values.billingNotes}</span>
                  : <Muted>none</Muted>}
              </ReadField>
            </div>
          )}
        </div>

        {editable && (
          <div className="flex items-center gap-2" style={{ flex: 'none' }}>
            <button onClick={() => void refreshFromRateCon()} disabled={refreshing || busy}
              className="inline-flex items-center gap-1.5 disabled:opacity-60"
              style={btn}
              title="Re-read invoicing details from the newest rate con on file">
              {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Refresh from rate con
            </button>
            {editing ? (
              <>
                <button onClick={() => { setEditing(false); setErr(null); setNote(null); }}
                  disabled={busy} className="inline-flex items-center gap-1.5" style={btn}>
                  <X size={12} /> Cancel
                </button>
                <button onClick={() => void save()} disabled={busy}
                  className="inline-flex items-center gap-1.5 disabled:opacity-60"
                  style={{ ...btn, background: '#1a73e8', color: '#fff', borderColor: '#1a73e8' }}>
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
                </button>
              </>
            ) : (
              <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5" style={btn}>
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>
        )}
      </div>

      {note && (
        <div className="mt-2 text-[11.5px]" style={{ color: '#137333' }}>{note}</div>
      )}
      {err && (
        <div className="mt-2 text-[11.5px]" style={{ color: '#c5221f' }}>{err}</div>
      )}
    </div>
  );
}

// ── bits ──────────────────────────────────────────────────────────────

const input: React.CSSProperties = {
  width: '100%', padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--gc-border)', background: 'var(--gc-surface)',
  color: 'var(--gc-text-1)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
};

const btn: React.CSSProperties = {
  height: 28, padding: '0 10px', border: '1px solid var(--gc-border)',
  borderRadius: 8, background: 'var(--gc-surface)',
  fontSize: 11.5, fontWeight: 700, color: 'var(--gc-text-2)',
};

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--gc-text-3)' }}>{children}</span>;
}

function Label({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5" style={{
      fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '.06em', color: 'var(--gc-text-3)',
    }}>
      {icon}{label}
    </div>
  );
}

function ReadField({ icon, label, children, grow }: {
  icon: React.ReactNode; label: string; children: React.ReactNode; grow?: boolean;
}) {
  return (
    <div style={{ minWidth: 0, flex: grow ? 1 : 'none', maxWidth: grow ? undefined : 320 }}>
      <Label icon={icon} label={label} />
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gc-text-2)', marginTop: 2 }}>
        {children}
      </div>
    </div>
  );
}

function FieldWrap({ icon, label, children, width, grow }: {
  icon: React.ReactNode; label: string; children: React.ReactNode;
  width?: number; grow?: boolean;
}) {
  return (
    <div style={{ width: grow ? undefined : width, flex: grow ? 1 : 'none', minWidth: grow ? 220 : undefined }}>
      <Label icon={icon} label={label} />
      <div style={{ marginTop: 3 }}>{children}</div>
    </div>
  );
}
