/**
 * Scenarios for promoteLoadNumber. Run from apps/web:
 *   npx tsx lib/loadNumber.verify.ts
 *
 * Labels and values are taken from reference numbers actually present
 * on Curzon loads — including the low-precision ones the guard must
 * refuse (BOL, PO, Cust Ref, the bare EDI qualifiers some brokers
 * print) and the near-miss labels that look promotable but aren't
 * ("Purchase Order", "External Load Reference", bare "Shipment").
 *
 * See lib/loadNumber.labels.ts for where the precision figures behind
 * these decisions come from.
 */
import { promoteLoadNumber } from './loadNumber';

let pass = 0;
const failures: string[] = [];

function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  failures.push(`${name}\n    got:  ${g}\n    want: ${w}`);
}

const ref = (label: string, value: string) => ({ label, value });

// ── The reported failure ────────────────────────────────────────────
check('Freight Tec: PRO # becomes the load number',
  promoteLoadNumber('', [ref('PRO #', '1098153'), ref('Cust Ref', '3684214173')]).loadNum,
  '1098153');

check('Freight Tec: the promotion is reported',
  promoteLoadNumber('', [ref('PRO #', '1098153'), ref('Cust Ref', '3684214173')]).fromLabel,
  'PRO #');

// ── Never overwrite what the model extracted ────────────────────────
check('an extracted load number is left alone',
  promoteLoadNumber('10421', [ref('PRO #', '1098153')]).loadNum,
  '10421');

check('an extracted load number is not reported as promoted',
  promoteLoadNumber('10421', [ref('PRO #', '1098153')]).promoted,
  false);

check('whitespace-only load number counts as empty',
  promoteLoadNumber('   ', [ref('Order #', '55512')]).loadNum,
  '55512');

// ── Promotable labels ───────────────────────────────────────────────
check('Load Confirmation',
  promoteLoadNumber('', [ref('Load Confirmation', '448201')]).loadNum,
  '448201');

check('Our Reference',
  promoteLoadNumber('', [ref('Our Reference', 'ABC-99120')]).loadNum,
  'ABC-99120');

check('Order No',
  promoteLoadNumber('', [ref('Order No', '15920358')]).loadNum,
  '15920358');

check('Shipment ID is refused — it reads primary but backtests badly',
  promoteLoadNumber('', [ref('Shipment ID', '202605260190005595')]).loadNum,
  '');

check('Load ID',
  promoteLoadNumber('', [ref('Load ID', '8891234')]).loadNum,
  '8891234');

// ── Labels the data says are NOT the load number ────────────────────
check('BOL alone is refused',
  promoteLoadNumber('', [ref('BOL', '31245759')]).loadNum,
  '');

check('PO alone is refused',
  promoteLoadNumber('', [ref('PO #', '2848657')]).loadNum,
  '');

check('Cust Ref alone is refused',
  promoteLoadNumber('', [ref('Cust Ref', '3684214173')]).loadNum,
  '');

check('Pickup # alone is refused',
  promoteLoadNumber('', [ref('Pickup #', 'ER163158')]).loadNum,
  '');

check('bare Reference is refused',
  promoteLoadNumber('', [ref('Reference', 'VES326L')]).loadNum,
  '');

check('EDI qualifier labels are refused',
  promoteLoadNumber('', [ref('ZZ', '4482910'), ref('P8', '9981234')]).loadNum,
  '');

check('an unlabelled reference is refused',
  promoteLoadNumber('', [ref('', '11828654')]).loadNum,
  '');

check('bare Confirmation is refused (57% is a coin flip)',
  promoteLoadNumber('', [ref('Confirmation', '5512900')]).loadNum,
  '');

// ── First-word matching, which is what makes the list safe ──────────
check('Purchase Order is not an Order #',
  promoteLoadNumber('', [ref('Purchase Order', '170077')]).loadNum,
  '');

check('Sales Order is not an Order #',
  promoteLoadNumber('', [ref('Sales Order', '38505')]).loadNum,
  '');

check('Delivery Order is not an Order #',
  promoteLoadNumber('', [ref('Delivery Order', '29200880')]).loadNum,
  '');

check('External Load Reference is not a Load #',
  promoteLoadNumber('', [ref('External Load Reference', '44603443')]).loadNum,
  '');

check('bare Shipment is refused',
  promoteLoadNumber('', [ref('Shipment', '129389798')]).loadNum,
  '');

check('Shipper Ref is refused',
  promoteLoadNumber('', [ref('Shipper Ref', 'S105415')]).loadNum,
  '');

// ── Carrier identifiers are never a load number ─────────────────────
check('MC # is refused',
  promoteLoadNumber('', [ref('MC #', '1084339')]).loadNum,
  '');

check('DOT # is refused',
  promoteLoadNumber('', [ref('DOT #', '3345678')]).loadNum,
  '');

check('a carrier MC alongside a PRO does not win',
  promoteLoadNumber('', [ref('Carrier MC', '1084339'), ref('PRO #', '1098153')]).loadNum,
  '1098153');

check('Driver Reference Pro is refused',
  promoteLoadNumber('', [ref('Driver Reference Pro', '55120934')]).loadNum,
  '');

check('trailer number is refused',
  promoteLoadNumber('', [ref('Trailer #', '530112')]).loadNum,
  '');

// ── Ranking between promotable labels ───────────────────────────────
check('a promotable label beats a refused one regardless of order',
  promoteLoadNumber('', [ref('BOL', '99001'), ref('PRO #', '1098153')]).loadNum,
  '1098153');

check('Load # outranks Order #',
  promoteLoadNumber('', [ref('Order #', '55512'), ref('Load #', '10421')]).loadNum,
  '10421');

check('ties keep document order',
  promoteLoadNumber('', [ref('Order #', '11111'), ref('Order ID', '22222')]).loadNum,
  '11111');

// ── Value sanity ────────────────────────────────────────────────────
check('a date is not a load number',
  promoteLoadNumber('', [ref('Order #', '06/04/2026')]).loadNum,
  '');

check('a dollar figure is not a load number',
  promoteLoadNumber('', [ref('Load #', '3,900.00')]).loadNum,
  '');

check('a phone number is not a load number',
  promoteLoadNumber('', [ref('Order contact', '801-555-0134')]).loadNum,
  '');

check('a temperature is not a load number',
  promoteLoadNumber('', [ref('Load temp', '-10F')]).loadNum,
  '');

check('a short value is refused',
  promoteLoadNumber('', [ref('PRO #', '12')]).loadNum,
  '');

check('a word with no digits is refused',
  promoteLoadNumber('', [ref('Order #', 'PENDING')]).loadNum,
  '');

check('a sentence is refused',
  promoteLoadNumber('', [ref('Load #', 'see BOL at pickup 12345 for details')]).loadNum,
  '');

check('an alphanumeric load number is kept',
  promoteLoadNumber('', [ref('Load #', 'FT-1098153')]).loadNum,
  'FT-1098153');

check('a two-word identifier is kept',
  promoteLoadNumber('', [ref('Order #', 'ORD 44821')]).loadNum,
  'ORD 44821');

// ── Shapes the extractor actually returns ───────────────────────────
check('refNums arriving as a JSON string works',
  promoteLoadNumber('', '[{"label":"PRO #","value":"1098153"}]').loadNum,
  '1098153');

check('no refs leaves the field empty',
  promoteLoadNumber('', []).loadNum,
  '');

check('null refs leaves the field empty',
  promoteLoadNumber('', null).loadNum,
  '');

check('a bare comma list carries no labels and is not promoted',
  promoteLoadNumber('', 'REF-001, REF-002').loadNum,
  '');

check('malformed JSON does not throw',
  promoteLoadNumber('', '[{"label":').loadNum,
  '');

check('a ref missing its value is skipped',
  promoteLoadNumber('', [{ label: 'PRO #' }, ref('Order #', '99001')]).loadNum,
  '99001');

check('a non-string load number is treated as empty',
  promoteLoadNumber(null, [ref('PRO #', '1098153')]).loadNum,
  '1098153');

// ── Report ──────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL ${f}\n`);
process.exit(failures.length === 0 ? 0 : 1);
