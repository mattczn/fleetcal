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
  const { error } = await db.storage.from(BUCKET).upload(path, arr.buffer, {
    upsert: true,
    contentType: 'application/pdf',
  });
  if (error) {
    console.error('Storage upload error:', error.message, error);
    throw error;
  }
  return path;
}

export async function getRateConSignedUrl(path: string): Promise<string | null> {
  const db = getSupabase();
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
