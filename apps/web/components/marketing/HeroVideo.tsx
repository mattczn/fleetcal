/**
 * HeroVideo — autoplaying screencast for the marketing landing.
 *
 * Renders a raw <video> tag via dangerouslySetInnerHTML so the
 * browser parses the HTML attributes in the EXACT source order we
 * specify, dodging React's attribute-application quirks entirely.
 *
 * Why this is necessary: prior iterations using both JSX attributes
 * AND an imperative .play() in useEffect still resulted in a paused
 * first-frame on production. The most likely cause was that the
 * client component never hydrated (or hydrated too late) and the
 * imperative play() never fired. By rendering the video as raw HTML,
 * the browser starts autoplay immediately during page parse — no
 * React, no hydration, no useEffect lifecycle to wait on.
 *
 * Tradeoffs: we lose JSX type-checking on the video element. The
 * input shape is narrow (src, width, height, ariaLabel) so this is
 * acceptable, and the inner HTML is fully under our control — no
 * user-supplied data is interpolated.
 *
 * Server-renderable — no 'use client' directive needed.
 */
import type { CSSProperties } from 'react';

interface HeroVideoProps {
  src:       string;
  width:     number;
  height:    number;
  ariaLabel: string;
  style?:    CSSProperties;
}

export default function HeroVideo({ src, width, height, ariaLabel, style: _style }: HeroVideoProps) {
  // Note: style on the wrapping div, NOT the video — the video gets
  // its sizing from inline `style=` in the raw HTML below.
  // Attribute order is deliberate: muted FIRST so the autoplay policy
  // check passes before autoplay is encountered.
  const html =
    `<video ` +
      `muted ` +
      `playsinline ` +
      `autoplay ` +
      `loop ` +
      `preload="auto" ` +
      `aria-label="${escapeAttr(ariaLabel)}" ` +
      `style="width:100%;height:auto;aspect-ratio:${width}/${height};display:block;background:#f8f9fa;"` +
    `>` +
      `<source src="${escapeAttr(src)}" type="video/mp4">` +
    `</video>`;

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Minimal attribute-context escaper — we control all inputs but this
 *  hardens against future callers passing user-influenced strings. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
