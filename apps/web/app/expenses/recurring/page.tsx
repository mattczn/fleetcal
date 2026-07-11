'use client';

/**
 * /expenses/recurring — retired. Recurring rules are edited from the
 * /expenses workspace: their prorated postings appear as ledger rows
 * (source = Recurring); click one to edit the rule, or "+ Expense" →
 * Recurring to create.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function RecurringRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/expenses'); }, [router]);
  return null;
}
