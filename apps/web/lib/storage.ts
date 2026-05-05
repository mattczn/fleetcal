'use client';

import { getSupabase } from './supabase';

const BUCKET = 'rate-cons';

export async function uploadRateCon(dataUrl: string, orgId: string, eventId: string): Promise<string> {
  const db = getSupabase();
  const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);

  const path = `${orgId}/${eventId}.pdf`;
  // Supabase Storage occasionally returns 5xx gateway errors — retry once.
  // Caller is responsible for surfacing failures (don't double-log here).
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await db.storage.from(BUCKET).upload(path, arr.buffer, {
      upsert: true,
      contentType: 'application/pdf',
    });
    if (!error) return path;
    lastErr = error;
    // Only retry on transient 5xx; bail immediately on validation errors.
    const msg = error.message ?? '';
    if (!/HTTP 5\d\d|gateway|timeout/i.test(msg)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  throw lastErr ?? new Error('upload failed');
}

export async function getRateConSignedUrl(path: string): Promise<string | null> {
  const db = getSupabase();
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
