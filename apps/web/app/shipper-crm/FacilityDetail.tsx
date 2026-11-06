'use client';

/**
 * FacilityDetail — the right-side drawer for one facility.
 *
 * Three jobs stacked: (1) what we've done here — visit/load stats + the
 * actual loads; (2) where outreach stands — status, follow-up date,
 * contact, notes; (3) the reach-out log — one click to record a call /
 * email / note, with the timeline underneath. Everything writes through
 * the shipper-crm endpoints, which create the stored row on first touch, so
 * a brand-new facility (no row yet) is editable the moment it's opened.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  X, Phone, Mail, StickyNote, Users as MeetingIcon, ArrowRight, Clock,
  MapPin, Loader2, Check, Truck,
} from 'lucide-react';
import { railway } from '@/lib/railway';
import {
  FACILITY_STATUSES, FACILITY_STATUS_LABEL,
  FACILITY_CALL_OUTCOMES, FACILITY_CALL_OUTCOME_LABEL,
  type Facility, type FacilityActivity, type FacilityActivityKind,
  type FacilityCallOutcome, type FacilityLoad, type FacilityStatus,
  type FacilitySnapshot,
} from '@fleetcal/types';

interface Props {
  facility: Facility;
  onClose: () => void;
  onUpdated: (f: Facility) => void;
}

const STATUS_STYLE: Record<FacilityStatus, { bg: string; fg: string; dot: string }> = {
  prospect:       { bg: '#f1f3f4', fg: '#5f6368', dot: '#9aa0a6' },
  contacted:      { bg: '#e8f0fe', fg: '#1558d6', dot: '#1a73e8' },
  in_talks:       { bg: '#fef7e0', fg: '#b06000', dot: '#f9ab00' },
  active:         { bg: '#e6f4ea', fg: '#137333', dot: '#188038' },
  not_now:        { bg: '#f1f3f4', fg: '#80868b', dot: '#bdc1c6' },
  do_not_contact: { bg: '#fce8e6', fg: '#c5221f', dot: '#d93025' },
};

const ROLE_LABEL: Record<Facility['role'], string> = {
  shipper: 'Shipper', receiver: 'Receiver', both: 'Ship + receive', stop: 'Stop',
};

const money0 = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function fmtRel(s: string): string {
  const d = new Date(s).getTime();
  if (Number.isNaN(d)) return '';
  const days = Math.floor((Date.now() - d) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const KIND_ICON: Record<FacilityActivityKind, React.ComponentType<{ size?: number; style?: React.CSSProperties }>> = {
  call: Phone, email: Mail, note: StickyNote, meeting: MeetingIcon,
  status_change: ArrowRight, system: Clock,
};

export default function FacilityDetail({ facility, onClose, onUpdated }: Props) {
  const geoKey = facility.geoKey;
  const snapshot: FacilitySnapshot = {
    name: facility.name ?? null, address: facility.address ?? null,
    city: facility.city ?? null, state: facility.state ?? null,
    lat: facility.lat, lng: facility.lng,
  };

  const [fac,     setFac]     = useState<Facility>(facility);
  const [loads,   setLoads]   = useState<FacilityLoad[]>([]);
  const [acts,    setActs]    = useState<FacilityActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState<string | null>(null);

  // Outreach form (seeded from the loaded facility's stored row).
  const o = fac.outreach;
  const [status,  setStatus]  = useState<FacilityStatus>(o?.status ?? 'prospect');
  const [nextAt,  setNextAt]  = useState(o?.nextActionAt?.slice(0, 10) ?? '');
  const [cName,   setCName]   = useState(o?.contactName ?? '');
  const [cPhone,  setCPhone]  = useState(o?.contactPhone ?? '');
  const [cEmail,  setCEmail]  = useState(o?.contactEmail ?? '');
  const [notes,   setNotes]   = useState(o?.notes ?? '');
  const [savingContact, setSavingContact] = useState(false);
  const [savedContact,  setSavedContact]  = useState(false);

  // Reach-out log form.
  const [logKind,    setLogKind]    = useState<FacilityActivityKind | null>(null);
  const [logOutcome, setLogOutcome] = useState<FacilityCallOutcome>('spoke');
  const [logBody,    setLogBody]    = useState('');
  const [logging,    setLogging]    = useState(false);

  const seedForm = useCallback((f: Facility) => {
    const ou = f.outreach;
    setStatus(ou?.status ?? 'prospect');
    setNextAt(ou?.nextActionAt?.slice(0, 10) ?? '');
    setCName(ou?.contactName ?? '');
    setCPhone(ou?.contactPhone ?? '');
    setCEmail(ou?.contactEmail ?? '');
    setNotes(ou?.notes ?? '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    railway.getFacility(geoKey)
      .then((res) => {
        if (cancelled) return;
        setFac(res.facility);
        setLoads(res.loads);
        setActs(res.activities);
        seedForm(res.facility);
        setErr(null);
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load facility'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [geoKey, seedForm]);

  function applyFacility(f: Facility) {
    setFac(f);
    onUpdated(f);
  }

  async function changeStatus(next: FacilityStatus) {
    setStatus(next);
    try {
      const { facility: updated } = await railway.updateFacilityOutreach(geoKey, { snapshot, status: next });
      applyFacility(updated);
      // A status change is logged server-side; reflect it in the timeline.
      void refreshActivities();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to update status');
    }
  }

  async function saveContact() {
    setSavingContact(true);
    try {
      const { facility: updated } = await railway.updateFacilityOutreach(geoKey, {
        snapshot,
        nextActionAt: nextAt ? nextAt : null,
        contactName:  cName.trim() || null,
        contactPhone: cPhone.trim() || null,
        contactEmail: cEmail.trim() || null,
        notes:        notes.trim() || null,
      });
      applyFacility(updated);
      setSavedContact(true);
      setTimeout(() => setSavedContact(false), 1800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSavingContact(false);
    }
  }

  async function refreshActivities() {
    try {
      const res = await railway.getFacility(geoKey);
      setActs(res.activities);
    } catch { /* non-fatal */ }
  }

  async function submitLog() {
    if (!logKind) return;
    setLogging(true);
    try {
      const { activity, facility: updated } = await railway.logFacilityActivity(geoKey, {
        snapshot,
        kind: logKind,
        body: logBody.trim() || undefined,
        outcome: logKind === 'call' ? logOutcome : undefined,
      });
      setActs((prev) => [activity, ...prev]);
      applyFacility(updated);
      seedForm(updated);
      setLogKind(null);
      setLogBody('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to log');
    } finally {
      setLogging(false);
    }
  }

  const st = STATUS_STYLE[status];
  const s  = fac.stats;

  return (
    <>
      {/* scrim */}
      <div className="fixed inset-0" style={{ zIndex: 50, background: 'rgba(32,33,36,0.28)' }} onClick={onClose} />
      <div
        className="fixed right-0 top-0 bottom-0 flex flex-col"
        style={{ zIndex: 51, width: 'min(460px, 100vw)', background: 'var(--gc-surface)', boxShadow: '-8px 0 32px rgba(0,0,0,0.18)' }}
      >
        {/* ── Header ── */}
        <div className="flex items-start gap-3" style={{ padding: '16px 18px', borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="min-w-0 flex-1">
            <div className="truncate" style={{ fontSize: 17, fontWeight: 800, color: 'var(--gc-text-1)' }}>
              {fac.name || 'Unnamed facility'}
            </div>
            <div className="flex items-center gap-1.5 mt-1" style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>
              <MapPin size={12} />
              <span className="truncate">
                {[fac.address, [fac.city, fac.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—'}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 9px', background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}>
                {ROLE_LABEL[fac.role]}
              </span>
              {fac.internalGuess && (
                <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '2px 8px', background: '#fef7e0', color: '#b06000' }}>
                  Looks internal
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="grid place-items-center rounded-full" style={{ width: 30, height: 30, color: 'var(--gc-text-3)' }} title="Close">
            <X size={18} />
          </button>
        </div>

        {/* ── Scroll body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '14px 18px 24px' }}>
          {err && (
            <div style={{ borderRadius: 10, background: '#fce8e6', color: '#c5221f', fontSize: 12.5, padding: 10, marginBottom: 12 }}>{err}</div>
          )}

          {/* stats */}
          <div className="grid grid-cols-4 gap-2" style={{ marginBottom: 16 }}>
            <Stat label="Loads"     value={s.loadCount.toLocaleString()} big />
            <Stat label="Visits"    value={s.visitCount.toLocaleString()} />
            <Stat label="Pickups"   value={s.pickupCount.toLocaleString()} />
            <Stat label="Delivers"  value={s.deliveryCount.toLocaleString()} />
          </div>
          <div className="flex items-center justify-between" style={{ fontSize: 11.5, color: 'var(--gc-text-3)', marginBottom: 18 }}>
            <span>First: <b style={{ color: 'var(--gc-text-2)' }}>{fmtDate(s.firstSeen)}</b></span>
            <span>Most recent: <b style={{ color: 'var(--gc-text-2)' }}>{fmtDate(s.lastSeen)}</b></span>
          </div>

          {/* status */}
          <SectionLabel>Outreach</SectionLabel>
          <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
            <div className="relative flex-1">
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 9, height: 9, borderRadius: 999, background: st.dot }} />
              <select
                value={status}
                onChange={(e) => changeStatus(e.target.value as FacilityStatus)}
                style={{
                  width: '100%', height: 34, padding: '0 10px 0 26px', borderRadius: 8,
                  border: '1px solid var(--gc-border)', background: st.bg, color: st.fg,
                  fontSize: 12.5, fontWeight: 700, outline: 'none', cursor: 'pointer',
                }}
              >
                {FACILITY_STATUSES.map((v) => (
                  <option key={v} value={v}>{FACILITY_STATUS_LABEL[v]}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col" style={{ flex: 'none' }}>
              <input type="date" value={nextAt} onChange={(e) => setNextAt(e.target.value)} onBlur={saveContact}
                title="Follow-up date"
                style={{ height: 34, padding: '0 8px', borderRadius: 8, border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', fontSize: 12, color: 'var(--gc-text-2)', outline: 'none' }} />
            </div>
          </div>

          {/* quick log */}
          <div className="flex items-center gap-2" style={{ marginBottom: logKind ? 10 : 16 }}>
            <LogButton active={logKind === 'call'}    icon={Phone}       label="Log call"  onClick={() => setLogKind(logKind === 'call' ? null : 'call')} />
            <LogButton active={logKind === 'email'}   icon={Mail}        label="Email"     onClick={() => setLogKind(logKind === 'email' ? null : 'email')} />
            <LogButton active={logKind === 'note'}    icon={StickyNote}  label="Note"      onClick={() => setLogKind(logKind === 'note' ? null : 'note')} />
          </div>

          {logKind && (
            <div style={{ border: '1px solid var(--gc-border)', borderRadius: 10, padding: 12, marginBottom: 16, background: 'var(--gc-bg)' }}>
              {logKind === 'call' && (
                <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 10 }}>
                  {FACILITY_CALL_OUTCOMES.map((oc) => (
                    <button key={oc} onClick={() => setLogOutcome(oc)}
                      style={{
                        fontSize: 11.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                        border: '1px solid', borderColor: logOutcome === oc ? '#1a73e8' : 'var(--gc-border)',
                        background: logOutcome === oc ? '#e8f0fe' : 'var(--gc-surface)',
                        color: logOutcome === oc ? '#1558d6' : 'var(--gc-text-2)', cursor: 'pointer',
                      }}>
                      {FACILITY_CALL_OUTCOME_LABEL[oc]}
                    </button>
                  ))}
                </div>
              )}
              <textarea value={logBody} onChange={(e) => setLogBody(e.target.value)}
                placeholder={logKind === 'call' ? 'What was said? (optional)' : logKind === 'email' ? 'Email notes (optional)' : 'Note…'}
                rows={2}
                style={{ width: '100%', borderRadius: 8, border: '1px solid var(--gc-border)', padding: '8px 10px', fontSize: 12.5, color: 'var(--gc-text-1)', outline: 'none', resize: 'vertical', background: 'var(--gc-surface)' }} />
              <div className="flex items-center justify-end gap-2" style={{ marginTop: 8 }}>
                <button onClick={() => { setLogKind(null); setLogBody(''); }} style={{ fontSize: 12, fontWeight: 600, color: 'var(--gc-text-3)' }}>Cancel</button>
                <button onClick={submitLog} disabled={logging}
                  className="inline-flex items-center gap-1.5"
                  style={{ height: 30, padding: '0 14px', borderRadius: 8, background: '#1a73e8', color: '#fff', fontSize: 12, fontWeight: 700, opacity: logging ? 0.6 : 1 }}>
                  {logging ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  Save {logKind === 'call' ? 'call' : logKind === 'email' ? 'email' : 'note'}
                </button>
              </div>
            </div>
          )}

          {/* contact + notes */}
          <SectionLabel>Contact</SectionLabel>
          <div className="flex flex-col gap-2" style={{ marginBottom: 10 }}>
            <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Contact name" style={inputStyle} />
            <div className="flex gap-2">
              <input value={cPhone} onChange={(e) => setCPhone(e.target.value)} placeholder="Phone" style={{ ...inputStyle, flex: 1 }} />
              <input value={cEmail} onChange={(e) => setCEmail(e.target.value)} placeholder="Email" style={{ ...inputStyle, flex: 1 }} />
            </div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          <div className="flex items-center justify-end" style={{ marginBottom: 20 }}>
            <button onClick={saveContact} disabled={savingContact}
              className="inline-flex items-center gap-1.5"
              style={{ height: 30, padding: '0 14px', borderRadius: 8, border: '1px solid var(--gc-border)', background: savedContact ? '#e6f4ea' : 'var(--gc-surface)', color: savedContact ? '#137333' : 'var(--gc-text-2)', fontSize: 12, fontWeight: 700 }}>
              {savingContact ? <Loader2 size={13} className="animate-spin" /> : savedContact ? <Check size={13} /> : null}
              {savedContact ? 'Saved' : 'Save contact'}
            </button>
          </div>

          {/* loads */}
          <SectionLabel>{loading ? 'Loads here' : `Loads here (${loads.length})`}</SectionLabel>
          <div style={{ border: '1px solid var(--gc-border-light)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
            {loading ? (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--gc-text-3)' }} className="flex items-center gap-2">
                <Loader2 size={13} className="animate-spin" /> Loading…
              </div>
            ) : loads.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12.5, color: 'var(--gc-text-3)' }}>No loads found here.</div>
            ) : loads.slice(0, 60).map((l) => (
              <div key={l.loadId} className="flex items-center gap-2" style={{ padding: '8px 12px', borderBottom: '1px solid #f1f3f4', fontSize: 12.5 }}>
                <Truck size={13} style={{ color: 'var(--gc-text-3)', flex: 'none' }} />
                <span style={{ fontWeight: 700, color: 'var(--gc-text-1)', flex: 'none' }}>
                  {l.loadNum || (l.internalLoadId != null ? `#${l.internalLoadId}` : '—')}
                </span>
                <span className="truncate" style={{ color: 'var(--gc-text-3)', flex: 1 }}>{l.broker || ''}</span>
                <span style={{ color: 'var(--gc-text-3)', flex: 'none' }}>{fmtDate(l.visitAt)}</span>
                <span className="tabular-nums" style={{ fontWeight: 700, color: 'var(--gc-text-2)', flex: 'none', minWidth: 54, textAlign: 'right' }}>{money0(l.loadPrice)}</span>
              </div>
            ))}
            {!loading && loads.length > 60 && (
              <div style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--gc-text-3)' }}>+ {loads.length - 60} more</div>
            )}
          </div>

          {/* activity */}
          <SectionLabel>Activity</SectionLabel>
          {acts.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--gc-text-3)', padding: '6px 2px' }}>
              No outreach logged yet. Use “Log call”, “Email”, or “Note” above to start the trail.
            </div>
          ) : (
            <div className="flex flex-col gap-0">
              {acts.map((a) => {
                const Icon = KIND_ICON[a.kind] ?? Clock;
                return (
                  <div key={a.id} className="flex gap-2.5" style={{ padding: '8px 0', borderBottom: '1px solid #f1f3f4' }}>
                    <div className="grid place-items-center" style={{ width: 26, height: 26, borderRadius: 999, background: 'var(--gc-bg)', flex: 'none', color: 'var(--gc-text-2)' }}>
                      <Icon size={13} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div style={{ fontSize: 12.5, color: 'var(--gc-text-1)' }}>
                        <span style={{ fontWeight: 700 }}>{activityTitle(a)}</span>
                        {a.body ? <span style={{ color: 'var(--gc-text-2)' }}> — {a.body}</span> : null}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1 }}>{fmtRel(a.createdAt)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function activityTitle(a: FacilityActivity): string {
  if (a.kind === 'call')   return a.outcome ? `Call · ${FACILITY_CALL_OUTCOME_LABEL[a.outcome]}` : 'Call';
  if (a.kind === 'email')  return 'Email';
  if (a.kind === 'note')   return 'Note';
  if (a.kind === 'meeting') return 'Meeting';
  if (a.kind === 'status_change') {
    const to = (a.meta?.to as FacilityStatus | undefined);
    return to ? `Moved to ${FACILITY_STATUS_LABEL[to]}` : 'Status changed';
  }
  return 'Update';
}

const inputStyle: React.CSSProperties = {
  height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--gc-border)',
  background: 'var(--gc-surface)', fontSize: 12.5, color: 'var(--gc-text-1)', outline: 'none',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--gc-text-3)', marginBottom: 8 }}>
      {children}
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div style={{ background: 'var(--gc-bg)', borderRadius: 10, padding: '8px 10px' }}>
      <div className="tabular-nums" style={{ fontSize: big ? 20 : 16, fontWeight: 800, color: 'var(--gc-text-1)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gc-text-3)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function LogButton({ active, icon: Icon, label, onClick }: {
  active: boolean; icon: React.ComponentType<{ size?: number }>; label: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1.5 flex-1 justify-center"
      style={{
        height: 34, borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        border: '1px solid', borderColor: active ? '#1a73e8' : 'var(--gc-border)',
        background: active ? '#e8f0fe' : 'var(--gc-surface)', color: active ? '#1558d6' : 'var(--gc-text-2)',
      }}>
      <Icon size={14} /> {label}
    </button>
  );
}
