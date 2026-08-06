/**
 * Renders signed contract documents to PDF from the same block structure the
 * signing page displays, so the filed document and the thing the driver read
 * cannot diverge.
 *
 * Layout is deliberately plain — this is a legal record, not a brochure.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Block, ContractDocument } from "./ica.js";

const PAGE_W = 612;   // US Letter, 72dpi
const PAGE_H = 792;
const MARGIN = 60;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.35, 0.4, 0.46);
const RULE = rgb(0.82, 0.8, 0.76);

interface Run { text: string; bold: boolean }

/** Splits `**bold**` markup into runs. */
function toRuns(text: string): Run[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("**") && part.endsWith("**")
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false }
    );
}

/** Greedy word wrap that keeps run boundaries, so bold survives wrapping. */
function wrapRuns(
  runs: Run[], regular: PDFFont, bold: PDFFont, size: number, maxWidth: number
): Run[][] {
  const lines: Run[][] = [];
  let line: Run[] = [];
  let width = 0;

  for (const run of runs) {
    const font = run.bold ? bold : regular;
    for (const word of run.text.split(/(\s+)/)) {
      if (!word) continue;
      const w = font.widthOfTextAtSize(word, size);
      if (width + w > maxWidth && line.length && word.trim()) {
        lines.push(line);
        line = [];
        width = 0;
        if (!word.trim()) continue;
      }
      line.push({ text: word, bold: run.bold });
      width += w;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

export interface SignatureInfo {
  contractorName: string;
  signedName: string;
  signedAt: Date;
  signedIp: string;
  signedUserAgent: string;
  companySigner: string;
  effectiveDate: string;
}

export async function buildContractPdf(
  documents: ContractDocument[],
  signature: SignatureInfo
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const need = (space: number) => {
    if (y - space < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const drawRuns = (runs: Run[], size: number, indent = 0, color = INK) => {
    const lines = wrapRuns(runs, regular, bold, size, CONTENT_W - indent);
    const lineHeight = size * 1.45;
    for (const line of lines) {
      need(lineHeight);
      let x = MARGIN + indent;
      // Merge adjacent same-weight runs into one drawText. Drawing word by
      // word positions correctly but produces a PDF whose extracted text has
      // no spaces — copy/paste and search both break on a legal document.
      const merged: Run[] = [];
      for (const run of line) {
        const last = merged[merged.length - 1];
        if (last && last.bold === run.bold) last.text += run.text;
        else merged.push({ ...run });
      }
      for (const run of merged) {
        const font = run.bold ? bold : regular;
        page.drawText(run.text, { x, y: y - size, size, font, color });
        x += font.widthOfTextAtSize(run.text, size);
      }
      y -= lineHeight;
    }
  };

  const gap = (n: number) => { need(n); y -= n; };

  for (const [index, doc] of documents.entries()) {
    if (index > 0) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }

    // Letterhead. The source document carries the logo image; a wordmark keeps
    // this dependency-free and prints identically in black and white.
    page.drawText("CURZON TRUCKING LLC", {
      x: MARGIN, y: y - 9, size: 9, font: bold, color: MUTED,
    });
    y -= 30;

    for (const block of doc.blocks) {
      switch (block.type) {
        case "h1":
          gap(6);
          drawRuns(toRuns(block.text), 17);
          gap(8);
          break;
        case "h2":
          gap(12);
          drawRuns(toRuns(block.text), 13);
          gap(4);
          break;
        case "h3":
          gap(8);
          drawRuns(toRuns(block.text), 11);
          gap(2);
          break;
        case "p":
          drawRuns(toRuns(block.text), 10);
          gap(6);
          break;
        case "ul":
        case "ul2": {
          const indent = block.type === "ul2" ? 40 : 20;
          for (const item of block.items) {
            need(14);
            page.drawText("•", { x: MARGIN + indent - 12, y: y - 10, size: 10, font: regular, color: INK });
            drawRuns(toRuns(item), 10, indent);
          }
          gap(6);
          break;
        }
        case "rule":
          gap(8);
          need(10);
          page.drawLine({
            start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y },
            thickness: 0.7, color: RULE,
          });
          gap(12);
          break;
        case "fieldline":
          need(16);
          drawRuns(
            [{ text: block.label + " ", bold: true }, { text: block.value, bold: false }],
            10
          );
          gap(2);
          break;
        case "signature": {
          gap(10);
          need(64);
          const isCompany = block.party === "company";
          const label = isCompany ? "CURZON TRUCKING LLC" : "CONTRACTOR";
          const who = isCompany ? signature.companySigner : signature.signedName;
          const printed = isCompany ? signature.companySigner : signature.contractorName;

          drawRuns([{ text: label, bold: true }], 10);
          gap(4);

          // The typed name rendered as the signature mark.
          need(24);
          page.drawText(who, {
            x: MARGIN + 4, y: y - 13, size: 15, font: bold, color: INK,
          });
          y -= 20;
          page.drawLine({
            start: { x: MARGIN, y }, end: { x: MARGIN + 250, y },
            thickness: 0.7, color: RULE,
          });
          gap(12);
          drawRuns([{ text: `Printed Name: ${printed}`, bold: false }], 9, 0, MUTED);
          drawRuns(
            [{ text: `Date: ${signature.signedAt.toLocaleDateString("en-US", { timeZone: "America/Denver" })}`, bold: false }],
            9, 0, MUTED
          );
          gap(10);
          break;
        }
      }
    }
  }

  // ── Audit page ─────────────────────────────────────────────────────────
  // What makes the electronic signature defensible: who signed, when, from
  // where, and that they were shown these exact documents.
  page = pdf.addPage([PAGE_W, PAGE_H]);
  y = PAGE_H - MARGIN;
  drawRuns([{ text: "SIGNATURE AUDIT RECORD", bold: true }], 13);
  gap(10);
  page.drawLine({
    start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.7, color: RULE,
  });
  gap(16);

  const rows: [string, string][] = [
    ["Signed by", signature.signedName],
    ["Contractor of record", signature.contractorName],
    ["Effective date", signature.effectiveDate],
    ["Signed at", signature.signedAt.toISOString()],
    ["Mountain Time", signature.signedAt.toLocaleString("en-US", { timeZone: "America/Denver" })],
    ["IP address", signature.signedIp],
    ["Device", signature.signedUserAgent],
    ["Documents", documents.map((d) => d.title).join("; ")],
  ];

  for (const [label, value] of rows) {
    drawRuns([{ text: label, bold: true }], 9);
    drawRuns([{ text: value, bold: false }], 9, 0, MUTED);
    gap(6);
  }

  gap(10);
  drawRuns(
    [{
      text:
        "The signer consented to do business electronically and typed their name as an electronic " +
        "signature. This record was generated by Curzon Trucking at the time of signing.",
      bold: false,
    }],
    8, 0, MUTED
  );

  return pdf.save();
}
