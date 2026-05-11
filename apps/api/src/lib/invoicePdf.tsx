/**
 * Server-side PDF renderer for an invoice snapshot.
 *
 * Uses @react-pdf/renderer's primitives (View/Text/Image) — Tailwind
 * and CSS classes from the web component don't apply, so the layout
 * is rebuilt here with inline styles. We mirror the on-screen design
 * deliberately so the broker sees the same document whether they
 * download the PDF or look at the web view.
 *
 * The whole module is server-only — pulls in pdfkit + node streams via
 * @react-pdf/renderer and must never reach the browser bundle.
 */

import {
  Document, Page, View, Text, Image, StyleSheet, renderToBuffer,
} from "@react-pdf/renderer";
import type { InvoiceSnapshot } from "@fleetcal/types";
import React from "react";

// ─── Palette ─────────────────────────────────────────────────────────────
// Matches the web component's accent colors so the two renderings are
// visually interchangeable. Pulled into constants because @react-pdf
// styles can't reference CSS variables.
const COLORS = {
  text:        "#202124",
  muted:       "#3c4043",
  faded:       "#5f6368",
  accent:      "#1a73e8",
  accentLight: "#eff6ff",
  green:       "#137333",
  rule:        "#e8eaed",
  ruleSoft:    "#f1f3f4",
  ruleHard:    "#dadce0",
};

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 10,
    color: COLORS.text,
    padding: 36,                   // ~0.5"
    lineHeight: 1.35,
  },
  row:           { flexDirection: "row" },
  rowBetween:    { flexDirection: "row", justifyContent: "space-between" },
  colFlex:       { flexGrow: 1, flexShrink: 1 },
  textRight:     { textAlign: "right" },
  bold:          { fontFamily: "Helvetica-Bold" },
  obliqueMuted:  { fontFamily: "Helvetica-Oblique", color: COLORS.faded },

  // Sections
  sectionTopRule: { borderTopWidth: 1, borderTopColor: COLORS.rule, paddingTop: 10, marginTop: 0 },

  // Header
  invoiceMetaLabel: { fontFamily: "Helvetica-Bold", fontSize: 9, color: COLORS.faded, letterSpacing: 0.6 },
  invoiceNumber:    { fontFamily: "Helvetica-Bold", fontSize: 26, color: COLORS.accent, marginTop: 2 },

  // Company identity
  companyName: { fontFamily: "Helvetica-Bold", fontSize: 12, letterSpacing: 0.4 },

  // Bill-to
  billToLabel: { fontFamily: "Helvetica-Bold", fontSize: 9, color: COLORS.faded, letterSpacing: 0.6, marginBottom: 2 },
  brokerName:  { fontFamily: "Helvetica-Bold", fontSize: 11 },

  // LabelRow (right-side label/value pairs)
  labelRow:      { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1, gap: 12 },
  labelRowLabel: { fontFamily: "Helvetica-Bold", fontSize: 9, color: COLORS.faded, letterSpacing: 0.6 },
  labelRowValue: { fontFamily: "Helvetica-Bold", fontSize: 10 },

  // Stops
  stopKind:     { fontFamily: "Helvetica-Bold", fontSize: 10, letterSpacing: 0.4 },
  stopFacility: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  stopCity:     { fontSize: 10, color: COLORS.muted },
  stopRefs:     { fontSize: 9.5, color: COLORS.faded, marginTop: 1 },

  // Line items table
  thead: { flexDirection: "row", borderTopWidth: 1.5, borderTopColor: COLORS.text, borderBottomWidth: 1, borderBottomColor: COLORS.ruleHard, paddingVertical: 5 },
  tbodyRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: COLORS.ruleSoft, paddingVertical: 5 },
  th:       { fontFamily: "Helvetica-Bold", fontSize: 8.5, color: COLORS.muted, letterSpacing: 0.6 },
  td:       { fontSize: 10 },

  // Totals
  totalsLabel:     { fontFamily: "Helvetica-Bold", fontSize: 9, color: COLORS.muted, letterSpacing: 0.6 },
  totalsValue:     { fontFamily: "Helvetica-Bold", fontSize: 10 },
  balanceDueLabel: { fontFamily: "Helvetica-Bold", fontSize: 9.5, color: COLORS.accent, letterSpacing: 0.6 },
  balanceDueValue: { fontFamily: "Helvetica-Bold", fontSize: 12, color: COLORS.accent },

  // Remit-to
  remitHeader: { fontFamily: "Helvetica-Bold", fontSize: 12, color: COLORS.accent, marginBottom: 3 },

  // Footer notes
  footerNotes: { fontSize: 9, color: COLORS.faded, borderTopWidth: 1, borderTopColor: COLORS.rule, paddingTop: 8, marginTop: 12 },
});

// ─── Helpers ─────────────────────────────────────────────────────────────

const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function cszLine(snap: InvoiceSnapshot): string {
  const cityState = [snap.city, snap.state].filter(Boolean).join(", ");
  return [cityState, snap.zip].filter(Boolean).join(" ");
}

function taxIdLine(snap: InvoiceSnapshot): string {
  const parts: string[] = [];
  if (snap.mcNumber)  parts.push(`MC# ${snap.mcNumber}`);
  if (snap.dotNumber) parts.push(`DOT# ${snap.dotNumber}`);
  if (snap.ein)       parts.push(`EIN ${snap.ein}`);
  return parts.join("  ·  ");
}

// ─── Sub-components ──────────────────────────────────────────────────────

function LabelRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.labelRow}>
      <Text style={styles.labelRowLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.labelRowValue}>{value}</Text>
    </View>
  );
}

interface DocProps {
  snapshot:      InvoiceSnapshot;
  invoiceNumber: string;
  issuedDate?:   string;
  dueDate?:      string;
  logoData?:     string; // base64 data URL or remote URL
}

function InvoicePdfDoc({ snapshot, invoiceNumber, issuedDate, dueDate, logoData }: DocProps) {
  const csz   = cszLine(snapshot);
  const taxIds = taxIdLine(snapshot);

  const hasAnyRemit =
       !!snapshot.remitToInstructions
    || !!snapshot.addressLine1
    || !!snapshot.addressLine2
    || !!csz
    || !!snapshot.phone
    || !!snapshot.email;

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>

        {/* Header: logo + tax IDs (left) | INVOICE # (right) */}
        <View style={styles.rowBetween}>
          <View>
            {logoData
              ? <Image src={logoData} style={{ maxWidth: 110, maxHeight: 60, objectFit: "contain" }} />
              : null}
            {taxIds ? (
              <Text style={{ marginTop: 6, fontFamily: "Helvetica-Bold", fontSize: 9.5, color: COLORS.muted, maxWidth: 220 }}>
                {taxIds}
              </Text>
            ) : null}
          </View>
          <View>
            <Text style={[styles.invoiceMetaLabel, styles.textRight]}>INVOICE #</Text>
            <Text style={[styles.invoiceNumber, styles.textRight]}>{invoiceNumber}</Text>
          </View>
        </View>

        {/* Company name (left) | invoice meta (right) */}
        <View style={[styles.rowBetween, { marginTop: 18 }]}>
          <View style={styles.colFlex}>
            {snapshot.companyName
              ? <Text style={styles.companyName}>{snapshot.companyName.toUpperCase()}</Text>
              : null}
          </View>
          <View style={{ minWidth: 220 }}>
            <LabelRow label="Invoice Date" value={issuedDate ?? "—"} />
            <LabelRow label="Due Date"     value={dueDate    ?? "—"} />
            <LabelRow label="Load Number"  value={snapshot.loadNumber} />
          </View>
        </View>

        {/* Bill-to (left) | order meta (right) */}
        <View style={[styles.rowBetween, styles.sectionTopRule, { marginTop: 18, gap: 24 }]}>
          <View style={styles.colFlex}>
            <Text style={styles.billToLabel}>BILL TO</Text>
            {snapshot.brokerName ? <Text style={styles.brokerName}>{snapshot.brokerName}</Text> : null}
            {snapshot.brokerAddrLine1 ? <Text style={{ color: COLORS.muted }}>{snapshot.brokerAddrLine1}</Text> : null}
            {snapshot.brokerAddrLine2 ? <Text style={{ color: COLORS.muted }}>{snapshot.brokerAddrLine2}</Text> : null}
          </View>
          <View style={{ minWidth: 220 }}>
            {snapshot.orderNo       ? <LabelRow label="Order No"     value={snapshot.orderNo} />       : null}
            {snapshot.poNumber      ? <LabelRow label="PO Number"    value={snapshot.poNumber} />      : null}
            {snapshot.pickupDate    ? <LabelRow label="Pickup Date"  value={snapshot.pickupDate} />    : null}
            {snapshot.deliveredDate ? <LabelRow label="Delivered"    value={snapshot.deliveredDate} /> : null}
          </View>
        </View>

        {/* Stops */}
        {snapshot.stops.length > 0 ? (
          <View style={[styles.sectionTopRule, { marginTop: 18 }]}>
            {snapshot.stops.map((s, i) => (
              <View key={i} style={[styles.row, { marginTop: i === 0 ? 0 : 10, paddingTop: i === 0 ? 0 : 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: COLORS.ruleSoft, gap: 12 }]}>
                <View style={{ width: 80 }}>
                  <Text style={[styles.stopKind, { color: s.kind === "Pickup" ? COLORS.green : COLORS.accent }]}>
                    {s.kind.toUpperCase()} {s.seq}
                  </Text>
                </View>
                <View style={styles.colFlex}>
                  {s.facility ? <Text style={styles.stopFacility}>{s.facility}</Text> : null}
                  {s.cityState ? <Text style={styles.stopCity}>{s.cityState}</Text> : null}
                  {s.refs ? <Text style={styles.stopRefs}>{s.refs}</Text> : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* Line items */}
        <View style={{ marginTop: 18 }}>
          <View style={styles.thead}>
            <Text style={[styles.th, { flexBasis: "40%" }]}>DESCRIPTION</Text>
            <Text style={[styles.th, styles.textRight, { flexBasis: "15%" }]}>RATE</Text>
            <Text style={[styles.th, styles.textRight, { flexBasis: "10%" }]}>UNITS</Text>
            <Text style={[styles.th, styles.textRight, { flexBasis: "15%" }]}>UOM</Text>
            <Text style={[styles.th, styles.textRight, { flexBasis: "20%" }]}>AMOUNT</Text>
          </View>
          {snapshot.lineItems.map((li, i) => (
            <View key={i} style={styles.tbodyRow}>
              <Text style={[styles.td, { flexBasis: "40%", fontFamily: "Helvetica-Bold" }]}>{li.description}</Text>
              <Text style={[styles.td, styles.textRight, { flexBasis: "15%" }]}>${fmtMoney(li.rate)}</Text>
              <Text style={[styles.td, styles.textRight, { flexBasis: "10%" }]}>{li.units}</Text>
              <Text style={[styles.td, styles.textRight, { flexBasis: "15%" }]}>{li.uom}</Text>
              <Text style={[styles.td, styles.textRight, { flexBasis: "20%", fontFamily: "Helvetica-Bold" }]}>${fmtMoney(li.amount)}</Text>
            </View>
          ))}
          {/* Totals — anchored to the right two cells (UOM + AMOUNT). */}
          <View style={{ flexDirection: "row", marginTop: 8 }}>
            <Text style={{ flexBasis: "65%" }}></Text>
            <Text style={[styles.totalsLabel, styles.textRight, { flexBasis: "15%" }]}>TOTAL CHARGES</Text>
            <Text style={[styles.totalsValue, styles.textRight, { flexBasis: "20%" }]}>${fmtMoney(snapshot.totalCharges)}</Text>
          </View>
          <View style={{ flexDirection: "row", marginTop: 4 }}>
            <Text style={{ flexBasis: "65%" }}></Text>
            <Text style={[styles.balanceDueLabel, styles.textRight, { flexBasis: "15%" }]}>BALANCE DUE</Text>
            <Text style={[styles.balanceDueValue, styles.textRight, { flexBasis: "20%" }]}>${fmtMoney(snapshot.balanceDue)}</Text>
          </View>
        </View>

        {/* Remit-to — only render when there's at least one field set */}
        {hasAnyRemit ? (
          <View style={[styles.sectionTopRule, { marginTop: 18, alignItems: "flex-end" }]}>
            <View style={{ maxWidth: 320, alignItems: "flex-end" }}>
              <Text style={styles.remitHeader}>REMIT TO</Text>
              {snapshot.remitToInstructions ? (
                // @react-pdf preserves newlines in plain text — no
                // whiteSpace style needed (it's not part of its Style
                // type). Splitting into <Text> per line keeps
                // right-alignment per line.
                snapshot.remitToInstructions.split(/\r?\n/).map((line, i) => (
                  <Text key={i} style={styles.textRight}>{line}</Text>
                ))
              ) : null}
              {(snapshot.addressLine1 || snapshot.addressLine2 || csz) ? (
                <View style={{ marginTop: 6, alignItems: "flex-end" }}>
                  {snapshot.addressLine1 ? <Text style={[styles.textRight, { color: COLORS.muted }]}>{snapshot.addressLine1}</Text> : null}
                  {snapshot.addressLine2 ? <Text style={[styles.textRight, { color: COLORS.muted }]}>{snapshot.addressLine2}</Text> : null}
                  {csz                   ? <Text style={[styles.textRight, { color: COLORS.muted }]}>{csz}</Text> : null}
                </View>
              ) : null}
              {(snapshot.phone || snapshot.email) ? (
                <View style={{ marginTop: 4, alignItems: "flex-end" }}>
                  {snapshot.phone ? <Text style={[styles.textRight, { color: COLORS.muted }]}>P: {snapshot.phone}</Text> : null}
                  {snapshot.email ? <Text style={[styles.textRight, { color: COLORS.muted }]}>{snapshot.email}</Text>     : null}
                </View>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* Footer */}
        {snapshot.invoiceFooterNotes ? (
          <Text style={styles.footerNotes}>{snapshot.invoiceFooterNotes}</Text>
        ) : null}
      </Page>
    </Document>
  );
}

/**
 * Render an invoice to a PDF Buffer. The buffer is the canonical
 * payload — the HTTP route streams it as application/pdf and Phase-4's
 * email pipeline will attach it directly.
 */
export async function renderInvoicePdf(args: DocProps): Promise<Buffer> {
  return await renderToBuffer(<InvoicePdfDoc {...args} />);
}
