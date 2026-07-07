'use client';

/**
 * /expenses/cards — Ramp card-transaction board.
 *
 * Physically moved out of the Equipment page's tab set into its own
 * route under /expenses. The old /equipment?tab=cardspend URL 301s
 * here via a client-side effect on the equipment page.
 *
 * Delegates its table + filter UI to CardSpendTabContent (which is now
 * co-located under app/equipment/ for historical reasons — kept there
 * because moving the file would churn the working sync tests without
 * a functional gain). This page fetches assets + trailers and hands
 * them to the shared component.
 */

import { useEffect, useMemo, useState } from 'react';
import { CreditCard } from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { railway } from '@/lib/railway';
import type { Asset } from '@/lib/types';
import CardSpendTabContent from '../../equipment/CardSpendTabContent';

interface Trailer { id: number; name: string; trailerNumber?: string; category: string }

function CardsPageInner() {
  const [assets, setAssets]     = useState<Asset[]>([]);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [err, setErr]           = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [a, t] = await Promise.all([
          railway.listAssets(),
          railway.listTrailers(),
        ]);
        if (cancelled) return;
        setAssets(a.assets as Asset[]);
        setTrailers(t.trailers as unknown as Trailer[]);
      } catch (e) {
        if (cancelled) return;
        console.error('[expenses/cards] fixtures fetch failed:', e);
        setErr('Failed to load equipment list.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const assetLabelById = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of assets) m.set(a.id, a.name);
    return m;
  }, [assets]);

  const trailerLabelById = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of trailers) m.set(t.id, t.trailerNumber ? `#${t.trailerNumber}` : t.name);
    return m;
  }, [trailers]);

  return (
    <AppShell>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full px-6 py-6" style={{ maxWidth: 1400 }}>
          <div className="mb-5 flex items-center gap-2">
            <CreditCard size={20} strokeWidth={2.2} style={{ color: 'var(--gc-text-2)' }} />
            <h1 className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Card Spend
            </h1>
          </div>
          {err && (
            <div className="rounded-lg border p-4 mb-4 text-sm"
                 style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
              {err}
            </div>
          )}
          <CardSpendTabContent
            assets={assets}
            trailers={trailers}
            assetLabelById={assetLabelById}
            trailerLabelById={trailerLabelById}
          />
        </div>
      </div>
    </AppShell>
  );
}

export default function CardsPage() {
  return (
    <RequireCap cap="expenses.access" module="expenses">
      <CardsPageInner />
    </RequireCap>
  );
}
