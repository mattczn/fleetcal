/**
 * @fleetcal/types — invoice-packet document selection (SINGLE SOURCE OF TRUTH)
 *
 * ONE rule, imported by BOTH the web UI (ReviewQueue, LoadDocsPreviewModal)
 * and the API packet builder (resolvePacketDocsForLoad), so the documents a
 * dispatcher sees selected are EXACTLY the documents bundled into the
 * invoice packet.
 *
 * Why this exists: three separate copies of this logic had drifted apart —
 * the closeout queue, the accounting modal, and the server resolver each
 * decided "is this untouched doc included?" differently. The result was a
 * fuel receipt riding along to a broker on a load where the dispatcher's
 * screen showed it as excluded (2026-06 audit). Never re-implement the
 * rule inline; import isDocIncludedInPacket everywhere.
 */
import type { DocumentKind } from "./api";

/** Proof-doc kinds eligible for an invoice packet, in the canonical order
 *  they appear in the merged PDF (PODs first). `rate_con` is attached
 *  separately (always last) and `invoice` / `invoice_packet` are outputs,
 *  so none of those appear here. */
export const PACKET_DOC_KINDS = [
  "pod",
  "bol",
  "lumper",
  "scale",
  "receipt",
  "driver_sheet",
] as const satisfies readonly DocumentKind[];

export type PacketDocKind = (typeof PACKET_DOC_KINDS)[number];

export function isPacketDocKind(kind: string): kind is PacketDocKind {
  return (PACKET_DOC_KINDS as readonly string[]).includes(kind);
}

/** Human labels for the packet kinds — used by the settings checklist and
 *  any picker that needs to name a kind. */
export const PACKET_DOC_KIND_LABEL: Record<PacketDocKind, string> = {
  pod:          "Proof of delivery (POD)",
  bol:          "Bill of lading (BOL)",
  lumper:       "Lumper receipt",
  scale:        "Scale ticket",
  receipt:      "Receipt",
  driver_sheet: "Driver sheet",
};

/** Kinds auto-included when a doc has NOT been explicitly toggled. PODs
 *  only — brokers require proof of delivery and it's the one kind a carrier
 *  always wants to send. Every other kind (BOL, scale, fuel receipt,
 *  lumper, driver sheet) is opt-in per org via
 *  org_settings.invoice_auto_include_kinds. */
export const DEFAULT_INVOICE_AUTO_INCLUDE_KINDS: PacketDocKind[] = ["pod"];

/** Minimal doc shape the rule needs. Works for the web's camelCase doc and
 *  the API row alike (map `included_in_invoice` → `includedInInvoice` at the
 *  call site). */
export interface PacketSelectableDoc {
  kind: string;
  /** Explicit per-doc choice. true = always in, false = always out,
   *  null/undefined = fall back to the org's auto-include list. */
  includedInInvoice: boolean | null | undefined;
}

/**
 * THE rule. Does this document belong in the invoice packet?
 *
 *   explicit true  → IN   (dispatcher ticked it on)
 *   explicit false → OUT  (dispatcher ticked it off)
 *   null/undefined → IN  iff the org auto-includes this kind
 *
 * No "newest of its kind" trimming: when a kind is auto-included, ALL docs
 * of that kind go in (minus any explicitly ticked off). Dispatchers asked
 * for "pick a type → all of that type ships"; per-doc unticking is the
 * escape hatch for the rare duplicate.
 */
export function isDocIncludedInPacket(
  doc: PacketSelectableDoc,
  autoIncludeKinds: readonly string[],
): boolean {
  if (doc.includedInInvoice === true)  return true;
  if (doc.includedInInvoice === false) return false;
  return autoIncludeKinds.includes(doc.kind);
}

/**
 * Normalize a stored setting value into the kinds to auto-include.
 *
 *   null / undefined → never configured → the POD default
 *   []               → explicitly configured to auto-include nothing
 *   ["pod", "bol"]   → exactly those (junk kinds filtered out)
 *
 * Both the server resolver and the UI run every doc through this so an
 * absent setting means "PODs" rather than "nothing", but a deliberately
 * cleared list is respected.
 */
export function resolveAutoIncludeKinds(
  stored: readonly string[] | null | undefined,
): PacketDocKind[] {
  if (stored == null) return [...DEFAULT_INVOICE_AUTO_INCLUDE_KINDS];
  return stored.filter(isPacketDocKind);
}
