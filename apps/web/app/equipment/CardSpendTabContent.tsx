'use client';

/**
 * Card Spend tab — Ramp card transactions ingested by the API cron
 * (jobs/rampSyncSweep.ts) and matched to assets via memo parsing
 * (lib/rampMatcher.ts). This tab is the human-review surface: filter,
 * reassign, and mark-not-applicable.
 *
 * Curzon-only via the maintenance module gate on the API side; users
 * without that module see a 403 on the list call which we render as an
 * empty-with-hint state.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { railway } from '@/lib/railway';
import {
  OpsTable, OpsDate, OpsPill, OpsMuted,
  type OpsColumn, type OpsFilter,
} from '@/components/ui/OpsTable';
import { StyledSelect } from '@/components/ui/StyledSelect';
import type {
  RampTransaction,
  RampTransactionMatchStatus,
} from '@fleetcal/types';
import type { Asset } from '@/lib/types';
import { Receipt as ReceiptIcon } from 'lucide-react';

interface Trailer { id: number; name: string; trailerNumber?: string }

interface Props {
  assets:            Asset[];
  trailers:          Trailer[];
  assetLabelById:    Map<number, string>;
  trailerLabelById:  Map<number, string>;
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

function statusPill(s: RampTransactionMatchStatus) {
  switch (s) {
    case 'auto_matched':   return <OpsPill color="green">Auto</OpsPill>;
    case 'manual_matched': return <OpsPill color="blue">Manual</OpsPill>;
    case 'not_applicable': return <OpsPill color="gray">N/A</OpsPill>;
    case 'unmatched':      return <OpsPill color="amber">Needs review</OpsPill>;
  }
}

export default function CardSpendTabContent({
  assets, trailers, assetLabelById, trailerLabelById,
}: Props) {
  const [rows, setRows]         = useState<RampTransaction[]>([]);
  const [loading, setLoading]   = useState(false);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg]   = useState<string | null>(null);
  const [tick, setTick]         = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setFetchErr(null);
    try {
      // Rolling 60-day window matches the sync's 7-day pull comfortably
      // without dragging in ancient history the board doesn't need.
      const from = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const res = await railway.listAllRampTransactions({ from });
      setRows(res.rampTransactions);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 403) {
        setFetchErr('Card spend is part of the Maintenance module — not enabled for this org.');
      } else {
        console.error('[card-spend] load failed:', err);
        setFetchErr('Failed to load card transactions.');
      }
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload, tick]);

  const runSync = useCallback(async () => {
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const r = await railway.runRampSync();
      if (r.skipped) {
        setSyncMsg(`Skipped (${r.reason ?? 'no credentials'})`);
      } else if (r.result) {
        const { fetched, inserted, updated, autoMatched } = r.result;
        setSyncMsg(`Synced ${fetched} · ${inserted} new · ${updated} updated · ${autoMatched} auto-matched`);
        setTick(t => t + 1);
      } else {
        setSyncMsg('Sync complete');
      }
    } catch (err) {
      const detail = (err as { detail?: unknown })?.detail;
      const msg = typeof detail === 'string' ? detail : (err as Error).message;
      setSyncMsg(`Sync failed: ${msg}`);
    } finally {
      setSyncBusy(false);
    }
  }, []);

  const onAssign = useCallback(async (tx: RampTransaction, value: string) => {
    // value formats: "" (unlink), "asset:123", "trailer:456", "na" (mark N/A)
    try {
      let updated: RampTransaction;
      if (value === 'na') {
        const r = await railway.markRampTransactionNotApplicable(tx.id);
        updated = r.rampTransaction;
      } else if (value === '') {
        const r = await railway.matchRampTransaction(tx.id, { assetId: null, trailerId: null });
        updated = r.rampTransaction;
      } else if (value.startsWith('asset:')) {
        const assetId = Number(value.slice(6));
        const r = await railway.matchRampTransaction(tx.id, { assetId });
        updated = r.rampTransaction;
      } else if (value.startsWith('trailer:')) {
        const trailerId = Number(value.slice(8));
        const r = await railway.matchRampTransaction(tx.id, { trailerId });
        updated = r.rampTransaction;
      } else {
        return;
      }
      setRows(prev => prev.map(r => r.id === tx.id ? updated : r));
    } catch (err) {
      console.error('[card-spend] reassign failed:', err);
      alert('Failed to update. Please try again.');
    }
  }, []);

  const assetOptions = useMemo(() => {
    const a = assets.map(x => ({
      value: `asset:${x.id}`,
      label: assetLabelById.get(x.id) ?? x.name ?? `Truck ${x.id}`,
    }));
    const t = trailers.map(x => ({
      value: `trailer:${x.id}`,
      label: trailerLabelById.get(x.id) ?? x.name ?? `Trailer ${x.trailerNumber ?? x.id}`,
    }));
    a.sort((x, y) => x.label.localeCompare(y.label));
    t.sort((x, y) => x.label.localeCompare(y.label));
    return { assets: a, trailers: t };
  }, [assets, trailers, assetLabelById, trailerLabelById]);

  const columns: OpsColumn<RampTransaction>[] = [
    {
      key: 'date',
      header: 'Date',
      width: 110,
      sortable: true,
      sortValue: r => r.transactedAt,
      render: r => <OpsDate iso={r.transactedAt} />,
    },
    {
      key: 'cardholder',
      header: 'Cardholder',
      width: 160,
      sortable: true,
      sortValue: r => r.cardholderName ?? '',
      render: r => r.cardholderName
        ? <span>{r.cardholderName}</span>
        : <OpsMuted />,
    },
    {
      key: 'merchant',
      header: 'Merchant',
      width: 200,
      sortable: true,
      sortValue: r => r.merchantName ?? '',
      render: r => r.merchantName
        ? <span>{r.merchantName}</span>
        : <OpsMuted />,
    },
    {
      key: 'amount',
      header: 'Amount',
      width: 100,
      align: 'right',
      sortable: true,
      sortValue: r => r.amount,
      render: r => (
        <span className="tabular-nums font-semibold">{fmtMoney(r.amount)}</span>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      width: 140,
      sortable: true,
      sortValue: r => r.skCategoryName ?? '',
      render: r => r.skCategoryName ?? <OpsMuted />,
    },
    {
      key: 'memo',
      header: 'Memo',
      render: r => r.memo
        ? <span style={{ color: 'var(--gc-text-2)' }}>{r.memo}</span>
        : <OpsMuted>No memo</OpsMuted>,
    },
    {
      key: 'asset',
      header: 'Asset',
      width: 220,
      render: r => {
        const currentValue =
          r.assetId != null   ? `asset:${r.assetId}`   :
          r.trailerId != null ? `trailer:${r.trailerId}` :
          r.matchStatus === 'not_applicable' ? 'na' : '';
        return (
          <div onClick={e => e.stopPropagation()} title={r.matchNotes ?? undefined}>
            <StyledSelect
              value={currentValue}
              onChange={e => void onAssign(r, e.target.value)}
              style={{ minWidth: 180, fontSize: 12 }}
            >
              <option value="">— Unmatched —</option>
              <option value="na">Not applicable</option>
              {assetOptions.assets.length > 0 && (
                <optgroup label="Trucks">
                  {assetOptions.assets.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </optgroup>
              )}
              {assetOptions.trailers.length > 0 && (
                <optgroup label="Trailers">
                  {assetOptions.trailers.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </optgroup>
              )}
            </StyledSelect>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      sortable: true,
      sortValue: r => r.matchStatus,
      render: r => (
        <div className="flex items-center gap-1.5">
          {statusPill(r.matchStatus)}
          {(!r.receipts || r.receipts.length === 0) && (
            <span title="No receipt attached in Ramp"
                  style={{ color: '#c026d3' }}>
              <ReceiptIcon size={13} strokeWidth={2.2} />
            </span>
          )}
          {r.receipts && r.receipts.length > 0 && r.receipts[0]?.url && (
            <a href={r.receipts[0].url} target="_blank" rel="noreferrer"
               onClick={e => e.stopPropagation()}
               title="View receipt"
               style={{ color: 'var(--gc-text-3)' }}>
              <ReceiptIcon size={13} strokeWidth={2.2} />
            </a>
          )}
        </div>
      ),
    },
  ];

  const cardholderOptions = useMemo(() => {
    const uniq = new Map<string, string>();
    for (const r of rows) {
      if (r.cardholderRampUserId && r.cardholderName) {
        uniq.set(r.cardholderRampUserId, r.cardholderName);
      }
    }
    return [...uniq.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.skCategoryName) set.add(r.skCategoryName);
    return [...set].sort().map(v => ({ value: v, label: v }));
  }, [rows]);

  const filters: OpsFilter<RampTransaction>[] = [
    {
      kind: 'search',
      placeholder: 'Search memo, merchant, cardholder…',
      width: 260,
      match: (r, q) => {
        const t = q.toLowerCase();
        return (
          (r.memo?.toLowerCase().includes(t) ?? false) ||
          (r.merchantName?.toLowerCase().includes(t) ?? false) ||
          (r.cardholderName?.toLowerCase().includes(t) ?? false) ||
          r.providerTransactionId.toLowerCase().includes(t)
        );
      },
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Status',
      defaultValue: 'unmatched',
      options: [
        { value: 'unmatched',       label: 'Needs review' },
        { value: 'auto_matched',    label: 'Auto-matched' },
        { value: 'manual_matched',  label: 'Manual' },
        { value: 'not_applicable',  label: 'N/A' },
        { value: 'all',             label: 'All' },
      ],
      predicate: (r, v) => v === 'all' ? true : r.matchStatus === v,
    },
    {
      kind: 'select',
      key: 'asset',
      label: 'Asset',
      options: [
        { value: 'all',       label: 'All assets' },
        { value: 'unlinked',  label: 'Unlinked' },
        ...assetOptions.assets.map(o => ({ value: o.value, label: `Truck · ${o.label}` })),
        ...assetOptions.trailers.map(o => ({ value: o.value, label: `Trailer · ${o.label}` })),
      ],
      defaultValue: 'all',
      predicate: (r, v) => {
        if (v === 'all')      return true;
        if (v === 'unlinked') return r.assetId == null && r.trailerId == null;
        if (v.startsWith('asset:'))   return r.assetId   === Number(v.slice(6));
        if (v.startsWith('trailer:')) return r.trailerId === Number(v.slice(8));
        return true;
      },
    },
    ...(cardholderOptions.length > 1 ? [{
      kind: 'select' as const,
      key: 'cardholder',
      label: 'Cardholder',
      options: [{ value: 'all', label: 'All cardholders' }, ...cardholderOptions],
      defaultValue: 'all',
      predicate: (r: RampTransaction, v: string) =>
        v === 'all' ? true : r.cardholderRampUserId === v,
    }] : []),
    ...(categoryOptions.length > 1 ? [{
      kind: 'select' as const,
      key: 'category',
      label: 'Category',
      options: [{ value: 'all', label: 'All categories' }, ...categoryOptions],
      defaultValue: 'all',
      predicate: (r: RampTransaction, v: string) =>
        v === 'all' ? true : r.skCategoryName === v,
    }] : []),
    {
      kind: 'date-range',
      key: 'date',
      label: 'Date',
      getDate: r => r.transactedAt,
    },
  ];

  if (fetchErr) {
    return (
      <div className="rounded-lg border p-6 text-center"
           style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface-2)' }}>
        <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>{fetchErr}</div>
      </div>
    );
  }

  return (
    <OpsTable<RampTransaction>
      columns={columns}
      data={rows}
      filters={filters}
      loading={loading}
      rowKey={r => r.id}
      emptyLabel="No card transactions in this window. Try widening the date filter or hit Sync."
      defaultSort={{ key: 'date', dir: 'desc' }}
      density="compact"
      countLabel="transaction"
      toolbarRight={
        <div className="flex items-center gap-2">
          {syncMsg && (
            <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{syncMsg}</span>
          )}
          <button
            onClick={() => void runSync()}
            disabled={syncBusy}
            className="text-xs font-semibold px-3 py-1.5 rounded border"
            style={{
              borderColor: 'var(--gc-border)',
              background:  syncBusy ? 'var(--gc-surface-2)' : 'var(--gc-surface)',
              color:       'var(--gc-text-1)',
              cursor:      syncBusy ? 'not-allowed' : 'pointer',
            }}
          >
            {syncBusy ? 'Syncing Ramp…' : 'Sync Ramp'}
          </button>
        </div>
      }
    />
  );
}
