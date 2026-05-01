'use client';

import DispatchBoard from '@/components/tray/DispatchBoard';
import DataLoader from '@/components/DataLoader';
import EldSync from '@/components/EldSync';
import RealtimeSync from '@/components/RealtimeSync';
import EventModal from '@/components/calendar/EventModal';

export default function BoardPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <DataLoader />
      <EldSync />
      <RealtimeSync />
      <DispatchBoard />
      <EventModal />
    </div>
  );
}
