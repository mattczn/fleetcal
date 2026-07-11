'use client';

/**
 * /expenses/cards — retired. The card board folded into the /expenses
 * workspace (filter by source = Card, click a row for the detail
 * panel). Old deep links redirect with their bucket filter intact.
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function CardsRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const bucketId = searchParams?.get('bucketId') ?? searchParams?.get('category');
    router.replace(bucketId ? `/expenses?bucketId=${encodeURIComponent(bucketId)}` : '/expenses');
  }, [router, searchParams]);
  return null;
}
