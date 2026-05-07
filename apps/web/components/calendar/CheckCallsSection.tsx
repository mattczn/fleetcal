'use client';

import { useEffect, useState } from 'react';
import { Phone, MessageSquare, Mail, FileText, Plus, Trash2, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { CheckCall, CheckCallChannel, CheckCallParty } from '@fleetcal/types';

interface Props {
  loadId: string;
  currentUserName: string;
  /** Color used for the "Log" button — usually the asset's color. */
  accentColor?: string;
}

const CHANNEL_LABEL: Record<CheckCallChannel, string> = {
  call:  'Call',
  text:  'Text',
  email: 'Email',
  note:  'Note',
};

const CHANNEL_ICON: Record<CheckCallChannel, typeof Phone> = {
  call:  Phone,
  text:  MessageSquare,
  email: Mail,
  note:  FileText,
};

const PARTY_LABEL: Record<CheckCallParty, string> = {
  driver:   'Driver',
  broker:   'Customer',
  shipper:  'Shipper',
  receiver: 'Receiver',
};

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function fmtAbsolute(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

export default function CheckCallsSection({ loadId, currentUserName, accentColor = '#1a73e8' }: Props) {
  const [calls,    setCalls]    = useState<CheckCall[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  // Form state
  const [channel,     setChannel]     = useState<CheckCallChannel>('call');
  const [withParty,   setWithParty]   = useState<CheckCallParty>('driver');
  const [body,        setBody]        = useState('');
  const [nextCheckAt, setNextCheckAt] = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    railway.listCheckCalls(loadId)
      .then(res => { if (!cancelled) setCalls(res.checkCalls); })
      .catch(err => console.error('listCheckCalls:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadId]);

  const submit = async () => {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await railway.createCheckCall(loadId, {
        channel,
        withParty,
        body: body.trim(),
        byName: currentUserName,
        nextCheckAt: nextCheckAt ? new Date(nextCheckAt).toISOString() : undefined,
      });
      setCalls(prev => [res.checkCall, ...prev]);
      setBody('');
      setNextCheckAt('');
      setFormOpen(false);
    } catch (err) {
      console.error('createCheckCall:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    const prev = calls;
    setCalls(c => c.filter(x => x.id !== id));
    setConfirmDeleteId(null);
    try { await railway.deleteCheckCall(id); }
    catch (err) {
      console.error('deleteCheckCall:', err);
      setCalls(prev); // rollback
    }
  };

  const visible = expanded ? calls : calls.slice(0, 3);

  return (
    <div style={{ borderTop: '1px solid var(--gc-border-light)', padding: '12px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <Phone size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
        <span style={{ color: 'var(--gc-text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>
          Check Calls
        </span>
        <span style={{ color: 'var(--gc-text-3)' }}>({calls.length})</span>
        <button
          type="button"
          onClick={() => setFormOpen(o => !o)}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: accentColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <Plus size={12} /> Log call
        </button>
      </div>

      {/* Compose form */}
      {formOpen && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={channel}
              onChange={e => setChannel(e.target.value as CheckCallChannel)}
              style={selectStyle}
            >
              {(Object.keys(CHANNEL_LABEL) as CheckCallChannel[]).map(c => (
                <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
              ))}
            </select>
            <span style={{ alignSelf: 'center', fontSize: 11, color: 'var(--gc-text-3)' }}>with</span>
            <select
              value={withParty}
              onChange={e => setWithParty(e.target.value as CheckCallParty)}
              style={selectStyle}
            >
              {(Object.keys(PARTY_LABEL) as CheckCallParty[]).map(p => (
                <option key={p} value={p}>{PARTY_LABEL[p]}</option>
              ))}
            </select>
          </div>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Driver picked up on time, no issues. ETA 14:30."
            rows={2}
            style={{
              fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--gc-border)',
              background: 'var(--gc-surface)', color: 'var(--gc-text-1)', resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>Next check (optional)</label>
            <input
              type="datetime-local"
              value={nextCheckAt}
              onChange={e => setNextCheckAt(e.target.value)}
              style={{ fontSize: 11, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
            />
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={() => { setFormOpen(false); setBody(''); setNextCheckAt(''); }}
                style={{ fontSize: 11, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!body.trim() || submitting}
                style={{
                  fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 6,
                  border: 'none', background: accentColor, color: '#fff',
                  cursor: body.trim() && !submitting ? 'pointer' : 'default',
                  opacity: body.trim() && !submitting ? 1 : 0.5,
                }}
              >
                {submitting ? 'Saving…' : 'Log'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {!loading && calls.length === 0 && !formOpen && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--gc-text-3)' }}>No check calls logged.</div>
      )}

      {visible.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visible.map(call => {
            const Icon = CHANNEL_ICON[call.channel];
            return (
              <div key={call.id} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.45 }}>
                <Icon size={13} style={{ color: 'var(--gc-text-3)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, color: 'var(--gc-text-1)' }}>{call.byName}</span>
                    <span style={{ color: 'var(--gc-text-3)' }}>·</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--gc-text-2)', background: 'var(--gc-bg)', padding: '1px 6px', borderRadius: 4 }}>
                      {CHANNEL_LABEL[call.channel]} → {PARTY_LABEL[call.withParty]}
                    </span>
                    <span style={{ color: 'var(--gc-text-3)', fontSize: 11 }} title={fmtAbsolute(call.ts)}>
                      {fmtRelative(call.ts)}
                    </span>
                    {call.nextCheckAt && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#1a73e8', background: '#e8f0fe', padding: '1px 7px', borderRadius: 4 }}>
                        <Clock size={10} />
                        Next: {fmtAbsolute(call.nextCheckAt)}
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'var(--gc-text-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 1 }}>
                    {call.body}
                  </div>
                </div>
                {confirmDeleteId === call.id ? (
                  <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>Delete?</span>
                    <button
                      type="button"
                      onClick={() => remove(call.id)}
                      style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fee2e2'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#fef2f2'; }}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-2)' }}
                      onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; }}
                      onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; }}
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(call.id)}
                    title="Delete entry"
                    style={{ alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {calls.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded(x => !x)}
          style={{ marginTop: 8, fontSize: 11, color: 'var(--gc-blue)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? 'Show less' : `Show all (${calls.length})`}
        </button>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  fontSize: 11, padding: '4px 8px', borderRadius: 6,
  border: '1px solid var(--gc-border)',
  background: 'var(--gc-surface)', color: 'var(--gc-text-1)', cursor: 'pointer',
};
