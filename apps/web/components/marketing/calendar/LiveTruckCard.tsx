'use client';

/**
 * LiveTruckCard — Feature 02 (right) on /product/calendar. A CSS faux-map
 * with a pulsing pink ELD truck pin; the "Get ETA from Truck" button pings
 * (~1s spinner) and resolves to an ETA card. Illustrative — no data.
 */
import { useEffect, useRef, useState } from 'react';
import { Truck, Satellite } from 'lucide-react';

export default function LiveTruckCard() {
  const [eta, setEta] = useState<'idle' | 'loading' | 'done'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const getEta = () => {
    if (eta === 'loading') return;
    setEta('loading');
    timer.current = setTimeout(() => setEta('done'), 1000);
  };

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 16, overflow: 'hidden', boxShadow: '0 10px 30px -16px rgba(26,35,50,.2)', display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes cal-ping{0%{transform:scale(.5);opacity:.6}80%{opacity:0}100%{transform:scale(2.6);opacity:0}}@keyframes cal-spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 18px', borderBottom: '1px solid #e8eaed' }}>
        <span className="font-display" style={{ fontWeight: 700, fontSize: 14, color: '#202124' }}>Live truck location</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#5f6368' }}><span style={{ width: 7, height: 7, borderRadius: 999, background: '#ec4899' }} />ELD live</span>
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 300, overflow: 'hidden', background: '#e9edf1' }}>
        {/* faux-map: parks / water / roads */}
        <div style={{ position: 'absolute', left: -30, top: -26, width: 150, height: 120, background: '#cfe6c4', borderRadius: '46% 54% 50% 50%' }} />
        <div style={{ position: 'absolute', left: '54%', top: '8%', width: 96, height: 78, background: '#d4e9c9', borderRadius: '50%' }} />
        <div style={{ position: 'absolute', right: -44, bottom: -50, width: '54%', height: '60%', background: '#a8d3ef', borderRadius: '46% 38% 50% 42%' }} />
        <div style={{ position: 'absolute', right: '6%', bottom: '32%', width: '62%', height: 15, background: '#a8d3ef', borderRadius: 999, transform: 'rotate(20deg)' }} />
        <div style={{ position: 'absolute', left: '-12%', top: '60%', width: '124%', height: 11, background: '#f6cf72', borderTop: '1px solid #e6b94e', borderBottom: '1px solid #e6b94e', transform: 'rotate(-19deg)' }} />
        <div style={{ position: 'absolute', left: '-10%', top: '34%', width: '120%', height: 13, background: '#fff', borderTop: '1px solid #dfe4e8', borderBottom: '1px solid #dfe4e8', transform: 'rotate(-7deg)' }} />
        <div style={{ position: 'absolute', left: '40%', top: '-12%', width: 12, height: '124%', background: '#fff', borderLeft: '1px solid #dfe4e8', borderRight: '1px solid #dfe4e8', transform: 'rotate(9deg)' }} />
        <div style={{ position: 'absolute', left: '-10%', top: '18%', width: '120%', height: 6, background: '#f4f7f8', transform: 'rotate(-7deg)' }} />
        <div style={{ position: 'absolute', left: '66%', top: '-12%', width: 6, height: '124%', background: '#f4f7f8', transform: 'rotate(9deg)' }} />
        <div style={{ position: 'absolute', left: '14%', top: '-12%', width: 6, height: '124%', background: '#f4f7f8', transform: 'rotate(9deg)' }} />

        {/* pulsing truck pin */}
        <div style={{ position: 'absolute', left: '47%', top: '45%' }}>
          <span style={{ position: 'absolute', left: '50%', top: '50%', width: 42, height: 42, margin: '-21px 0 0 -21px', borderRadius: 999, background: 'rgba(236,72,153,.28)', animation: 'cal-ping 2.4s ease-out infinite' }} />
          <span style={{ position: 'absolute', left: '50%', top: '50%', width: 42, height: 42, margin: '-21px 0 0 -21px', borderRadius: 999, background: 'rgba(236,72,153,.28)', animation: 'cal-ping 2.4s ease-out infinite 1.2s' }} />
          <span style={{ position: 'absolute', left: '50%', top: '50%', width: 36, height: 36, margin: '-18px 0 0 -18px', borderRadius: 999, background: '#ec4899', boxShadow: '0 4px 12px rgba(236,72,153,.5)', border: '2.5px solid #fff', display: 'grid', placeItems: 'center' }}>
            <Truck size={18} color="#fff" strokeWidth={2.1} />
          </span>
        </div>

        {/* location chip */}
        <div style={{ position: 'absolute', left: 14, bottom: 14, display: 'flex', alignItems: 'center', gap: 9, background: '#fff', border: '1px solid #e8eaed', borderRadius: 12, boxShadow: '0 4px 10px rgba(26,35,50,.12)', padding: '9px 13px' }}>
          <span style={{ width: 9, height: 9, borderRadius: 999, background: '#ec4899', flex: 'none' }} />
          <div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124' }}>Dallas, TX</div>
            <div style={{ fontSize: 11.5, color: '#5f6368' }}>Last seen 4:15 PM</div>
          </div>
        </div>

        {/* ETA button / spinner / result */}
        <div style={{ position: 'absolute', right: 14, top: 14 }}>
          {eta === 'idle' && (
            <button type="button" onClick={getEta} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 12.5, color: '#fff', background: '#1a73e8', border: 'none', borderRadius: 999, boxShadow: '0 4px 10px rgba(26,35,50,.2)', padding: '9px 15px', cursor: 'pointer' }}><Satellite size={14} strokeWidth={2.2} /> Get ETA from Truck</button>
          )}
          {eta === 'loading' && (
            <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #e8eaed', borderRadius: 999, boxShadow: '0 4px 10px rgba(26,35,50,.14)', padding: '9px 15px', fontWeight: 600, fontSize: 12.5, color: '#5f6368' }}><span style={{ width: 13, height: 13, border: '2px solid #e8f0fe', borderTopColor: '#1a73e8', borderRadius: 999, animation: 'cal-spin .8s linear infinite' }} />Pinging truck…</span>
          )}
          {eta === 'done' && (
            <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 12, boxShadow: '0 6px 16px rgba(26,35,50,.18)', padding: '10px 14px', textAlign: 'right' }}>
              <div className="font-display" style={{ fontWeight: 800, fontSize: 16, color: '#1e8e3e' }}>ETA 2h 14m</div>
              <div style={{ fontSize: 11.5, color: '#5f6368', marginTop: 1 }}>Garland, TX · 3:04 PM MDT</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
