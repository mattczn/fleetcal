'use client';

/**
 * DashcamVideo — reads Motive's camera_media block off a raw perf-event
 * payload and renders a video player. Used in both the SafetyEventsBell
 * drawer and the SafetyPanel.
 *
 * URL freshness: Motive's downloadable_videos URLs are signed and
 * time-limited (~48h). Older events show "video link expired" when the
 * <video> element errors out. The API refetches URLs on each sync tick
 * for events that are still updating on Motive's side; a stale event
 * that never got a re-sync won't have working URLs.
 */

import { useState } from 'react';
import type { MotivePerfRaw } from '@fleetcal/types';

export default function DashcamVideo({ raw }: { raw: MotivePerfRaw | undefined | null }) {
  const cam = raw?.camera_media;
  if (!cam) return null; // ELD-only truck, no dashcam — skip the block entirely.

  const urls = cam.downloadable_videos ?? null;
  const front  = urls?.front_facing_enhanced_url ?? urls?.front_facing_plain_url  ?? null;
  const driver = urls?.driver_facing_plain_url ?? null;
  const dual   = urls?.dual_facing_enhanced_ai_viz_url ?? urls?.dual_facing_enhanced_url ?? null;

  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 5 }}>
        Dashcam
      </div>
      {!cam.available ? (
        <div style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>
          Video not yet uploaded from the truck. Try refreshing in a minute.
        </div>
      ) : !urls ? (
        <div style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>
          Motive didn’t attach video URLs for this event. Newer alerts will include them.
        </div>
      ) : dual ? (
        // Prefer the stitched AI-viz clip — one video showing both
        // cameras with the offending behavior annotated. Best for
        // dispatcher review since context is on-screen.
        <VideoTile src={dual} label="Front + driver (annotated)" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: front && driver ? '1fr 1fr' : '1fr', gap: 8 }}>
          {front  && <VideoTile src={front}  label="Forward-facing" />}
          {driver && <VideoTile src={driver} label="Driver-facing"  />}
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--gc-text-3)' }}>
        Cam {cam.cam_type} · {cam.duration}s
      </div>
    </div>
  );
}

function VideoTile({ src, label }: { src: string; label: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', marginBottom: 3 }}>{label}</div>
      {broken ? (
        <div style={{
          height: 120, borderRadius: 6, background: 'var(--gc-bg)',
          border: '1px dashed var(--gc-border-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: 'var(--gc-text-3)',
        }}>
          Video link expired
        </div>
      ) : (
        <video
          src={src}
          controls
          preload="metadata"
          onError={() => setBroken(true)}
          style={{ width: '100%', borderRadius: 6, background: '#000' }}
        />
      )}
    </div>
  );
}
