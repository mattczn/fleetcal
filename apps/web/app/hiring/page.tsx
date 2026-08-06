'use client';

/**
 * /hiring — applicant pipeline and onboarding paperwork.
 *
 * One table, one action per row. The interesting button is "Hire & issue
 * agreement": it creates the driver record, issues the contractor agreement
 * against it, and returns a signing link in a single call — separating those
 * steps is how you end up with a driver who exists but never got an agreement.
 *
 * Applicants are not driver rows until they're hired. Someone you're still
 * screening has no business appearing in dispatch's assignment dropdowns.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  UserPlus, Link2, MessageSquare, FileCheck2, Loader2, Check, X, Inbox,
} from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { railway, type HiringApplicant } from '@/lib/railway';

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  new:       { label: 'New',       className: 'bg-slate-100 text-slate-700' },
  screening: { label: 'Screening', className: 'bg-amber-100 text-amber-800' },
  offered:   { label: 'Offered',   className: 'bg-blue-100 text-blue-800' },
  hired:     { label: 'Hired',     className: 'bg-emerald-100 text-emerald-800' },
  rejected:  { label: 'Rejected',  className: 'bg-slate-100 text-slate-500' },
};

const EMPTY_FORM = {
  firstName: '', lastName: '', phone: '', email: '',
  address: '', cdlClass: '', position: '', startDate: '', notes: '',
};

function HiringPage() {
  const [applicants, setApplicants] = useState<HiringApplicant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    try {
      const { applicants: rows } = await railway.listApplicants();
      setApplicants(rows);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load applicants.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) return;
    setSaving(true);
    try {
      await railway.createApplicant(form);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that applicant.');
    } finally {
      setSaving(false);
    }
  }

  async function handleHire(applicant: HiringApplicant) {
    if (!applicant.start_date) {
      setError(`${applicant.first_name} needs a start date — it becomes the agreement's effective date.`);
      return;
    }
    setBusyId(applicant.id);
    setError('');
    try {
      await railway.hireApplicant(applicant.id);
      await load();
      setToast('Agreement issued. Copy or text the link.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not issue the agreement.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCopy(applicant: HiringApplicant) {
    if (!applicant.contract) return;
    await navigator.clipboard.writeText(applicant.contract.signingUrl);
    setCopiedId(applicant.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  async function handleText(applicant: HiringApplicant) {
    setBusyId(applicant.id);
    setError('');
    try {
      const res = await railway.sendApplicantContract(applicant.id);
      setToast(`Texted the link to ${res.to}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the text.');
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--gc-text)' }}>Hiring</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--gc-text-muted)' }}>
            Applicants, and the contractor agreement they sign before their first load.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
          style={{ background: 'var(--gc-accent, #1a73e8)' }}
        >
          {showForm ? <X className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
          {showForm ? 'Cancel' : 'Add applicant'}
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {toast && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {toast}
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mb-6 rounded-xl border p-5"
          style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {([
              ['firstName', 'First name *', 'text'],
              ['lastName', 'Last name *', 'text'],
              ['phone', 'Mobile (for the signing link)', 'tel'],
              ['email', 'Email', 'email'],
              ['address', 'Mailing address', 'text'],
              ['startDate', 'Start date (agreement effective date)', 'date'],
            ] as const).map(([key, label, type]) => (
              <label key={key} className="block">
                <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--gc-text-muted)' }}>
                  {label}
                </span>
                <input
                  type={type}
                  value={form[key]}
                  onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text)' }}
                />
              </label>
            ))}
          </div>
          <button
            type="submit"
            disabled={saving}
            className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: 'var(--gc-accent, #1a73e8)' }}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save applicant
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--gc-border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--gc-surface-2, #f8fafc)' }}>
              {['Applicant', 'Contact', 'Start date', 'Status', 'Agreement', ''].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--gc-text-muted)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-10 text-center" style={{ color: 'var(--gc-text-muted)' }}>
                <Loader2 className="mx-auto h-5 w-5 animate-spin" />
              </td></tr>
            )}

            {!loading && !applicants.length && (
              <tr><td colSpan={6} className="px-4 py-12 text-center" style={{ color: 'var(--gc-text-muted)' }}>
                <Inbox className="mx-auto mb-2 h-6 w-6 opacity-50" />
                No applicants yet. Add one to start onboarding.
              </td></tr>
            )}

            {applicants.map((a) => {
              const status = STATUS_STYLE[a.status] ?? STATUS_STYLE.new;
              const contract = a.contract;
              const busy = busyId === a.id;

              return (
                <tr key={a.id} className="border-t" style={{ borderColor: 'var(--gc-border)' }}>
                  <td className="px-4 py-3">
                    <div className="font-semibold" style={{ color: 'var(--gc-text)' }}>
                      {a.first_name} {a.last_name}
                    </div>
                    {a.position && (
                      <div className="text-xs" style={{ color: 'var(--gc-text-muted)' }}>{a.position}</div>
                    )}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--gc-text-muted)' }}>
                    <div>{a.phone || '—'}</div>
                    <div className="text-xs">{a.email || ''}</div>
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--gc-text-muted)' }}>
                    {a.start_date || <span className="text-amber-600">Not set</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${status.className}`}>
                      {status.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {!contract && <span style={{ color: 'var(--gc-text-muted)' }}>—</span>}
                    {contract?.status === 'sent' && (
                      <span className="text-xs font-semibold text-amber-700">Awaiting signature</span>
                    )}
                    {contract?.status === 'signed' && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                        <FileCheck2 className="h-3.5 w-3.5" />
                        Signed {contract.signed_at ? new Date(contract.signed_at).toLocaleDateString() : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {!contract && (
                        <button
                          onClick={() => handleHire(a)}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                          style={{ background: 'var(--gc-accent, #1a73e8)' }}
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                          Hire &amp; issue agreement
                        </button>
                      )}
                      {contract && contract.status !== 'signed' && (
                        <>
                          <button
                            onClick={() => handleCopy(a)}
                            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold"
                            style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text)' }}
                          >
                            {copiedId === a.id ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
                            {copiedId === a.id ? 'Copied' : 'Copy link'}
                          </button>
                          <button
                            onClick={() => handleText(a)}
                            disabled={busy || !a.phone}
                            title={a.phone ? '' : 'No mobile number on file'}
                            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                            style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text)' }}
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
                            Text link
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <RequireCap cap="hiring.access" module="hiring">
      <AppShell>
        <HiringPage />
      </AppShell>
    </RequireCap>
  );
}
