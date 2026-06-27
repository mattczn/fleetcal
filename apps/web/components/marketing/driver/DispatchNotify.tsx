'use client';

/**
 * DispatchNotify — the "Dispatch → driver" interactive section on the
 * /product/driver-app page. A single-select list mirrors the real "Notify
 * driver" menu on the left; tapping an option swaps the FleetCal notification
 * on a synthetic iPhone lock screen on the right and replays its pop-in
 * (keyed on a click counter so the card re-mounts each tap). The lock screen
 * is built from divs, not a screenshot, so the card can change live.
 */
import { useState } from 'react';
import { CircleCheck, Package, MapPin, FileText, Container, ChevronRight } from 'lucide-react';

type Notif = {
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }>;
  label: string; sub: string; tint: string; light: string; title: string; body: string;
};

const NOTIFS: ReadonlyArray<Notif> = [
  { Icon: CircleCheck, label: 'Confirm load',  sub: 'Ask the driver to confirm they’ve got the load.',       tint: '#1a73e8', light: '#e8f0fe', title: 'Confirm your load',   body: 'Ardent: Lancaster, TX → Dallas, TX. Tap to confirm you’ve got the load.' },
  { Icon: Package,     label: 'Mark picked up', sub: 'Prompt a check-in at the pickup stops.',                     tint: '#0e8a8a', light: '#defafa', title: 'Check in at pickup',  body: 'You’re due at Home Depot RDC, Lancaster. Tap to mark picked up.' },
  { Icon: MapPin,      label: 'Mark delivered', sub: 'Prompt a check-in at delivery, plus the POD.',               tint: '#c5631e', light: '#fef0e6', title: 'Mark delivered',      body: 'Arrived at Sysco Dallas? Check in and upload your POD.' },
  { Icon: FileText,    label: 'Upload POD',     sub: 'Prompt an upload of the proof-of-delivery doc.',             tint: '#7c3aed', light: '#f1ebfe', title: 'Upload your POD',     body: 'Snap the signed proof-of-delivery doc for the Dallas delivery.' },
  { Icon: Container,   label: 'Report trailer', sub: 'Prompt the driver to set the trailer they’re pulling.', tint: '#1e8e3e', light: '#e6f4ea', title: 'Report your trailer', body: 'Which trailer are you pulling? Tap to set it on the load.' },
];

export default function DispatchNotify() {
  const [sel, setSel] = useState(0);
  const [clicks, setClicks] = useState(0);
  const active = NOTIFS[sel];

  return (
    <div className="grid items-center gap-10 lg:gap-12 grid-cols-1 lg:grid-cols-[1fr_0.86fr]">
      <style>{`@keyframes dv-notif-pop{0%{opacity:0;transform:translateY(-12px) scale(.95)}60%{opacity:1}100%{opacity:1;transform:none}}`}</style>

      {/* copy + selectable Notify-driver menu */}
      <div>
        <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1967d2' }}>Dispatch &rarr; driver</span>
        <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(27px, 3vw, 38px)', lineHeight: 1.1, letterSpacing: '-0.022em', margin: '14px 0 0', color: '#202124' }}>Send load notifications without leaving the calendar.</h2>
        <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px 0 24px', maxWidth: 540 }}>From the <strong style={{ color: '#202124' }}>Notify driver</strong> menu on any load, dispatch can nudge the driver to confirm, check in at a stop, upload paperwork, or report a trailer, and see the moment each one is done. Tap a nudge to watch it land.</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {NOTIFS.map((n, i) => {
            const on = i === sel;
            return (
              <button
                key={n.label}
                type="button"
                aria-pressed={on}
                onClick={() => { setSel(i); setClicks((c) => c + 1); }}
                style={{
                  textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 14,
                  padding: '15px 17px', borderRadius: 14,
                  border: `1px solid ${on ? n.tint : '#e8eaed'}`,
                  background: on ? n.light : '#fff',
                  cursor: 'pointer', transition: 'border-color .15s, background .15s',
                }}>
                <span style={{ width: 40, height: 40, flex: 'none', borderRadius: 11, background: on ? '#fff' : n.light, display: 'grid', placeItems: 'center' }}>
                  <n.Icon size={19} strokeWidth={2.1} style={{ color: n.tint }} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="font-display" style={{ display: 'block', fontWeight: 700, fontSize: 15, color: on ? n.tint : '#202124' }}>{n.label}</span>
                  <span style={{ display: 'block', fontSize: 13, color: '#5f6368', marginTop: 2 }}>{n.sub}</span>
                </span>
                <ChevronRight size={18} strokeWidth={2} style={{ color: on ? n.tint : '#c4c7c9', flex: 'none' }} />
              </button>
            );
          })}
        </div>
      </div>

      {/* synthetic iPhone lock screen — the notification swaps on select */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: 262, maxWidth: '100%', background: '#0b0b0c', borderRadius: 42, padding: 8, boxShadow: '0 26px 54px -24px rgba(11,18,32,.55)' }}>
          <div style={{ position: 'relative', borderRadius: 34, overflow: 'hidden', background: 'linear-gradient(165deg,#1b2a4a,#0e1830 58%,#0a1124)', aspectRatio: '1206 / 2622' }}>
            <div style={{ position: 'absolute', top: 11, left: '50%', transform: 'translateX(-50%)', width: 96, height: 26, background: '#000', borderRadius: 999, zIndex: 5 }} />
            <div style={{ position: 'absolute', top: 13, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 26px', zIndex: 4 }}>
              <span className="font-display" style={{ fontWeight: 600, fontSize: 13, color: '#fff' }}>12:53</span>
              <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                <svg width="16" height="11" viewBox="0 0 18 12" fill="#fff" aria-hidden="true"><rect x="0" y="7" width="3" height="5" rx="1" /><rect x="5" y="4" width="3" height="8" rx="1" /><rect x="10" y="1" width="3" height="11" rx="1" /></svg>
                <svg width="24" height="11" viewBox="0 0 26 12" fill="none" aria-hidden="true"><rect x="1" y="1" width="21" height="10" rx="3" stroke="#fff" strokeOpacity=".6" /><rect x="3" y="3" width="15" height="6" rx="1.5" fill="#fff" /><rect x="23.5" y="4" width="1.6" height="4" rx="0.8" fill="#fff" fillOpacity=".6" /></svg>
              </span>
            </div>
            <div style={{ position: 'absolute', top: 74, left: 0, right: 0, textAlign: 'center', zIndex: 3 }}>
              <div className="font-display" style={{ fontWeight: 600, fontSize: 14, color: 'rgba(255,255,255,.78)', letterSpacing: '.02em' }}>Monday, June 8</div>
              <div className="font-display" style={{ fontWeight: 300, fontSize: 62, lineHeight: 1, color: '#fff', letterSpacing: '-.02em', marginTop: 4 }}>12:53</div>
            </div>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 46, padding: '0 13px', zIndex: 4 }}>
              <div key={clicks} style={{ animation: 'dv-notif-pop .45s cubic-bezier(.2,.8,.2,1) both', background: 'rgba(250,250,252,.92)', WebkitBackdropFilter: 'blur(10px)', backdropFilter: 'blur(10px)', borderRadius: 20, padding: '13px 15px', boxShadow: '0 10px 30px rgba(5,10,25,.35)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                  <span className="font-display" style={{ width: 22, height: 22, borderRadius: 6, background: '#1a73e8', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 10, flex: 'none' }}>FC</span>
                  <span className="font-display" style={{ fontWeight: 700, fontSize: 12, letterSpacing: '.04em', color: '#3c4043', flex: 1 }}>FLEETCAL</span>
                  <span style={{ fontSize: 11.5, color: '#9aa0a6' }}>now</span>
                </div>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 14, color: '#16181c' }}>{active.title}</div>
                <div style={{ fontSize: 13, lineHeight: 1.45, color: '#3c4043', marginTop: 2 }}>{active.body}</div>
              </div>
            </div>
            <div style={{ position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', width: 108, height: 5, borderRadius: 999, background: 'rgba(255,255,255,.55)', zIndex: 4 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
