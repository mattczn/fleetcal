'use client';

import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';
import PayRoutesView from '@/components/payroll/PayRoutesView';

export default function PayRoutesPage() {
  return (
    <RequireCap cap="payroll.access" module="payroll">
      <DataLoader />
      <PayRoutesView />
    </RequireCap>
  );
}
