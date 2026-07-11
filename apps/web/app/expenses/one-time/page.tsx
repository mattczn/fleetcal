'use client';

/**
 * /expenses/one-time — retired. One-time entries live in the /expenses
 * workspace: "+ Expense" creates, clicking a Manual row edits.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function OneTimeRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/expenses'); }, [router]);
  return null;
}
