'use client';

/**
 * DashcamVideo — reads Motive's camera_media block off a raw perf-event
 * payload and renders a video player. Used in both the SafetyEventsBell
 * drawer and the SafetyPanel.
 *
 * URL freshness: Motive signs downloadable_videos with time-limited
 * links (~48h). We also don't ingest URLs at all for events that landed
 * before we started passing media_required=true on the sync. In both
 * cases the dispatcher can click "Load video" to hit the refresh
 * endpoint, which re-queries Motive with media_required=true and
 * updates the row in-place.
 */

import { useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { MotivePerfRaw } from '@fleetcal/types';

interface Props {
  eventId?: number;                       // required for refresh; omit if you don't want the refresh button
  raw:      MotivePerfRaw | undefined | null;
  onRefreshed?: (newRaw: MotivePerfRaw | undefined) => void;
}

export default function DashcamVideo({ eventId, raw: initialRaw, onRefreshed }: Props) {
  // Local override so refreshing updates the UI without waiting for a
  // parent re-fetch. Falls back to the raw prop otherwise.
  const [raw, setRaw] = useState<MotivePerfRaw | undefined | null>(initialRaw);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const cam = raw?.camera_media;

  const doRefresh = useCallback(async () => {
    if (eventId == null) return;
    setRefreshing(true); setRefreshMsg(null);
    try {
      const res = await railway.refreshPerformanceEventMedia(eventId);
      if (res.videoStatus === 'refreshed' && res.event?.raw) {
        setRaw(res.event.raw);
        onRefreshed?.(res.event.raw);
      } else {
        setRefreshMsg('Motive has no video attached to this event.');
      }
    } catch (err) {
      setRefreshMsg((err as Error).message ?? 'Refresh failed. Try again in a minute.');
    }
    setRefreshing(false);
  }, [eventId, onRefreshed]);

  // ELD-only truck, no dashcam at all — skip the whole block.
  if (!cam) return null;

  const urls = cam.downloadable_videos ?? null;
  const front  = urls?.front_facing_enhanced_url ?? urls?.front_facing_plain_url  ?? null;
  const driver = urls?.driver_facing_plain_url ?? null;
  const dual   = urls?.dual_facing_enhanced_ai_viz_url ?? urls?.dual_facing_enhanced_url ?? null;
  const hasAnyUrl = !!(front || driver || dual);

  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 5 }}>
        Dashcam
      </div>
      {!cam.available ? (
        <div style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>
          Video not yet uploaded from the truck. Try refreshing in a minute.
        </div>
      ) : !hasAnyUrl ? (
        // No URLs on the row yet — offer the refresh button. This is
        // the common case for events ingested before media_required=true
        // shipped, and for events older than the URL TTL.
        <div>
          <div style={{ fontSize: 12, color: 'var(--gc-text-3)', marginBottom: 6 }}>
            Video URLs aren’t on this event yet. Ask Motive for them:
          </div>
          {eventId != null && (
            <button
              type="button"
              onClick={doRefresh}
              disabled={refreshing}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 10px', borderRadius: 6,
                border: '1px solid var(--gc-border-light)',
                background: 'var(--gc-bg)', color: 'var(--gc-text-1)',
                fontSize: 12, cursor: refreshing ? 'wait' : 'pointer',
              }}
            >
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? 'Loading…' : 'Load video'}
            </button>
          )}
          {refreshMsg && (
            <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 6 }}>{refreshMsg}</div>
          )}
        </div>
      ) : dual ? (
        // Prefer the stitched AI-viz clip — one video showing both
        // cameras with the offending behavior annotated. Best for
        // dispatcher review since context is on-screen.
        <VideoTile src={dual} label="Front + driver (annotated)" onExpired={doRefresh} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: front && driver ? '1fr 1fr' : '1fr', gap: 8 }}>
          {front  && <VideoTile src={front}  label="Forward-facing" onExpired={doRefresh} />}
          {driver && <VideoTile src={driver} label="Driver-facing"  onExpired={doRefresh} />}
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--gc-text-3)' }}>
        Cam {cam.cam_type} · {cam.duration}s
      </div>
    </div>
  );
}

function VideoTile({ src, label, onExpired }: { src: string; label: string; onExpired?: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', marginBottom: 3 }}>{label}</div>
      {broken ? (
        <div style={{
          height: 120, borderRadius: 6, background: 'var(--gc-bg)',
          border: '1px dashed var(--gc-border-light)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
          fontSize: 11, color: 'var(--gc-text-3)',
        }}>
          Video link expired
          {onExpired && (
            <button
              type="button"
              onClick={onExpired}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 8px', borderRadius: 5,
                border: '1px solid var(--gc-border-light)',
                background: 'var(--gc-surface)', color: 'var(--gc-text-1)',
                fontSize: 11, cursor: 'pointer',
              }}
            >
              <RefreshCw size={10} /> Refresh link
            </button>
          )}
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
