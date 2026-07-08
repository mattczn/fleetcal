'use client';

/**
 * /expenses/recurring — CRUD for the recurring rules that feed the
 * dashboard's Payroll (admin/dispatch/maintenance) + Insurance buckets.
 *
 * Physically lives under /expenses (not /settings) so it's a click away
 * from the tiles it drives. Same module gate as the rest of /expenses.
 */

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import RecurringExpensesPanel from '../RecurringExpensesPanel';

function RecurringPageInner() {
  const router = useRouter();
  return (
    <AppShell>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full px-6 py-6" style={{ maxWidth: 1024 }}>
          <button
            onClick={() => router.push('/expenses')}
            className="text-xs font-semibold mb-4 inline-flex items-center gap-1.5"
            style={{ color: 'var(--gc-text-3)' }}
          >
            <ArrowLeft size={13} /> Back to expenses
          </button>
          <RecurringExpensesPanel />
        </div>
      </div>
    </AppShell>
  );
}

export default function RecurringPage() {
  return (
    <RequireCap cap="expenses.access" module="expenses">
      <RecurringPageInner />
    </RequireCap>
  );
}
