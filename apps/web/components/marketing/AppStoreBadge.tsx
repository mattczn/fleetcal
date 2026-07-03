import type { CSSProperties } from 'react';
import Link from 'next/link';

/**
 * Live app-store download links for the FleetCal Driver app — the single
 * source of truth. Used by the driver-app product page and the site footer.
 */
export const APP_STORE_URL  = 'https://apps.apple.com/us/app/fleetcal-driver/id6781803786';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.systematica.fleetcal.driver';

type BadgeSize = 'md' | 'sm';

/**
 * Black "Download on the App Store" / "Get it on Google Play" badge pill.
 * Inline SVG glyphs — no external image asset, so it stays crisp at any DPI
 * and needs no download. Renders a real outbound link unless `placeholder`
 * (a greyed "Coming soon" pill for a store the app isn't live on yet).
 */
export function AppStoreBadge({
  kind, href, placeholder = false, size = 'md',
}: {
  kind: 'apple' | 'google';
  href?: string;
  placeholder?: boolean;
  size?: BadgeSize;
}) {
  const sm = size === 'sm';
  const iconPx = sm ? 18 : 22;
  const icon = kind === 'apple' ? (
    <svg viewBox="0 0 384 512" width={iconPx} height={iconPx} fill="#fff" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" /></svg>
  ) : (
    <svg viewBox="0 0 24 26" width={iconPx - 1} height={iconPx + 1} aria-hidden="true">
      <polygon points="2.5,2 9,13 2.5,24" fill="#00C3FF" />
      <polygon points="2.5,2 9,13 20,11.5" fill="#00E676" />
      <polygon points="9,13 20,11.5 20,14.5" fill="#FFCE00" />
      <polygon points="2.5,24 9,13 20,14.5" fill="#FF3D47" />
    </svg>
  );
  const label = kind === 'apple' ? 'App Store' : 'Google Play';
  const top   = placeholder ? 'Coming soon to' : kind === 'apple' ? 'Download on the' : 'Get it on';
  const shell: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: sm ? 9 : 11,
    background: '#000', borderRadius: sm ? 10 : 12, padding: sm ? '7px 14px' : '10px 18px',
    textDecoration: 'none',
  };
  const body = (
    <>
      {icon}
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
        <span style={{ fontSize: sm ? 8.5 : 10, fontWeight: 500, letterSpacing: kind === 'apple' ? '0.02em' : '0.06em', textTransform: kind === 'apple' ? 'none' : 'uppercase', color: '#fff' }}>{top}</span>
        <span className="font-display" style={{ fontWeight: 700, fontSize: sm ? 15 : 18, color: '#fff', marginTop: sm ? 2 : 3 }}>{label}</span>
      </span>
    </>
  );
  if (placeholder) {
    return (
      <div aria-label={`${label}, coming soon`} style={{ ...shell, opacity: 0.5, cursor: 'default' }}>
        {body}
      </div>
    );
  }
  return (
    <Link
      href={href ?? '#'}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={kind === 'apple' ? 'Download on the App Store' : 'Get it on Google Play'}
      style={shell}
    >
      {body}
    </Link>
  );
}

/** Both live store badges (App Store + Google Play) with their real
 *  download links baked in. */
export function StoreBadges({ size = 'md', style }: { size?: BadgeSize; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: size === 'sm' ? 10 : 12, ...style }}>
      <AppStoreBadge kind="apple"  href={APP_STORE_URL}  size={size} />
      <AppStoreBadge kind="google" href={PLAY_STORE_URL} size={size} />
    </div>
  );
}
