'use client';

import DispatchBoard from '@/components/tray/DispatchBoard';
import DataLoader from '@/components/DataLoader';
import EldSync from '@/components/EldSync';
import RealtimeSync from '@/components/RealtimeSync';
import EventModal from '@/components/calendar/EventModal';
import RequireCap from '@/components/auth/RequireCap';

export default function BoardPage() {
  return (
    <RequireCap cap="loads.view" module="dispatch_board">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <DataLoader />
        <EldSync />
        <RealtimeSync />
        <DispatchBoard />
        <EventModal />
      </div>
    </RequireCap>
  );
}
