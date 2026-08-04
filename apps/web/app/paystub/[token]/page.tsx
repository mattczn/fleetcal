'use client';

/**
 * Public paystub view. Token in the URL = auth (drivers don't have
 * Clerk accounts). Client-rendered so the middleware public-route
 * pass-through works without any server-side auth entanglement.
 *
 * All heavy work lives in the Railway public endpoint
 * (/v1/public/paystubs/:token). This file is a thin fetcher +
 * printable layout. "Save as PDF" uses window.print() — mobile Safari
 * and Android Chrome both surface Save-to-Files/Download from the
 * print dialog, no third-party PDF lib needed. The layout below has
 * matching @media print rules so the printed page looks like the
 * on-screen one minus the buttons.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

const API_BASE =
  process.env.NEXT_PUBLIC_RAILWAY_URL ?? 'https://fleetcalapi-production.up.railway.app';

interface LineItem {
  kind:     'load' | 'adjustment' | 'accessorial';
  id?:      string;
  amount:   number;
  label?:   string;
  date?:    string;
  loadNum?: string;
  legLabel?: string;
  category?: string;
}

interface Paystub {
  id:              string;
  driverName:      string;
  weekStart:       string;
  weekEndInclusive:string;
  totalPay:        number;
  finalizedAt:     string;
  finalizedByName: string | null;
  notes:           string | null;
  lineItems:       LineItem[];
  orgLabel:        string;
  supersededAt:    string | null;
}

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    // Force UTC so week_start (a date string) renders the same regardless
    // of the viewer's timezone — otherwise Sun 6/22 shows as Sat 6/21 for
    // anyone west of Denver.
    timeZone: iso.length === 10 ? 'UTC' : undefined,
  });
};

const fmtSentTs = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

export default function PaystubPage() {
  const params = useParams<{ token: string }>();
  const token  = params.token;

  const [paystub, setPaystub] = useState<Paystub | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetch(`${API_BASE}/v1/public/paystubs/${token}`, { cache: 'no-store' })
      .then(async r => {
        if (!alive) return;
        if (r.status === 404) { setError('This paystub link is invalid or has expired.'); setLoading(false); return; }
        if (!r.ok) { setError(`Couldn't load paystub (${r.status}).`); setLoading(false); return; }
        const json = await r.json() as { paystub: Paystub };
        setPaystub(json.paystub);
        setLoading(false);
      })
      .catch(err => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Network error.');
        setLoading(false);
      });
    return () => { alive = false; };
  }, [token]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-50 text-neutral-500 text-sm">
        Loading paystub…
      </main>
    );
  }

  if (error || !paystub) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="max-w-md text-center px-6">
          <div className="text-4xl mb-4">🔒</div>
          <h1 className="text-lg font-semibold text-neutral-900 mb-2">Paystub not available</h1>
          <p className="text-sm text-neutral-600">{error ?? 'Not found.'}</p>
          <p className="text-xs text-neutral-500 mt-4">If you think this is a mistake, ask dispatch to resend.</p>
        </div>
      </main>
    );
  }

  const superseded = paystub.supersededAt != null;

  return (
    <main className="min-h-screen bg-neutral-50 py-6 px-4 md:py-10 print:py-0 print:px-0 print:bg-white">
      {/* Print rules: hide the "Save as PDF" button + the footer nudge,
          and drop the page background so the paystub card fills the
          printed page without a colored margin around it. */}
      <style jsx global>{`
        @media print {
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="bg-white rounded-t-2xl border border-neutral-200 border-b-0 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                {paystub.orgLabel} · Paystub
              </div>
              <h1 className="mt-1 text-2xl font-bold text-neutral-900">{paystub.driverName}</h1>
              <div className="mt-1 text-sm text-neutral-600">
                Week of {fmtDate(paystub.weekStart)} – {fmtDate(paystub.weekEndInclusive)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              className="shrink-0 print:hidden text-sm font-medium px-3 py-2 rounded-lg border border-neutral-300 bg-white hover:bg-neutral-50 text-neutral-700"
            >
              Save as PDF
            </button>
          </div>

          {superseded && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
              <div className="text-sm font-semibold text-amber-900">This paystub has been corrected.</div>
              <div className="text-xs text-amber-800 mt-1">
                Dispatch will resend the corrected version. The numbers below are the ORIGINAL amounts,
                kept here as a record of what was first sent to you.
              </div>
            </div>
          )}
        </div>

        {/* Total */}
        <div className="bg-neutral-900 text-white px-6 py-5 border-x border-neutral-900">
          <div className="text-xs uppercase tracking-wider text-neutral-400">Net pay</div>
          <div className="text-4xl font-bold tabular-nums mt-1">{money(paystub.totalPay)}</div>
        </div>

        {/* Line items */}
        <div className="bg-white border border-neutral-200 border-t-0">
          {paystub.lineItems.length === 0 ? (
            <div className="p-6 text-sm text-neutral-500">
              No line-item detail available for this paystub. The total above is what was finalized for the week.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-neutral-500 border-b border-neutral-200">
                  <th className="text-left font-semibold px-6 py-3">Description</th>
                  <th className="text-left font-semibold px-6 py-3 hidden sm:table-cell">Date</th>
                  <th className="text-right font-semibold px-6 py-3">Amount</th>
                </tr>
              </thead>
              <tbody>
                {paystub.lineItems.map((li, i) => (
                  <tr key={li.id ?? i} className="border-b border-neutral-100 last:border-b-0">
                    <td className="px-6 py-3">
                      <div className="text-neutral-900">
                        {li.label ?? (li.kind === 'load' ? `Load ${li.loadNum ?? ''}` : li.kind)}
                      </div>
                      {/* Loads always show a Legs sub-line ("Legs: All" for
                          single-leg, "Legs: Pickup" / "Legs: Transfer" etc.
                          for relay legs). Adjustments + accessorials use
                          the category label. */}
                      {li.kind === 'load' ? (
                        <div className="text-xs text-neutral-500 mt-0.5">
                          Legs: {li.legLabel ?? 'All'}
                        </div>
                      ) : li.category ? (
                        <div className="text-xs text-neutral-500 mt-0.5">
                          {li.category}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-6 py-3 text-neutral-600 hidden sm:table-cell">
                      {li.date ? fmtDate(li.date) : ''}
                    </td>
                    <td className={`px-6 py-3 text-right tabular-nums font-medium ${li.amount < 0 ? 'text-red-600' : 'text-neutral-900'}`}>
                      {li.amount < 0 ? '−' : ''}{money(Math.abs(li.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-neutral-50 font-semibold">
                  <td className="px-6 py-3 text-neutral-900">Total</td>
                  <td className="hidden sm:table-cell" />
                  <td className="px-6 py-3 text-right tabular-nums text-neutral-900">{money(paystub.totalPay)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Notes + footer */}
        {paystub.notes && (
          <div className="bg-white border-x border-b border-neutral-200 px-6 py-4">
            <div className="text-xs uppercase tracking-wider text-neutral-500 font-semibold mb-1">Notes</div>
            <div className="text-sm text-neutral-700 whitespace-pre-wrap">{paystub.notes}</div>
          </div>
        )}

        <div className="bg-white rounded-b-2xl border-x border-b border-neutral-200 px-6 py-4 text-xs text-neutral-500">
          Finalized {fmtSentTs(paystub.finalizedAt)}
          {paystub.finalizedByName ? ` by ${paystub.finalizedByName}` : ''}.
        </div>

        <div className="text-center text-xs text-neutral-400 mt-6 print:hidden">
          Questions about your pay? Contact dispatch.
        </div>
      </div>
    </main>
  );
}
