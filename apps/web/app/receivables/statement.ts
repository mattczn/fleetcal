/**
 * Customer statement — the spreadsheet you send to a broker's AP desk.
 *
 * Distinct from the ledger's "Export aging", which is one row per customer
 * for internal use. This is one customer's open invoices, laid out to be
 * read by someone who does not work here.
 *
 * That audience drives every decision below:
 *
 *  • THEIR reference leads, not ours. An AP clerk searches their system by
 *    the PO / order / BOL number they issued. Our invoice number is a
 *    string they have never seen. Ryder settles it — their remittance line
 *    reads `1000974-31410-59503-1`, which is our load number followed by
 *    the ref_num we store against the load. A statement without that column
 *    is one they have to hand back.
 *
 *  • Every figure is stated, not implied. Amount, paid and balance all
 *    appear per row even when paid is zero, because a partial payment they
 *    have made and we have recorded is the single most likely thing to
 *    argue about.
 *
 *  • The aging summary uses the same agingBucketFor() the screen uses, so
 *    the total someone chases a broker over cannot depend on whether they
 *    read it off the page or the attachment.
 *
 * Written with SheetJS's community build, which has no cell styling — no
 * bold, no fills. Structure carries the formatting instead: a header block,
 * a blank row, then the table. Column widths and number formats DO apply,
 * and they are what stop it opening as a wall of unreadable columns.
 */

import * as XLSX from 'xlsx';
import type { ReceivableInvoice, AgingBucket } from '@fleetcal/types';
import { AGING_BUCKETS, AGING_BUCKET_LABEL, agingBucketFor } from '@fleetcal/types';

type Row = (string | number | null)[];

const MONEY_FMT = '#,##0.00';

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '';

/** Days past due, as words rather than a signed number — a negative in a
 *  column headed "days past due" reads as an error to anyone outside. */
const fmtAge = (d: number | null | undefined) =>
  d === null || d === undefined ? '' : d > 0 ? `${d} days` : 'Not yet due';

export interface StatementInput {
  customerName: string;
  /** Our own name, for the top of the sheet. */
  fromName?: string | null;
  invoices:  ReceivableInvoice[];
  /** Which invoices this covers, so the sheet can say so plainly. */
  scope:     'open' | 'paid' | 'all';
  /** Injected rather than read from the clock, so the same input always
   *  produces the same sheet — and so a test can pin it. */
  today?:    Date;
}

export function buildStatementWorkbook(input: StatementInput): XLSX.WorkBook {
  const { customerName, fromName, invoices, scope } = input;
  const today = input.today ?? new Date();

  const balance = invoices.reduce((s, i) => s + i.balance, 0);
  const totalAmt = invoices.reduce((s, i) => s + i.total, 0);
  const totalPaid = invoices.reduce((s, i) => s + i.paidAmount, 0);

  const byBucket = new Map<AgingBucket, { count: number; balance: number }>();
  for (const inv of invoices) {
    const b = agingBucketFor(inv.agingDays);
    const cur = byBucket.get(b) ?? { count: 0, balance: 0 };
    cur.count += 1;
    cur.balance += inv.balance;
    byBucket.set(b, cur);
  }

  const scopeLabel =
    scope === 'paid' ? 'Invoices settled' :
    scope === 'all'  ? 'All invoices'     : 'Open invoices';

  const rows: Row[] = [];
  rows.push(['STATEMENT OF ACCOUNT']);
  if (fromName) rows.push([fromName]);
  rows.push([]);
  rows.push(['To', customerName]);
  rows.push(['Statement date', fmtDate(today.toISOString())]);
  rows.push(['Covering', `${scopeLabel} · ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`]);
  rows.push([]);
  rows.push(['Balance due', balance]);

  // Only the buckets that actually hold something. A statement listing
  // "31+ days  $0.00" invites a conversation about nothing.
  for (const b of AGING_BUCKETS) {
    const cell = byBucket.get(b);
    if (!cell || cell.count === 0) continue;
    rows.push([`  ${AGING_BUCKET_LABEL[b]}`, cell.balance, `${cell.count} invoice${cell.count === 1 ? '' : 's'}`]);
  }
  rows.push([]);

  const HEAD = [
    'Invoice #', 'Your reference', 'Load #', 'Description',
    'Picked up', 'Invoiced', 'Due', 'Days past due',
    'Amount', 'Paid', 'Balance',
  ];
  const headRowIdx = rows.length;
  rows.push(HEAD);

  // Oldest first: the rows worth a conversation belong at the top, and a
  // statement read top-down should open on the overdue end.
  const ordered = [...invoices].sort((a, b) => (b.agingDays ?? -1e9) - (a.agingDays ?? -1e9));
  for (const inv of ordered) {
    rows.push([
      inv.invoiceNumber,
      (inv.refNums ?? []).join(', '),
      inv.loadNum ?? '',
      inv.title ?? '',
      fmtDate(inv.pickupAt),
      fmtDate(inv.issuedAt),
      fmtDate(inv.dueAt),
      fmtAge(inv.agingDays),
      inv.total,
      inv.paidAmount,
      inv.balance,
    ]);
  }

  const totalRowIdx = rows.length;
  rows.push(['TOTAL', '', '', '', '', '', '', '', totalAmt, totalPaid, balance]);

  const ws = XLSX.utils.aoa_to_sheet(rows);

  ws['!cols'] = [
    { wch: 13 }, { wch: 22 }, { wch: 16 }, { wch: 34 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
    { wch: 12 }, { wch: 12 }, { wch: 12 },
  ];

  // Number formats, applied by walking the cells we know are money —
  // aoa_to_sheet types them as numbers but leaves them unformatted, which
  // prints 1234.5 rather than 1,234.50.
  const money = (r: number, c: number) => {
    const ref = XLSX.utils.encode_cell({ r, c });
    const cell = ws[ref] as XLSX.CellObject | undefined;
    if (cell && cell.t === 'n') cell.z = MONEY_FMT;
  };
  for (let r = headRowIdx + 1; r <= totalRowIdx; r++) { money(r, 8); money(r, 9); money(r, 10); }
  // The summary block's figures sit in column B.
  for (let r = 0; r < headRowIdx; r++) money(r, 1);

  // Freeze the header row so the columns stay labelled while they scroll a
  // long book. Costs nothing and is the difference between a usable sheet
  // and one they print.
  ws['!freeze'] = { xSplit: '0', ySplit: String(headRowIdx + 1), topLeftCell: `A${headRowIdx + 2}`, activePane: 'bottom', state: 'frozen' };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Statement');
  return wb;
}

/** Safe for a filename on any OS, and still recognisable. */
function slug(s: string): string {
  return s.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 48) || 'customer';
}

export function statementFilename(customerName: string, ext: 'xlsx' | 'csv', today = new Date()): string {
  return `statement-${slug(customerName)}-${today.toISOString().slice(0, 10)}.${ext}`;
}

/** Triggers the browser download. `csv` writes the same sheet flat, for an
 *  AP desk that imports rather than reads. */
export function downloadStatement(input: StatementInput, ext: 'xlsx' | 'csv' = 'xlsx'): void {
  const wb = buildStatementWorkbook(input);
  XLSX.writeFile(wb, statementFilename(input.customerName, ext, input.today), {
    bookType: ext === 'csv' ? 'csv' : 'xlsx',
  });
}
