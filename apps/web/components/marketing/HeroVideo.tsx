'use client';

/**
 * HeroVideo — autoplaying screencast for the marketing landing.
 *
 * Wraps a <video> with an explicit imperative play() call in useEffect.
 *
 * Why we can't just rely on the `autoPlay` JSX attribute: React sets
 * attributes in JSX-declaration order, but the browser starts attempting
 * autoplay as soon as it sees `autoplay`. If `muted` is declared after
 * `autoPlay` (or set as a property after the attribute) the browser
 * tries to autoplay with sound, the autoplay policy rejects it
 * silently, and the video stays paused — even though the rendered HTML
 * looks correct. This is a long-standing React quirk:
 *   https://github.com/facebook/react/issues/10389
 *
 * The reliable workaround across browsers is:
 *   1. Set the `muted` *property* on the element imperatively (the
 *      attribute alone isn't always enough for the autoplay policy).
 *   2. Call play() and swallow the returned promise's rejection (some
 *      browsers reject in private-mode / data-saver / low-power state).
 *
 * Failure case: the video stays on its first frame, which is fine on
 * a hero — the user sees a static screenshot of the AI parser instead
 * of motion. The Reveal wrapper around HeroVideo continues to behave
 * the same in either state.
 */
import { useEffect, useRef, type CSSProperties } from 'react';

interface HeroVideoProps {
  src:        string;
  /** Source's native dimensions, used to compute aspectRatio. The
   *  ratio is set inline so the element reserves vertical space on
   *  first paint, before the video's metadata downloads. Without this
   *  the frame is zero-height until the network round-trip completes. */
  width:      number;
  height:     number;
  /** Accessible description of what's happening in the video. */
  ariaLabel:  string;
  style?:     CSSProperties;
}

export default function HeroVideo({ src, width, height, ariaLabel, style }: HeroVideoProps) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // Make sure the muted *property* is true before kicking off play().
    // JSX `muted` sets the attribute, but the property is what the
    // autoplay policy actually checks.
    v.muted = true;
    const playPromise = v.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err) => {
        // Autoplay policy rejected — leave on first frame.
        // Logged for debugging but harmless in production.
        // eslint-disable-next-line no-console
        console.warn('[HeroVideo] autoplay rejected:', err);
      });
    }
  }, []);

  return (
    <video
      ref={ref}
      src={src}
      muted
      loop
      playsInline
      preload="auto"
      aria-label={ariaLabel}
      // No `autoPlay` attribute — useEffect handles it imperatively so
      // we avoid the React attribute-order race documented above.
      style={{
        width:       '100%',
        height:      'auto',
        aspectRatio: `${width} / ${height}`,
        display:     'block',
        background:  '#f8f9fa',
        ...style,
      }}
    />
  );
}
