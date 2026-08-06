/**
 * Independent Contractor Agreement + Exhibit A, as structured content.
 *
 * One source of truth: the signing page renders these blocks to HTML and the
 * PDF generator lays out the same blocks. A driver therefore cannot be shown
 * one thing and sign another — there is no second copy to drift.
 *
 * Only three values vary per driver. Everything else is boilerplate:
 *   {{effectiveDate}}      — drivers.active_from, the hire date
 *   {{contractorName}}     — drivers.name
 *   {{contractorAddress}}  — drivers.address
 *
 * Bump TEMPLATE_VERSION on any wording change. Signed contracts store the
 * version they were signed under, so a revision never rewrites history.
 */

export const TEMPLATE_VERSION = 1;

export type Block =
  | { type: "h1"; text: string }
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ul2"; items: string[] }       // nested bullets
  | { type: "rule" }
  | { type: "fieldline"; label: string; value: string }
  | { type: "signature"; party: "company" | "contractor" };

export interface ContractDocument {
  key: string;
  title: string;
  blocks: Block[];
}

// `**bold**` is the only inline markup; both renderers understand it.
const ICA_BLOCKS: Block[] = [
  { type: "h1", text: "INDEPENDENT CONTRACTOR AGREEMENT" },
  {
    type: "p",
    text:
      'This Independent Contractor Agreement ("Agreement") is entered into as of {{effectiveDate}} ("Effective Date"), by and between:',
  },
  { type: "p", text: '**Curzon Trucking LLC**, a Utah limited liability company ("Company"), and' },
  { type: "fieldline", label: "Contractor Name:", value: "{{contractorName}}" },
  { type: "fieldline", label: "Address:", value: "{{contractorAddress}}" },
  { type: "p", text: '("Contractor")' },
  { type: "rule" },

  { type: "h2", text: "1. Independent Contractor Relationship" },
  {
    type: "p",
    text:
      "The parties agree that Contractor is an **independent contractor**, and not an employee, partner, joint venturer, or agent of the Company. Nothing in this Agreement shall be construed to create an employer–employee relationship.",
  },
  { type: "p", text: "Contractor is solely responsible for:" },
  {
    type: "ul",
    items: [
      "All federal, state, and local taxes",
      "Self-employment taxes",
      "Workers' compensation insurance (if applicable)",
      "Unemployment insurance",
      "Health insurance and benefits",
    ],
  },
  { type: "p", text: "Contractor is not eligible for Company employee benefits." },
  { type: "rule" },

  { type: "h2", text: "2. Scope of Services" },
  {
    type: "p",
    text:
      "Contractor agrees to provide commercial motor vehicle driving services on behalf of the Company, including but not limited to:",
  },
  {
    type: "ul",
    items: [
      "Transporting freight as dispatched",
      "Operating equipment in a safe and professional manner",
      "Complying with all DOT, FMCSA, state, and local laws",
    ],
  },
  {
    type: "p",
    text:
      "Contractor retains discretion over the manner and means of performing the services, subject to safety, customer, and legal requirements.",
  },
  { type: "rule" },

  { type: "h2", text: "3. Equipment" },
  {
    type: "p",
    text:
      "All equipment used in the performance of services under this Agreement is **company-provided equipment**.",
  },
  { type: "p", text: "Contractor agrees to:" },
  {
    type: "ul",
    items: [
      "Use Company equipment solely for authorized business purposes",
      "Operate equipment in a safe and professional manner",
      "Perform required pre-trip and post-trip inspections",
      "Promptly report any mechanical issues, defects, or damage",
    ],
  },
  {
    type: "p",
    text:
      "Contractor shall be financially responsible for damage caused by negligence, misuse, or failure to follow Company procedures, subject to applicable law.",
  },
  { type: "rule" },

  { type: "h2", text: "4. Compensation" },
  {
    type: "p",
    text:
      "Contractor shall be compensated on a **per load and/or per route basis**, as agreed for each dispatched load.",
  },
  { type: "p", text: "Compensation structure may include:" },
  {
    type: "ul",
    items: [
      "Per-load payment",
      "Per-route payment",
      "Other agreed-upon load-specific rates confirmed at dispatch",
    ],
  },
  {
    type: "p",
    text:
      "No compensation is guaranteed, and payment is earned only upon satisfactory completion of the assigned load in compliance with Company, customer, and legal requirements.",
  },
  {
    type: "p",
    text:
      "From time to time, Contractor may be requested to perform **non-load related activities**, including but not limited to:",
  },
  {
    type: "ul",
    items: [
      "Taking Company equipment to or from a repair or maintenance facility",
      "Moving or repositioning Company trailers or equipment",
      "Other operational tasks not directly associated with hauling a dispatched load",
    ],
  },
  {
    type: "p",
    text:
      "For approved non-load related activities, Contractor will be compensated at an **hourly rate**, typically ranging from **$25–$30 per hour**, based on Contractor tenure, experience, and the nature of the task. Hourly compensation applies only when such activities are approved or requested by the Company.",
  },

  { type: "h3", text: "Accessorial Pay" },
  {
    type: "p",
    text:
      "The following accessorial payments may apply **when approved by the broker or customer for the specific load**:",
  },
  { type: "ul", items: ["**Detention pay**", "**Layover pay**", "**TONU (Truck Ordered Not Used)**"] },
  { type: "p", text: "Accessorial pay:" },
  {
    type: "ul",
    items: [
      "Is load-specific and not guaranteed",
      "Must be properly documented and submitted in accordance with Company procedures",
      "**Will be paid with the Contractor's weekly settlement once broker or customer approval is confirmed**",
      "**Contractor is not required to wait for the Company to receive payment from the broker or customer**",
    ],
  },

  { type: "h3", text: "Payment Terms" },
  {
    type: "ul",
    items: [
      "Settlements are issued **weekly**",
      "Payments are based on completed and approved loads",
      "Payments will be made via **Zelle, Venmo, ACH transfer, or other mutually agreed-upon method**",
      "Contractor authorizes lawful deductions including, but not limited to: fuel advances, insurance charges, equipment damage, tolls, and other agreed expenses",
    ],
  },

  { type: "h3", text: "Tax Reporting" },
  {
    type: "p",
    text:
      "Contractor acknowledges that they are responsible for all applicable taxes arising from compensation paid under this Agreement. The Company will issue an **IRS Form 1099** to Contractor for each calendar year as required by law. Contractor agrees to provide accurate tax information (including a completed Form W-9) and to update such information as necessary.",
  },
  { type: "rule" },

  { type: "h2", text: "5. Expenses & Responsibilities" },
  { type: "h3", text: "Contractor Responsibilities" },
  {
    type: "p",
    text:
      "Except as otherwise approved in writing by the Company, Contractor is solely responsible for:",
  },
  {
    type: "ul",
    items: [
      "Transportation to and from the assigned place of work, including travel to and from the truck or terminal",
      "Maintaining their own means of communication, including mobile phone service and data plans",
      "Meals, provided that **lodging while on an approved dispatched load is fully covered by the Company**",
      "Any fines, citations, tickets, penalties, or violations caused by Contractor, including but not limited to traffic, parking, scale, or regulatory citations",
    ],
  },
  { type: "h3", text: "Company-Covered Expenses" },
  { type: "p", text: "The Company is responsible for the following operational expenses:" },
  {
    type: "ul",
    items: [
      "Fuel",
      "Routine and non-routine maintenance and repairs",
      "Dispatch and operational support",
      "Required permits, toll programs, and compliance-related operational costs",
      "Other operating expenses directly related to the movement of freight, as determined by the Company",
    ],
  },
  {
    type: "p",
    text:
      "Nothing in this section shall be interpreted to shift personal expenses to the Company or to alter Contractor's independent contractor status.",
  },
  { type: "rule" },

  { type: "h2", text: "6. Safety, Communication & Compliance" },
  { type: "p", text: "Contractor agrees to:" },
  {
    type: "ul",
    items: [
      "Maintain regular and timely communication with Company dispatch",
      "Provide required broker or customer check calls and status updates",
      "Use Company-required and broker-required applications or systems for load tracking, communication, and operational coordination",
      "Comply with all DOT, FMCSA, state, and local regulations",
      "Maintain a valid CDL and medical certification",
      "Use ELDs, dash cameras, and safety technology as required",
    ],
  },
  {
    type: "p",
    text:
      "Contractor is **not required to text, message, or otherwise communicate while driving** and must comply with all distracted-driving and hands-free laws. Safety takes priority over communication timing.",
  },
  {
    type: "p",
    text:
      "Failure to comply with communication or compliance requirements may result in suspension or termination.",
  },
  { type: "rule" },

  { type: "h2", text: "7. Accidents, At-Fault Incidents & Chargebacks" },
  { type: "h3", text: "A. Accident Reporting" },
  {
    type: "p",
    text:
      "Contractor agrees to immediately report all accidents, incidents, damages, or claims involving Company equipment, customer freight, or third-party property. Contractor must fully cooperate with investigations, insurers, and Company requests.",
  },
  { type: "h3", text: "B. At-Fault (Preventable) vs. Non-Preventable Incidents" },
  {
    type: "p",
    text:
      "A **preventable (at-fault) incident** is any event where the Contractor's actions or failure to act reasonably contributed to an accident, damage, loss, or citation.",
  },
  { type: "p", text: "**Common Preventable Examples (Non-Exhaustive):**" },
  {
    type: "ul",
    items: [
      "Rear-end collisions",
      "Backing accidents or dock strikes",
      "Striking stationary objects, curbs, poles, or structures",
      "Unsafe lane changes or improper turns",
      "Speeding-related incidents",
      "Failure to adjust driving for weather or road conditions",
      "Improper load securement",
      "Failure to follow posted restrictions (height, weight, clearance)",
    ],
  },
  {
    type: "p",
    text:
      "A **non-preventable incident** is an event where the Contractor exercised reasonable care and the incident was not avoidable.",
  },
  { type: "p", text: "**Common Non-Preventable Examples (Non-Exhaustive):**" },
  {
    type: "ul",
    items: [
      "Being struck by another vehicle while legally stopped or parked",
      "Incidents caused solely by third parties",
      "Road debris that could not reasonably be avoided",
      "Sudden mechanical failures not caused by negligence or missed inspections",
      "Weather-related incidents where reasonable precautions were taken",
    ],
  },
  {
    type: "p",
    text:
      "Preventability will be determined by the Company based on available evidence, insurer guidance, and industry standards.",
  },
  { type: "h3", text: "C. Chargebacks to Contractor" },
  {
    type: "p",
    text:
      "In the event of an at-fault (preventable) incident, Contractor agrees that the Company may charge back to Contractor, to the extent permitted by law, costs including but not limited to insurance deductibles, repairs, claims, and related expenses.",
  },
  { type: "p", text: "**Common At-Fault Incidents & Industry-Standard Cost Ranges (Illustrative)**" },
  {
    type: "p",
    text:
      "The amounts below reflect **typical industry repair or claim costs**. Actual chargebacks will be based on **actual invoices or insurer determinations** and may be higher or lower depending on severity.",
  },
  {
    type: "ul",
    items: [
      "**Front bumper damage (tractor):** $1,500 – $4,000 (replacement & install)",
      "**Rear/side bumper or underride guard damage:** $1,000 – $3,000",
      "**Mirror assembly damage:** $300 – $1,200",
      "**Headlight / taillight assembly:** $250 – $1,500",
      "**Door, fairing, or side panel damage:** $1,000 – $6,000",
      "**Hood damage:** $3,000 – $10,000",
      "**Windshield replacement:** $400 – $1,200",
      "**Tire damage due to curb strike or misuse:** $350 – $700 per tire",
      "**Wheel/rim damage:** $500 – $1,500 per wheel",
      "**Trailer sidewall or door damage:** $1,000 – $8,000",
      "**Landing gear damage:** $800 – $2,500",
      "**Dock strike (tractor/trailer):** $1,500 – $10,000+",
      "**Customer property damage:** Actual cost billed by customer",
      "**Cargo damage due to improper securement or handling:** Actual claim amount",
      "**Towing / recovery after preventable incident:** $500 – $5,000+",
      "**Cleanup or hazmat response (if applicable):** Actual invoiced cost",
      "**Insurance deductible (preventable accident):** $5,000",
    ],
  },
  { type: "p", text: "Chargebacks may be applied:" },
  { type: "ul", items: ["As deductions from future settlements, or", "As direct invoicing to Contractor"] },
  { type: "rule" },

  { type: "h2", text: "8. Insurance" },
  { type: "h3", text: "Company Insurance" },
  {
    type: "p",
    text:
      "The Company maintains **motor carrier insurance as required by applicable law**, including liability coverage for the operation of Company equipment.",
  },
  { type: "h3", text: "Contractor Insurance" },
  {
    type: "p",
    text:
      "Contractor is solely responsible for maintaining their own insurance coverage, including but not limited to:",
  },
  {
    type: "ul",
    items: ["**Occupational accident insurance**, and/or", "**Contractor liability or other personal coverage**, as applicable"],
  },
  {
    type: "p",
    text:
      "Contractor acknowledges that the Company does **not** provide workers' compensation coverage, health insurance, disability insurance, or personal liability coverage for Contractor.",
  },
  { type: "p", text: "Proof of required Contractor insurance may be requested by the Company." },
  { type: "rule" },

  { type: "h2", text: "9. Term & Termination" },
  { type: "h3", text: "Term" },
  {
    type: "p",
    text:
      "This Agreement shall commence on **{{effectiveDate}}** and shall continue on an **ongoing, indefinite basis** unless and until terminated as provided herein.",
  },
  { type: "h3", text: "Termination" },
  {
    type: "p",
    text:
      "Either party may terminate this Agreement **at any time**, **with or without cause**, upon written or electronic notice to the other party.",
  },
  {
    type: "p",
    text:
      "The Company may terminate this Agreement immediately for safety violations, illegal conduct, material breach, or failure to comply with Company or regulatory requirements.",
  },
  {
    type: "p",
    text:
      "Termination shall not relieve either party of obligations accrued prior to termination, including payment of earned compensation or outstanding chargebacks, as permitted by law.",
  },
  { type: "rule" },

  { type: "h2", text: "10. Dispatch & Non-Exclusivity" },
  {
    type: "p",
    text:
      "There is **no forced dispatch** under this Agreement. Contractor retains the right to **accept or decline any offered load or route**.",
  },
  {
    type: "p",
    text:
      "Contractor acknowledges that acceptance decisions may be considered by the Company when determining **future load offerings**, operational planning, or dispatch priority. Such consideration does not create any obligation on either party.",
  },
  {
    type: "p",
    text:
      "Contractor may perform services for other motor carriers or customers, provided such services do not interfere with Contractor's obligations under accepted loads with the Company or violate applicable law.",
  },
  { type: "rule" },

  { type: "h2", text: "11. Confidentiality" },
  {
    type: "p",
    text:
      "Contractor agrees to keep confidential all non-public Company information, including customer lists, rates, and operations.",
  },
  { type: "rule" },

  { type: "h2", text: "12. Indemnification" },
  {
    type: "p",
    text:
      "Contractor agrees to indemnify and hold harmless the Company from claims, damages, or losses arising from Contractor's negligence, misconduct, or violation of law, to the extent permitted by law.",
  },
  { type: "rule" },

  { type: "h2", text: "13. Governing Law" },
  { type: "p", text: "This Agreement shall be governed by the laws of the State of Utah." },
  { type: "rule" },

  { type: "h2", text: "14. Entire Agreement" },
  {
    type: "p",
    text:
      "This Agreement constitutes the entire agreement between the parties and supersedes all prior agreements or understandings.",
  },
  { type: "p", text: "Any modifications must be in writing and signed by both parties." },
  { type: "rule" },

  { type: "h2", text: "15. Independent Contractor Compliance" },
  {
    type: "p",
    text:
      "The parties intend to create and maintain an **independent contractor relationship**. Contractor retains control over the manner and means of performing services, may accept or decline work, may perform services for other carriers, supplies their own tools incidental to performance (including communication devices), bears the risk of profit or loss, and is paid by the job or approved task rather than by time, except for limited, task-based non-load activities approved in advance. Nothing in this Agreement shall be construed to create an employment relationship.",
  },
  { type: "rule" },

  { type: "h2", text: "16. Acknowledgment" },
  {
    type: "p",
    text:
      "By signing below, Contractor acknowledges that they have read, understand, and agree to the terms of this Independent Contractor Agreement.",
  },
  { type: "rule" },
  { type: "signature", party: "company" },
  { type: "signature", party: "contractor" },
];

const EXHIBIT_A_BLOCKS: Block[] = [
  { type: "h1", text: "EXHIBIT A – SAFETY BONUS ADDENDUM (2026)" },
  {
    type: "p",
    text:
      'This Safety Bonus Addendum ("Addendum") is incorporated into and made part of the Independent Contractor Agreement between **Curzon Trucking LLC** ("Company") and **Contractor**.',
  },
  { type: "rule" },

  { type: "h2", text: "1. Program Overview" },
  {
    type: "p",
    text:
      "The Company offers a Safety Bonus Program designed to reward Contractors who operate safely, protect Company equipment, and comply with Company and regulatory standards.",
  },
  {
    type: "p",
    text:
      "Participation is voluntary and discretionary. This Addendum does not guarantee payment and does not alter Contractor's independent contractor status.",
  },
  { type: "rule" },

  { type: "h2", text: "2. Monthly Safety Bonus" },
  {
    type: "ul",
    items: [
      "**Bonus Amount:** $250 per month",
      "Bonus is evaluated on a **monthly basis**",
      "Each month stands alone",
    ],
  },
  { type: "p", text: "**Maximum Annual Monthly Bonus:** $3,000 ($250 × 12 months)" },
  { type: "rule" },

  { type: "h2", text: "3. Annual Safety Excellence Bonuses" },
  { type: "h3", text: "A. Safety Excellence Bonus – All Qualifying Contractors" },
  {
    type: "ul",
    items: [
      "**$1,000 year-end Safety Excellence Bonus** paid to **each Contractor** who earns the Monthly Safety Bonus for **all twelve (12) months** of the calendar year",
    ],
  },
  { type: "h3", text: "B. Safest Driver of the Year Award" },
  { type: "ul", items: ["**Additional $1,500 bonus** awarded to **one (1) Contractor** per calendar year"] },
  { type: "ul", items: ["Contractor must:"] },
  {
    type: "ul2",
    items: [
      "Earn the Monthly Safety Bonus for all twelve (12) months, and",
      "Be selected by Company supervisors as the **Safest Driver of the Year**",
    ],
  },
  { type: "p", text: "Selection is discretionary and based on overall safety performance." },
  { type: "p", text: "**Safest Driver Selection – Scorecard (Guideline Only):**" },
  {
    type: "ul",
    items: [
      "Preventable incidents: **0 required**",
      "DOT / law enforcement violations: **0 required**",
      "Equipment care & cleanliness: **0–5 points**",
      "Compliance with procedures & paperwork: **0–5 points**",
      "Professionalism with customers & dispatch: **0–5 points**",
    ],
  },
  {
    type: "p",
    text:
      "The scorecard is used as a guideline only and does not create a guarantee of selection or payment.",
  },
  { type: "rule" },

  { type: "h2", text: "4. Monthly Safety Performance Requirements" },
  {
    type: "p",
    text:
      "To earn the Monthly Safety Bonus, Contractor must meet **all** of the following during the applicable month:",
  },
  { type: "h3", text: "A. No Preventable (At-Fault) Incidents" },
  {
    type: "p",
    text:
      "A preventable incident is any event where Contractor's actions or failure to act reasonably contributed to an accident, damage, loss, or citation.",
  },
  { type: "p", text: "**Preventable examples include (non-exhaustive):**" },
  {
    type: "ul",
    items: [
      "Rear-end collisions",
      "Backing accidents or dock strikes",
      "Striking stationary objects",
      "Unsafe lane changes or improper turns",
      "Speeding-related incidents",
      "Improper load securement",
    ],
  },
  { type: "p", text: "**Non-preventable examples include (non-exhaustive):**" },
  {
    type: "ul",
    items: [
      "Being struck by another vehicle while legally stopped",
      "Incidents caused solely by third parties",
      "Unavoidable road debris",
      "Sudden mechanical failures not caused by negligence",
    ],
  },
  {
    type: "p",
    text: "Preventability is determined by the Company using available evidence and industry standards.",
  },
  { type: "h3", text: "B. No Major Violations" },
  { type: "p", text: "Including but not limited to:" },
  {
    type: "ul",
    items: ["DUI / DWI", "Reckless driving", "Speeding 15+ mph over posted limit", "Falsified logs or records"],
  },
  { type: "h3", text: "C. Proper Equipment Care" },
  { type: "ul", items: ["No negligent or preventable damage to Company equipment or customer property"] },
  { type: "h3", text: "D. Safety Technology Compliance" },
  {
    type: "ul",
    items: [
      "Proper use of ELDs, dash cameras, and required safety systems",
      "No tampering with or disabling of safety equipment",
    ],
  },
  { type: "rule" },

  { type: "h2", text: "5. Bonus Forfeiture" },
  {
    type: "ul",
    items: [
      "Any preventable incident or major violation during a month results in **loss of the Monthly Safety Bonus for that month**",
      "Serious incidents may impact future eligibility for monthly or annual bonuses",
    ],
  },
  { type: "rule" },

  { type: "h2", text: "6. Payout Timing" },
  {
    type: "ul",
    items: [
      "Monthly bonuses are paid with **weekly settlements** following month-end review",
      "**Annual Safety Excellence Bonuses ($1,000 and $1,500)** are paid **within fifteen (15) days after year-end**",
      "Contractor must be actively contracted at time of payout unless approved otherwise",
    ],
  },
  { type: "rule" },

  { type: "h2", text: "7. Company Discretion" },
  {
    type: "p",
    text:
      "The Company reserves the right to interpret, administer, modify, suspend, or terminate the Safety Bonus Program at any time. All determinations are final.",
  },
  { type: "rule" },

  { type: "h2", text: "8. No Guaranteed Compensation" },
  {
    type: "p",
    text:
      "Safety bonuses are incentives only and are **not guaranteed compensation**. This Addendum does not create an employment relationship.",
  },
  { type: "rule" },
  { type: "signature", party: "company" },
  { type: "signature", party: "contractor" },
];

export const ICA_DOCUMENTS: ContractDocument[] = [
  { key: "ica", title: "Independent Contractor Agreement", blocks: ICA_BLOCKS },
  { key: "exhibit-a", title: "Exhibit A – Safety Bonus Addendum (2026)", blocks: EXHIBIT_A_BLOCKS },
];

/** Substitutes the per-driver values into a copy of the blocks. */
export function renderDocuments(values: {
  effectiveDate: string;
  contractorName: string;
  contractorAddress: string;
}): ContractDocument[] {
  const swap = (text: string) =>
    text
      .replace(/\{\{effectiveDate\}\}/g, values.effectiveDate)
      .replace(/\{\{contractorName\}\}/g, values.contractorName)
      .replace(/\{\{contractorAddress\}\}/g, values.contractorAddress || "—");

  return ICA_DOCUMENTS.map((doc) => ({
    ...doc,
    blocks: doc.blocks.map((block) => {
      if (block.type === "p" || block.type === "h1" || block.type === "h2" || block.type === "h3") {
        return { ...block, text: swap(block.text) };
      }
      if (block.type === "ul" || block.type === "ul2") {
        return { ...block, items: block.items.map(swap) };
      }
      if (block.type === "fieldline") {
        return { ...block, value: swap(block.value) };
      }
      return block;
    }),
  }));
}
