'use client';

/**
 * CapabilitySelector — the "More than just a calendar" section on
 * /product/calendar. Tabs on the left switch a FIXED-SIZE detail card on the
 * right: every tab gets the same template — kicker, one-line title, a 2-line
 * description, and a uniform "preview card" in a fixed-height canvas — so the
 * card never resizes between features. Illustrative — sample copy, not data.
 */
import { useState } from 'react';
import { ArrowLeftRight, Plus, History, Wrench, FileText, FileCheck, Star, Clock, User, Container, Inbox, ChevronDown, Check } from 'lucide-react';

const MONO = 'JetBrains Mono, monospace';

type Tab = {
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }>;
  tab: string; kicker: string; title: string; desc: string; color: string; light: string;
};

const TABS: ReadonlyArray<Tab> = [
  { Icon: ArrowLeftRight, tab: 'Relay Loads', kicker: 'Relay & split', title: 'Split a load across your trucks.', desc: 'Break a load into as many legs as the lane needs, with a yard or relay point at every handoff. Each leg gets its own driver, equipment, and stops.', color: '#6941c6', light: '#f3e8fd' },
  { Icon: Plus, tab: 'Accessorials', kicker: 'Accessorials → pay', title: 'Accessorials flow to driver pay.', desc: 'Add detention, lumper, fuel advances, and more right in the load editor. Track each one and pay the amount straight to the driver.', color: '#1e8e3e', light: '#e6f4ea' },
  { Icon: History, tab: 'Load History', kicker: 'Load history', title: 'Track every change to a load.', desc: 'Every upload, status change, and billing move is timestamped on the load. Scroll the full audit trail without leaving the event.', color: '#5f6368', light: '#eef1f4' },
  { Icon: Wrench, tab: 'Non-revenue events', kicker: 'Non-revenue events', title: 'Maintenance and non-revenue.', desc: 'Block maintenance, trailer moves, deadhead, and inspections on the board. A striped event marks a truck as busy but not revenue.', color: '#1a73e8', light: '#e8f0fe' },
  { Icon: FileText, tab: 'POD tags', kicker: 'POD tags', title: 'POD tags, at a glance.', desc: 'A green POD tag lands on the load card the moment the driver uploads proof of delivery, so you never click in to check.', color: '#1e8e3e', light: '#e6f4ea' },
  { Icon: Container, tab: 'Trailer Assignments', kicker: 'Trailer assignments', title: 'Assign the right trailer to every load.', desc: 'Add your trailers to the system and pick one inside the load editor. Drivers can even report which trailer they’re pulling from the FleetCal app.', color: '#0e8a8a', light: '#defafa' },
  { Icon: Inbox, tab: 'Unassigned load queue', kicker: 'Unassigned queue', title: 'Loads wait in the unassigned column.', desc: 'Every load sits in the unassigned column until you assign a truck. As the queue fills, find the gaps that best fit each truck’s availability.', color: '#c5631e', light: '#fef0e6' },
];

// Uniform preview frame — same width, border, and header for every feature.
function Preview({ label, color, children }: { label: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ width: '100%', maxWidth: 540, background: '#fff', border: '1px solid #e8eaed', borderRadius: 12, boxShadow: '0 10px 28px -16px rgba(26,35,50,.28)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderBottom: '1px solid #eef1f4' }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
        <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368' }}>{label}</span>
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

function Pill({ text, color, bg }: { text: string; color: string; bg: string }) {
  return <span style={{ fontFamily: MONO, fontSize: 9.5, color, background: bg, borderRadius: 5, padding: '2px 6px' }}>{text}</span>;
}

function Switch({ on }: { on: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: on ? '#1e7a3d' : '#9aa0a6' }}>Pay driver</span>
      <span style={{ width: 28, height: 17, borderRadius: 999, background: on ? '#1e8e3e' : '#dadce0', position: 'relative', flex: 'none' }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 13 : 2, width: 13, height: 13, borderRadius: 999, background: '#fff', transition: 'left .15s' }} />
      </span>
    </span>
  );
}

// ── Per-feature visuals (all live inside <Preview>, same footprint) ──────

function RelayVisual() {
  const Stop = ({ c, light, label, place }: { c: string; light: string; label: string; place: string }) => (
    <>
      <span style={{ display: 'grid', placeItems: 'center', paddingTop: 2 }}><span style={{ width: 11, height: 11, borderRadius: 999, background: c, boxShadow: `0 0 0 3px ${light}` }} /></span>
      <div><span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: c }}>{label}</span><span className="font-display" style={{ fontWeight: 700, fontSize: 12.5, color: '#202124', marginLeft: 8 }}>{place}</span></div>
    </>
  );
  const Leg = ({ n, name, eq }: { n: string; name: string; eq: string }) => (
    <>
      <span style={{ display: 'grid', placeItems: 'center' }}><span style={{ width: 2, height: '100%', minHeight: 14, background: '#e0d4f5' }} /></span>
      <div style={{ padding: '4px 0' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#faf7ff', border: '1px solid #ece3fb', borderRadius: 8, padding: '5px 9px' }}><span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 600, color: '#fff', background: '#6941c6', borderRadius: 3, padding: '1px 5px' }}>{n}</span><span style={{ fontSize: 11.5, color: '#3c4043' }}><strong style={{ color: '#202124' }}>{name}</strong> · {eq}</span></span></div>
    </>
  );
  return (
    <Preview label="Load · Relay" color="#6941c6">
      <div style={{ display: 'grid', gridTemplateColumns: '14px 1fr', columnGap: 12, rowGap: 4 }}>
        <Stop c="#1e8e3e" light="#e6f4ea" label="PICKUP" place="Dallas, TX" />
        <Leg n="LEG 1" name="Carlos Ramirez" eq="Eagle #1043" />
        <Stop c="#6941c6" light="#f3e8fd" label="RELAY" place="Irving, TX" />
        <Leg n="LEG 2" name="Lennin Ramirez" eq="P-431985" />
        <Stop c="#d93025" light="#fce8e6" label="DELIVERY" place="Fort Worth, TX" />
      </div>
    </Preview>
  );
}

function AccessorialRow({ name, detail, amount, on }: { name: string; detail: string; amount: string; on: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid #f1f3f4' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124' }}>{name}</div>
        <div style={{ fontSize: 11.5, color: '#9aa0a6' }}>{detail}</div>
      </div>
      <span className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124', width: 52, textAlign: 'right' }}>{amount}</span>
      <Switch on={on} />
    </div>
  );
}

function AccessorialsVisual() {
  return (
    <Preview label="Load · Financials" color="#1e8e3e">
      <AccessorialRow name="Detention" detail="3 hrs · shipper" amount="$90" on />
      <AccessorialRow name="Lumper receipt" detail="Plano DC" amount="$40" on={false} />
      <AccessorialRow name="Fuel advance" detail="Comdata" amount="-$120" on />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #e8eaed', marginTop: 6, paddingTop: 9 }}>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368' }}>Paid to driver</span>
        <span className="font-display" style={{ fontWeight: 800, fontSize: 14, color: '#1e8e3e' }}>+$210.00</span>
      </div>
    </Preview>
  );
}

function HistRow({ dot, children, who }: { dot: string; children: React.ReactNode; who: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '7px 0' }}>
      <span style={{ marginTop: 5, width: 8, height: 8, flex: 'none', borderRadius: 999, background: dot }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, color: '#3c4043', lineHeight: 1.35, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{children}</div>
        <div style={{ fontSize: 11, color: '#9aa0a6', marginTop: 1 }}>{who}</div>
      </div>
    </div>
  );
}

function HistoryVisual() {
  return (
    <Preview label="Load · History" color="#5f6368">
      <HistRow dot="#7c3aed" who="Melanie Pavón · 9:16 AM"><strong style={{ fontFamily: MONO, fontSize: 10.5, color: '#6941c6' }}>RATE_CON</strong> uploaded</HistRow>
      <HistRow dot="#1a73e8" who="Eduardo Leon · 4:30 PM">Status <Pill text="scheduled" color="#5f6368" bg="#f1f3f4" /> → <Pill text="en_route" color="#1967d2" bg="#e8f0fe" /></HistRow>
      <HistRow dot="#1e8e3e" who="Eduardo Leon · 4:31 PM"><strong style={{ fontFamily: MONO, fontSize: 10.5, color: '#1e8e3e' }}>POD</strong> uploaded</HistRow>
      <HistRow dot="#0e8a8a" who="Invoicing · 9:39 AM">Billing <Pill text="verified" color="#0e8a8a" bg="#defafa" /> → <Pill text="invoiced" color="#3c4043" bg="#f1f3f4" /></HistRow>
    </Preview>
  );
}

function NonrevVisual() {
  return (
    <Preview label="Calendar · Eagle #1043" color="#1a73e8">
      <div style={{ display: 'flex', gap: 10 }}>
        {/* a solid revenue load */}
        <div style={{ flex: 1, borderRadius: 9, background: '#1a73e8', color: '#fff', padding: '10px 12px', minHeight: 116 }}>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 12, lineHeight: 1.25 }}>Arrive: Carrollton → Plano</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.92, marginTop: 6 }}><Clock size={11} strokeWidth={2.2} /> 7:30a-10a</div>
          <div style={{ fontSize: 11, opacity: 0.92, marginTop: 6 }}>$385 · revenue</div>
        </div>
        {/* a striped non-revenue block */}
        <div style={{ flex: 1, borderRadius: 9, border: '1px solid #1a5fb4', background: '#1a73e8', backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,.16) 0 7px, transparent 7px 15px)', color: '#fff', padding: '10px 12px', minHeight: 116 }}>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 12, lineHeight: 1.25 }}>PM Eagle / Truck 1043</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.92, marginTop: 6 }}><Clock size={11} strokeWidth={2.2} /> 2p-8p</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.92, marginTop: 6 }}><Wrench size={11} strokeWidth={2.2} /> Maintenance</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#5f6368', marginTop: 12 }}>The striped fill marks the truck as busy but not a revenue load.</div>
    </Preview>
  );
}

function PodVisual() {
  return (
    <Preview label="Calendar · Load card" color="#1e8e3e">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ position: 'relative', width: 116, flex: 'none', borderRadius: 9, background: '#d93025', color: '#fff', padding: '10px 11px 11px', minHeight: 130 }}>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 11, lineHeight: 1.25, paddingRight: 14 }}>TQL: Fort Worth → Garland</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, opacity: 0.92, marginTop: 6 }}><Clock size={10} strokeWidth={2.2} /> 1p-4p</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, opacity: 0.92, marginTop: 3 }}><User size={10} strokeWidth={2.2} /> Carlos Ramirez</div>
          <div style={{ fontSize: 10.5, opacity: 0.92, marginTop: 6 }}>$615</div>
          <Star size={13} fill="#ffd54a" strokeWidth={0} style={{ position: 'absolute', top: 8, right: 9 }} />
          <span style={{ position: 'absolute', bottom: 9, right: 9, width: 20, height: 20, borderRadius: 5, background: '#1e8e3e', display: 'grid', placeItems: 'center' }}><FileCheck size={13} style={{ color: '#fff' }} strokeWidth={2.1} /></span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#e6f4ea', border: '1px solid #ceead6', borderRadius: 999, padding: '6px 12px' }}>
            <FileCheck size={14} style={{ color: '#1e8e3e' }} strokeWidth={2.1} />
            <span className="font-display" style={{ fontWeight: 600, fontSize: 12, color: '#1e7a3d' }}>POD uploaded</span>
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#5f6368', marginTop: 12 }}>The green tag lands the second the driver uploads, and the ★ flags it as priority.</div>
        </div>
      </div>
    </Preview>
  );
}

function TrailerVisual() {
  const opts: ReadonlyArray<[string, string]> = [["Dry van 53'", 'TR-3310'], ['Flatbed', 'TR-1192']];
  return (
    <Preview label="Load · Trailer" color="#0e8a8a">
      <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 6 }}>Trailer</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #0e8a8a', borderRadius: 9, padding: '10px 12px', background: '#f2fbfb' }}>
        <span style={{ width: 24, height: 24, flex: 'none', borderRadius: 6, background: '#defafa', color: '#0e8a8a', display: 'grid', placeItems: 'center' }}><Container size={13} strokeWidth={2.2} /></span>
        <span className="font-display" style={{ flex: 1, fontWeight: 700, fontSize: 13, color: '#202124' }}>Reefer 53&apos; · TR-4821</span>
        <ChevronDown size={15} style={{ color: '#5f6368' }} strokeWidth={2.2} />
      </div>
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column' }}>
        {opts.map(([n, id]) => (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8 }}>
            <span style={{ width: 24, height: 24, flex: 'none', borderRadius: 6, background: '#f1f3f4', color: '#5f6368', display: 'grid', placeItems: 'center' }}><Container size={13} strokeWidth={2.2} /></span>
            <span style={{ flex: 1, fontSize: 13, color: '#3c4043' }}>{n}</span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: '#9aa0a6' }}>{id}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid #eef1f4', marginTop: 6, paddingTop: 10 }}>
        <span style={{ width: 18, height: 18, flex: 'none', borderRadius: 999, background: '#1e8e3e', color: '#fff', display: 'grid', placeItems: 'center' }}><Check size={11} strokeWidth={3} /></span>
        <span style={{ fontSize: 12, color: '#3c4043' }}>Driver reported <strong style={{ color: '#202124' }}>TR-4821</strong> from the app</span>
      </div>
    </Preview>
  );
}

function UnassignedVisual() {
  const loads: ReadonlyArray<[string, string, string]> = [
    ['Arrive: Carrollton → Plano', '7:30a-10a', '$385'],
    ['GTZ: Haslet → Lancaster', '12p-3:30p', '$525'],
    ['Cheema: Houston → San Antonio', '6a-1p', '$1,175'],
    ['ITS: Fort Worth → Tolleson', '6a-6p', '$1,640'],
  ];
  return (
    <Preview label="Calendar · Unassigned" color="#c5631e">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124' }}>Unassigned</span>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: '#c5631e', background: '#fef0e6', borderRadius: 999, padding: '2px 9px' }}>4 loads</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {loads.map(([lane, time, amt]) => (
          <div key={lane} style={{ background: '#eceef1', border: '1px solid #dfe2e6', borderRadius: 7, padding: '8px 11px' }}>
            <div className="font-display" style={{ fontWeight: 600, fontSize: 12.5, color: '#3c4043', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, fontSize: 11.5, color: '#80868b' }}><span>{time}</span><span aria-hidden>·</span><span style={{ fontWeight: 600, color: '#5f6368' }}>{amt}</span><span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#9aa0a6' }}>No driver yet</span></div>
          </div>
        ))}
      </div>
    </Preview>
  );
}

const VISUALS = [<RelayVisual key="r" />, <AccessorialsVisual key="a" />, <HistoryVisual key="h" />, <NonrevVisual key="n" />, <PodVisual key="p" />, <TrailerVisual key="t" />, <UnassignedVisual key="u" />];

export default function CapabilitySelector() {
  const [active, setActive] = useState(0);
  const t = TABS[active];

  return (
    <>
      {/* Mobile (<lg): accordion — tapping a capability expands its detail
          inline, so the choice and what it shows stay together. */}
      <div className="lg:hidden flex flex-col" style={{ gap: 10 }}>
        {TABS.map((tab, i) => {
          const on = i === active;
          return (
            <div key={tab.tab} style={{ border: `1px solid ${on ? tab.color : '#e8eaed'}`, borderRadius: 14, overflow: 'hidden', background: '#fff', transition: 'border-color .15s' }}>
              <button type="button" onClick={() => setActive(i)} aria-expanded={on} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: on ? tab.light : '#fff', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 34, height: 34, flex: 'none', borderRadius: 9, background: on ? '#fff' : tab.light, color: tab.color, display: 'grid', placeItems: 'center' }}><tab.Icon size={16} strokeWidth={2.3} /></span>
                <span className="font-display" style={{ flex: 1, fontWeight: 700, fontSize: 15, color: on ? tab.color : '#3c4043' }}>{tab.tab}</span>
                <ChevronDown size={18} style={{ flex: 'none', color: '#9aa0a6', transform: on ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
              </button>
              {on && (
                <div style={{ borderTop: '1px solid #e8eaed' }}>
                  <div style={{ padding: '16px 16px 4px' }}>
                    <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: tab.color }}>{tab.kicker}</span>
                    <h3 className="font-display" style={{ fontWeight: 700, fontSize: 18, lineHeight: 1.2, margin: '8px 0 0', color: '#202124' }}>{tab.title}</h3>
                    <p style={{ fontSize: 14, lineHeight: 1.55, color: '#5f6368', margin: '6px 0 0' }}>{tab.desc}</p>
                  </div>
                  <div style={{ background: '#f8f9fa', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                    {VISUALS[i]}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Desktop (lg+): tab list on the left, fixed detail card on the right. */}
      <div className="hidden lg:grid lg:grid-cols-[0.82fr_1.5fr] gap-8 items-start">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {TABS.map((tab, i) => {
            const on = i === active;
            return (
              <button key={tab.tab} type="button" onClick={() => setActive(i)} style={{ textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', borderRadius: 12, border: `1px solid ${on ? tab.color : '#e8eaed'}`, background: on ? tab.light : '#fff', cursor: 'pointer', transition: 'background .15s, border-color .15s' }}>
                <span style={{ width: 34, height: 34, flex: 'none', borderRadius: 9, background: on ? '#fff' : tab.light, color: tab.color, display: 'grid', placeItems: 'center' }}><tab.Icon size={16} strokeWidth={2.3} /></span>
                <span className="font-display" style={{ fontWeight: 700, fontSize: 14.5, color: on ? tab.color : '#3c4043' }}>{tab.tab}</span>
              </button>
            );
          })}
        </div>

        <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: '0 10px 30px -16px rgba(26,35,50,.18)', overflow: 'hidden' }}>
          <div style={{ padding: '22px 24px 18px', borderBottom: '1px solid #e8eaed' }}>
            <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: t.color }}>{t.kicker}</span>
            <h3 className="font-display" style={{ fontWeight: 700, fontSize: 20, lineHeight: 1.2, margin: '9px 0 0', color: '#202124' }}>{t.title}</h3>
            <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#5f6368', margin: '7px 0 0', minHeight: 45 }}>{t.desc}</p>
          </div>
          <div style={{ height: 320, background: '#f8f9fa', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, overflow: 'hidden' }}>
            {VISUALS[active]}
          </div>
        </div>
      </div>
    </>
  );
}
