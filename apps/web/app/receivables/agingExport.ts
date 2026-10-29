/**
 * Aging exports — three shapes of the same ledger.
 *
 * One row per customer answers "who owes us"; one row per invoice answers
 * "which money is late"; the bucket roll-up answers "how bad is it". They
 * get asked by different people for different reasons, and collapsing them
 * into one sheet means whoever receives it does the pivot by hand.
 *
 * All three are derived from what the page already fetched, so an export
 * can never disagree with what is on screen — including the active filters,
 * which is the point. Exporting the unfiltered book from a filtered view is
 * the kind of quiet mismatch nobody notices until the totals are quoted in
 * a meeting.
 *
 * CSV rather than xlsx: these are pivoted, filtered and pasted, not read.
 * The customer statement (statement.ts) is the one meant to be read, and it
 * stays xlsx for that reason.
 */

import type { ReceivableInvoice, ReceivableCustomerSummary, AgingBucket } from '@fleetcal/types';
import { AGING_BUCKETS, AGING_BUCKET_LABEL, agingBucketFor } from '@fleetcal/types';

export type AgingExportShape = 'customer' | 'invoice' | 'bucket';

export const AGING_EXPORT_LABEL: Record<AgingExportShape, string> = {
  customer: 'One row per customer',
  invoice:  'One row per invoice',
  bucket:   'Bucket totals',
};

export const AGING_EXPORT_HINT: Record<AgingExportShape, string> = {
  customer: 'Who owes what, with their aging mix. The collections call list.',
  invoice:  'Every open invoice with its load, dates and age. For chasing specifics.',
  bucket:   'Current / 1–30 / 31+ totals, per customer and overall.',
};

/** RFC4180: quote everything, double internal quotes. Cheaper than deciding
 *  which fields might contain a comma — a broker name eventually will. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '""';
  return `"${String(v).replace(/"/g, '""')}"`;
}
const line = (cells: unknown[]) => cells.map(cell).join(',');

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const day   = (iso?: string | null) => (iso ? String(iso).slice(0, 10) : '');

export interface AgingExportInput {
  /** Already filtered by the page — scope, bucket, customer, search. */
  customers: ReceivableCustomerSummary[];
  /** Every invoice behind those customers, same filtering. */
  invoices:  ReceivableInvoice[];
  shape:     AgingExportShape;
  /** Stamped into the filename so two exports a week apart don't collide. */
  today?:    Date;
}

export function buildAgingCsv(input: AgingExportInput): string {
  const { customers, invoices, shape } = input;

  if (shape === 'customer') {
    const head = ['Customer', 'Open invoices', 'Oldest days over',
                  'Current', '1-30 days', '31+ days', 'Past due', 'Balance'];
    const body = customers.map(c => line([
      c.customerName,
      c.openCount,
      c.oldestAgingDays ?? '',
      money(c.byBucket?.current  ?? 0),
      money(c.byBucket?.d1_30    ?? 0),
      money(c.byBucket?.d31_plus ?? 0),
      money(c.overdueBalance),
      money(c.openBalance),
    ]));
    return [line(head), ...body].join('\n');
  }

  if (shape === 'invoice') {
    const head = ['Customer', 'Invoice', 'Load', 'Reference', 'Description',
                  'Picked up', 'Invoiced', 'Due', 'Days past due', 'Bucket',
                  'Total', 'Paid', 'Balance', 'Has proof'];
    // Oldest first: an invoice list is read to decide who to call, and the
    // decision is made at the top of the page.
    const body = [...invoices]
      .sort((a, b) => (b.agingDays ?? -1e9) - (a.agingDays ?? -1e9))
      .map(i => line([
        i.customerName ?? '',
        i.invoiceNumber,
        i.loadNum ?? '',
        (i.refNums ?? []).join(' / '),
        i.title ?? '',
        day(i.pickupAt),
        day(i.issuedAt),
        day(i.dueAt),
        // Blank, not a negative, for anything not yet due — a minus sign in
        // a "days past due" column reads as a data error to anyone outside.
        i.agingDays != null && i.agingDays > 0 ? i.agingDays : '',
        AGING_BUCKET_LABEL[agingBucketFor(i.agingDays)],
        money(i.total),
        money(i.paidAmount),
        money(i.balance),
        i.hasProof ? 'yes' : 'no',
      ]));
    return [line(head), ...body].join('\n');
  }

  // bucket — per customer, then a TOTAL row. The totals are summed from the
  // same rows above them rather than from the page's own tiles, so the sheet
  // can always be checked against itself.
  const head = ['Customer', ...AGING_BUCKETS.map(b => AGING_BUCKET_LABEL[b]), 'Total'];
  const sums: Record<AgingBucket, number> = { current: 0, d1_30: 0, d31_plus: 0 };
  const body = customers.map(c => {
    let rowTotal = 0;
    const cells = AGING_BUCKETS.map(b => {
      const v = c.byBucket?.[b] ?? 0;
      sums[b] += v;
      rowTotal += v;
      return money(v);
    });
    return line([c.customerName, ...cells, money(rowTotal)]);
  });
  const grand = AGING_BUCKETS.reduce((s, b) => s + sums[b], 0);
  const totalRow = line(['TOTAL', ...AGING_BUCKETS.map(b => money(sums[b])), money(grand)]);
  return [line(head), ...body, totalRow].join('\n');
}

export function agingFilename(shape: AgingExportShape, today = new Date()): string {
  const stem = shape === 'invoice' ? 'invoices' : shape === 'bucket' ? 'buckets' : 'by-customer';
  return `receivables-aging-${stem}-${today.toISOString().slice(0, 10)}.csv`;
}

export function downloadAgingCsv(input: AgingExportInput): void {
  const csv  = buildAgingCsv(input);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = agingFilename(input.shape, input.today);
  a.click();
  URL.revokeObjectURL(url);
}
