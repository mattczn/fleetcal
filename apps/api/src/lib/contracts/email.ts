/**
 * Delivers the signed agreement — one email, everyone on it.
 *
 * The driver and the office get the same message with the same attachment, so
 * there is one artifact in circulation rather than a copy each. The driver is
 * a To: recipient, not BCC: they should be able to see the office has it too.
 *
 * Failure here must never fail the signature. The agreement is already stored
 * and recorded by the time this runs; a bounced email is a resend, not a lost
 * contract.
 */

import { Resend } from "resend";
import { env } from "../env.js";

const FROM = process.env.CONTRACT_FROM_EMAIL || "FleetCal <contracts@fleetcal.app>";

/** Office copies. Defaults to Curzon's two while `hiring` is a single-org
 *  module; per-org recipients move to org_settings when it isn't. */
const NOTIFY = (process.env.CONTRACT_NOTIFY_TO ||
  "matt@curzontrucking.com,jon@curzontrucking.com")
  .split(",")
  .map((address) => address.trim())
  .filter(Boolean);

export interface SendSignedContractArgs {
  driverName: string;
  driverEmail?: string | null;
  signedAt: Date;
  pdf: Buffer;
}

export type SendSignedContractResult =
  | { ok: true; to: string[] }
  | { ok: false; reason: string };

export async function sendSignedContract(
  args: SendSignedContractArgs
): Promise<SendSignedContractResult> {
  if (!env.resendApiKey) return { ok: false, reason: "not_configured" };

  const to = [...NOTIFY];
  if (args.driverEmail && args.driverEmail.includes("@")) to.push(args.driverEmail.trim());
  if (!to.length) return { ok: false, reason: "no_recipients" };

  const signedOn = args.signedAt.toLocaleString("en-US", {
    timeZone: "America/Denver",
    dateStyle: "long",
    timeStyle: "short",
  });

  const safeName = args.driverName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  try {
    const resend = new Resend(env.resendApiKey);
    const { error } = await resend.emails.send({
      from: FROM,
      to,
      subject: `Signed Independent Contractor Agreement — ${args.driverName}`,
      text:
        `${args.driverName} signed the Independent Contractor Agreement on ${signedOn} MT.\n\n` +
        `The signed PDF is attached, including the signature audit record.\n\n` +
        `Keep this copy for your records.`,
      attachments: [
        { filename: `${safeName}-contractor-agreement.pdf`, content: args.pdf },
      ],
    });

    if (error) {
      console.error("[contracts] signed-agreement email failed:", error);
      return { ok: false, reason: "send_failed" };
    }
    return { ok: true, to };
  } catch (err) {
    console.error("[contracts] signed-agreement email threw:", err);
    return { ok: false, reason: "exception" };
  }
}
