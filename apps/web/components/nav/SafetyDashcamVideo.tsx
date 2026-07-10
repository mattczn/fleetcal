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

import { useState, useCallback, useEffect } from 'react';
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
  // parent re-fetch. Reset whenever the eventId changes — the useState
  // initializer only fires on mount, so without this a shared drawer
  // that re-uses the component across events would keep stale raw.
  const [raw, setRaw] = useState<MotivePerfRaw | undefined | null>(initialRaw);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  useEffect(() => {
    setRaw(initialRaw);
    setRefreshMsg(null);
    setRefreshing(false);
  }, [eventId, initialRaw]);

  const cam = raw?.camera_media;

  // Fallback ladder for what to render:
  //   1. Video URL (if Motive transcoded a clip)
  //   2. JPG stills (present on almost every event with a dashcam;
  //      Motive returns these before video is transcoded)
  //   3. "Motive hasn't attached video/images yet" — show refresh button
  //
  // In practice most hard_brake and hard_accel events never get an MP4
  // (auto_transcode_status = "not started") so the JPG path is what
  // dispatchers will actually see day to day.

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
      // Show the full error — including status codes from RailwayError —
      // so a 404 during a Railway rebuild is obvious instead of silent.
      const e = err as { status?: number; message?: string };
      const detail = e.status != null ? `HTTP ${e.status}: ${e.message ?? ''}` : (e.message ?? 'Refresh failed.');
      console.error('[DashcamVideo] refresh failed:', err);
      setRefreshMsg(detail);
    }
    setRefreshing(false);
  }, [eventId, onRefreshed]);

  // ELD-only truck, no dashcam at all — skip the whole block.
  if (!cam) return null;

  const vids = cam.downloadable_videos ?? null;
  const front  = vids?.front_facing_enhanced_url ?? vids?.front_facing_plain_url  ?? null;
  const driver = vids?.driver_facing_plain_url ?? null;
  const dual   = vids?.dual_facing_enhanced_ai_viz_url ?? vids?.dual_facing_enhanced_url ?? null;
  const hasAnyVideo = !!(front || driver || dual);

  const imgs = cam.downloadable_images ?? null;
  const frontImg  = imgs?.front_facing_jpg_url  ?? null;
  const driverImg = imgs?.driver_facing_jpg_url ?? null;
  const hasAnyImage = !!(frontImg || driverImg);

  // "not started" is the common case for hard-brake/hard-accel — set
  // this so the copy explains why there's no MP4 without making it
  // sound like a bug.
  const transcodeStatus = cam.auto_transcode_status ?? null;

  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 5 }}>
        Dashcam
      </div>

      {!cam.available ? (
        <div style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>
          Video not yet uploaded from the truck. Try refreshing in a minute.
        </div>
      ) : hasAnyVideo ? (
        // Prefer video whenever Motive has one — stitched AI-viz clip
        // first, then per-camera clips side-by-side.
        dual ? (
          <VideoTile src={dual} label="Front + driver (annotated)" onExpired={doRefresh} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: front && driver ? '1fr 1fr' : '1fr', gap: 8 }}>
            {front  && <VideoTile src={front}  label="Forward-facing" onExpired={doRefresh} />}
            {driver && <VideoTile src={driver} label="Driver-facing"  onExpired={doRefresh} />}
          </div>
        )
      ) : hasAnyImage ? (
        // No transcoded video — but Motive delivered still frames from
        // each dashcam angle at the moment of the event. That's the
        // most useful thing dispatchers have to review, and matches
        // what Curzon sees in the Motive coaching app.
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: frontImg && driverImg ? '1fr 1fr' : '1fr', gap: 8 }}>
            {frontImg  && <ImageTile src={frontImg}  label="Forward-facing" onExpired={doRefresh} />}
            {driverImg && <ImageTile src={driverImg} label="Driver-facing"  onExpired={doRefresh} />}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', marginTop: 6 }}>
            Motive didn’t transcode a video clip for this event ({transcodeStatus ?? 'no video'}). Stills above are from the moment of the alert.
          </div>
        </div>
      ) : (
        // Neither video nor images — either the event landed before
        // media_required=true went live, or the signed URLs on both
        // expired. Refresh button re-queries Motive to repopulate.
        <div>
          <div style={{ fontSize: 12, color: 'var(--gc-text-3)', marginBottom: 6 }}>
            No video or images on this event yet. Ask Motive for them:
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
              {refreshing ? 'Loading…' : 'Load media'}
            </button>
          )}
          {refreshMsg && (
            <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 6 }}>{refreshMsg}</div>
          )}
        </div>
      )}

      <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--gc-text-3)' }}>
        Cam {cam.cam_type} · {cam.duration}s
      </div>
    </div>
  );
}

function ImageTile({ src, label, onExpired }: { src: string; label: string; onExpired?: () => void }) {
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
          Image link expired
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
        // Signed S3 URLs — <img> can display them directly. `onError`
        // catches expiries so the placeholder + refresh affordance kicks
        // in instead of a broken-image icon.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={label}
          onError={() => setBroken(true)}
          style={{ width: '100%', borderRadius: 6, background: '#000', display: 'block' }}
        />
      )}
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
