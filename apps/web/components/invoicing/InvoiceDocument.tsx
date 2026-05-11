'use client';

/**
 * InvoiceDocument — renders an InvoiceSnapshot as the broker-facing
 * invoice document. The same component powers the live settings preview
 * (with `mode="preview"` and a partial snapshot stitched together from
 * the editing form) and the canonical render at view / print time.
 *
 * It deliberately reads ONLY from the snapshot — no org_settings or load
 * lookups happen here. Once an invoice is generated, the snapshot is
 * frozen on the row, so re-rendering an old invoice years later still
 * produces the document the broker actually received.
 */

import type { InvoiceSnapshot } from '@fleetcal/types';

interface Props {
  snapshot:     InvoiceSnapshot;
  /** Invoice number rendered in the header. Lives outside the snapshot
   *  because the wrapping page (settings preview vs real invoice) sources
   *  it differently. */
  invoiceNumber: string;
  /** Issue and due dates as pre-formatted display strings. */
  issuedDate?:  string;
  dueDate?:     string;
  /** Optional logo URL — falls back to a placeholder block when null. */
  logoUrl?:     string;
  /** Affects shadow + max-width. 'preview' is the in-app card; 'print'
   *  is full-bleed letter for the print stylesheet. */
  mode?:        'preview' | 'print';
  /** When true, show "Street address", "Remit-to instructions appear
   *  here", etc. as in-place hints for unset fields. Use ONLY on the
   *  settings preview where the user is actively editing the source.
   *  Real generated invoices never want these. */
  placeholdersOnEmpty?: boolean;
}

export function InvoiceDocument({
  snapshot,
  invoiceNumber,
  issuedDate,
  dueDate,
  logoUrl,
  mode = 'preview',
  placeholdersOnEmpty = false,
}: Props) {
  const fmtMoney = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const csz = [
    [snapshot.city, snapshot.state].filter(Boolean).join(', '),
    snapshot.zip,
  ].filter(Boolean).join(' ');

  // The taxIdLine sidesteps a fan of optional fields without producing
  // three weird empty separators.
  const taxIdLine = (() => {
    const parts: string[] = [];
    if (snapshot.mcNumber)  parts.push(`MC# ${snapshot.mcNumber}`);
    if (snapshot.dotNumber) parts.push(`DOT# ${snapshot.dotNumber}`);
    if (snapshot.ein)       parts.push(`EIN ${snapshot.ein}`);
    return parts.join(' · ');
  })();

  return (
    <div className="rounded-xl overflow-hidden"
      style={{
        background: '#fff',
        border:     mode === 'preview' ? '1px solid var(--gc-border)' : 'none',
        boxShadow:  mode === 'preview' ? '0 8px 24px rgba(0,0,0,0.08)' : 'none',
        aspectRatio: '8.5 / 11',
        maxWidth: mode === 'preview' ? 910 : undefined,
        width:    mode === 'print'   ? '100%' : undefined,
      }}>
      <div className="h-full overflow-y-auto px-10 py-9 text-[#202124] text-[12.5px] leading-normal"
        style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>

        {/* Header row: logo + tax IDs (top-left) | big blue invoice # (top-right) */}
        <div className="flex items-start justify-between mb-6">
          <div className="shrink-0">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" style={{ maxWidth: 110, maxHeight: 70, objectFit: 'contain' }} />
            ) : placeholdersOnEmpty ? (
              <div style={{ width: 110, height: 70, background: '#f1f3f4', borderRadius: 6 }} className="flex items-center justify-center text-[10px] uppercase tracking-wider">
                <span style={{ color: '#9aa0a6' }}>Logo</span>
              </div>
            ) : null}
            {/* MC / DOT / EIN sit immediately under the logo so they
                read as identity, not contact info. The broker AP team
                often needs these to set up a vendor record. */}
            {taxIdLine && (
              <div className="mt-2 text-[11px] leading-snug font-semibold" style={{ color: '#3c4043', maxWidth: 220 }}>
                {taxIdLine}
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-[11px] font-extrabold uppercase tracking-wider" style={{ color: '#5f6368' }}>Invoice #</div>
            <div className="text-[30px] font-black leading-none mt-1" style={{ color: '#1a73e8' }}>
              {invoiceNumber || <span style={{ opacity: 0.4 }}>—</span>}
            </div>
          </div>
        </div>

        {/* Company name (left) + invoice metadata (right) */}
        <div className="flex items-start justify-between mb-6 gap-8">
          <div className="flex-1">
            <div className="text-[14px] font-extrabold uppercase tracking-wide leading-tight">
              {snapshot.companyName || (placeholdersOnEmpty ? <span style={{ opacity: 0.4 }}>Your Company Name</span> : null)}
            </div>
          </div>
          <div className="shrink-0" style={{ minWidth: 240 }}>
            <LabelRow label="Invoice Date" value={issuedDate ?? '—'} />
            <LabelRow label="Due Date"     value={dueDate    ?? '—'} />
            <LabelRow label="Load Number"  value={snapshot.loadNumber} />
          </div>
        </div>

        {/* Bill-to (left) + order metadata (right) */}
        <div className="flex items-start justify-between mb-6 gap-8 pt-4" style={{ borderTop: '1px solid #e8eaed' }}>
          <div className="flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-wider mb-1.5" style={{ color: '#5f6368' }}>Bill to</div>
            <div className="font-extrabold text-[13px]">
              {snapshot.brokerName || (placeholdersOnEmpty ? <span style={{ opacity: 0.4 }}>Broker name</span> : null)}
            </div>
            {(snapshot.brokerAddrLine1 || snapshot.brokerAddrLine2) && (
              <div className="leading-snug" style={{ color: '#3c4043' }}>
                {snapshot.brokerAddrLine1}{snapshot.brokerAddrLine1 && <br/>}
                {snapshot.brokerAddrLine2}
              </div>
            )}
          </div>
          <div className="shrink-0" style={{ minWidth: 240 }}>
            {snapshot.orderNo      && <LabelRow label="Order No"     value={snapshot.orderNo} />}
            {snapshot.poNumber     && <LabelRow label="PO Number"    value={snapshot.poNumber} />}
            {snapshot.pickupDate   && <LabelRow label="Pickup Date"  value={snapshot.pickupDate} />}
            {snapshot.deliveredDate&& <LabelRow label="Delivered"    value={snapshot.deliveredDate} />}
          </div>
        </div>

        {/* Stops */}
        {snapshot.stops.length > 0 && (
          <div className="mb-6 pt-4" style={{ borderTop: '1px solid #e8eaed' }}>
            {snapshot.stops.map((s, i) => (
              <div key={i} className={i === 0 ? '' : 'mt-3 pt-3'} style={i === 0 ? undefined : { borderTop: '1px solid #f1f3f4' }}>
                <div className="flex items-start gap-4">
                  <div className="shrink-0" style={{ width: 95 }}>
                    <div className="text-[12px] font-extrabold uppercase tracking-wide" style={{ color: s.kind === 'Pickup' ? '#137333' : '#1a73e8' }}>
                      {s.kind} {s.seq}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="font-extrabold uppercase">{s.facility || '—'}</div>
                    <div className="uppercase" style={{ color: '#3c4043' }}>{s.cityState}</div>
                    {s.refs && <div className="mt-0.5" style={{ color: '#5f6368' }}>{s.refs}</div>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Line items */}
        <table className="w-full mb-5" style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderTop: '2px solid #202124', borderBottom: '1px solid #dadce0' }}>
              <th className="text-left  py-2 font-extrabold uppercase tracking-wider text-[10.5px]" style={{ color: '#3c4043' }}>Description</th>
              <th className="text-right py-2 font-extrabold uppercase tracking-wider text-[10.5px]" style={{ color: '#3c4043' }}>Rate</th>
              <th className="text-right py-2 font-extrabold uppercase tracking-wider text-[10.5px]" style={{ color: '#3c4043' }}>Units</th>
              <th className="text-right py-2 font-extrabold uppercase tracking-wider text-[10.5px]" style={{ color: '#3c4043' }}>UOM</th>
              <th className="text-right py-2 font-extrabold uppercase tracking-wider text-[10.5px]" style={{ color: '#3c4043' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.lineItems.map((li, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f1f3f4' }}>
                <td className="py-2 font-semibold">{li.description}</td>
                <td className="py-2 text-right tabular-nums">${fmtMoney(li.rate)}</td>
                <td className="py-2 text-right tabular-nums">{li.units}</td>
                <td className="py-2 text-right">{li.uom}</td>
                <td className="py-2 text-right tabular-nums font-semibold">${fmtMoney(li.amount)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3}></td>
              <td className="pt-3 text-right font-extrabold uppercase tracking-wider text-[11px]" style={{ color: '#3c4043' }}>Total Charges</td>
              <td className="pt-3 text-right font-extrabold tabular-nums">${fmtMoney(snapshot.totalCharges)}</td>
            </tr>
            <tr>
              <td colSpan={3}></td>
              <td className="pt-1.5 text-right font-extrabold uppercase tracking-wider text-[11px]" style={{ color: '#1a73e8' }}>Balance Due</td>
              <td className="pt-1.5 text-right font-extrabold tabular-nums text-[14.5px]" style={{ color: '#1a73e8' }}>${fmtMoney(snapshot.balanceDue)}</td>
            </tr>
          </tbody>
        </table>

        {/* Remit-to. The user-typed remit instructions sit on top; below
            we render the bare minimum the broker needs to mail a check
            (address, phone, email). Tax IDs live in the top-left
            corner, so they're intentionally not repeated here. The
            entire block hides on real invoices when none of the fields
            are populated — no point in an empty REMIT TO header. */}
        {(() => {
          const hasAnyRemit =
            !!snapshot.remitToInstructions ||
            !!snapshot.addressLine1 ||
            !!snapshot.addressLine2 ||
            !!csz ||
            !!snapshot.phone ||
            !!snapshot.email;
          if (!hasAnyRemit && !placeholdersOnEmpty) return null;
          return (
            <div className="flex justify-end pt-3" style={{ borderTop: '1px solid #e8eaed' }}>
              <div className="text-right" style={{ maxWidth: 340 }}>
                <div className="text-[15px] font-extrabold mb-1" style={{ color: '#1a73e8' }}>REMIT TO</div>
                {snapshot.remitToInstructions ? (
                  <div className="whitespace-pre-line leading-snug">{snapshot.remitToInstructions}</div>
                ) : placeholdersOnEmpty ? (
                  <div className="italic" style={{ color: '#9aa0a6' }}>
                    Remit-to instructions appear here.
                  </div>
                ) : null}
                {(snapshot.addressLine1 || snapshot.addressLine2 || csz || placeholdersOnEmpty) && (
                  <div className="mt-2 leading-snug" style={{ color: '#3c4043' }}>
                    {snapshot.addressLine1 || (placeholdersOnEmpty ? <span style={{ opacity: 0.4 }}>Street address</span> : null)}
                    {(snapshot.addressLine1 || placeholdersOnEmpty) && <br/>}
                    {snapshot.addressLine2 && <>{snapshot.addressLine2}<br/></>}
                    {csz || (placeholdersOnEmpty ? <span style={{ opacity: 0.4 }}>City, ST ZIP</span> : null)}
                  </div>
                )}
                {(snapshot.phone || snapshot.email) && (
                  <div className="mt-1.5 leading-snug" style={{ color: '#3c4043' }}>
                    {snapshot.phone && <>P: {snapshot.phone}<br/></>}
                    {snapshot.email && <>{snapshot.email}</>}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Footer notes */}
        {snapshot.invoiceFooterNotes && (
          <div className="text-[11px] leading-snug mt-4 pt-3" style={{ color: '#5f6368', borderTop: '1px solid #e8eaed' }}>
            {snapshot.invoiceFooterNotes}
          </div>
        )}
      </div>
    </div>
  );
}

// Right-side label/value rows. Internal — not exported to avoid bloating
// the design system's surface area for a one-off layout primitive.
function LabelRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <div className="text-[11px] font-extrabold uppercase tracking-wider" style={{ color: '#5f6368' }}>{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
