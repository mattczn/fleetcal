'use client';

/**
 * LoadDocsViewer — Feature 03 on /product/calendar. Segmented toggle that
 * swaps the framed load-modal screenshot between the route map and the rate
 * con. Conditionally renders the active <Image> (no src-swap flash).
 */
import { useState } from 'react';
import { Map, FileText } from 'lucide-react';
import Image from 'next/image';

export default function LoadDocsViewer() {
  const [tab, setTab] = useState<'map' | 'ratecon'>('map');
  const isMap = tab === 'map';

  const seg = (on: boolean) => ({
    display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13.5,
    padding: '9px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
    background: on ? '#fff' : 'transparent', color: on ? '#1967d2' : '#5f6368',
  } as const);

  return (
    <div>
      <div style={{ display: 'inline-flex', background: '#f1f3f4', borderRadius: 10, padding: 3, marginBottom: 14 }}>
        <button type="button" onClick={() => setTab('map')} className="font-display" style={seg(isMap)}><Map size={15} strokeWidth={2.2} /> Route map</button>
        <button type="button" onClick={() => setTab('ratecon')} className="font-display" style={seg(!isMap)}><FileText size={15} strokeWidth={2.2} /> Rate con</button>
      </div>
      <div style={{ border: '1px solid #e8eaed', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-soft)', background: '#fff' }}>
        {isMap
          ? <Image src="/cal-route-map.png" alt="Load modal route map with geocoded stops" width={1698} height={1057} sizes="100vw" style={{ display: 'block', width: '100%', height: 'auto' }} />
          : <Image src="/cal-ratecon-modal.png" alt="Load modal showing the rate confirmation" width={1696} height={1052} sizes="100vw" style={{ display: 'block', width: '100%', height: 'auto' }} />}
      </div>
    </div>
  );
}
