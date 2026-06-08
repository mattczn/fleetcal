'use client';

/**
 * SmoothScrollLink — in-page anchor scroll that does NOT push the
 * `/#section` URL into browser history.
 *
 * Why this exists: a plain `<a href="#pricing">` adds `/#pricing` as a
 * separate history entry. The next forward navigation (e.g. clicking a
 * pricing card → /sign-up?plan=growth) then sits ABOVE that entry in
 * history. Clicking the browser back button pops to /#pricing — and
 * Next.js's client router doesn't always cleanly re-render when the
 * back target differs from the current page only by hash. The user ends
 * up needing to click "back" twice to actually return to /.
 *
 * Behaviour:
 *   - Click → smooth-scroll to `#${to}` if the element exists on the
 *     current page
 *   - No URL hash update, no history entry
 *   - For server-rendered deep links (someone pastes /#pricing in the
 *     URL bar from elsewhere), the browser's default anchor behaviour
 *     still kicks in via the section's `id` attribute — we don't need
 *     to intercept that case here.
 */
import type { ReactNode, CSSProperties } from 'react';

interface SmoothScrollLinkProps {
  to:        string;
  className?: string;
  style?:    CSSProperties;
  /** Fires after the smooth-scroll kicks off. Used by MarketingNav
   *  to close the mobile menu panel once a link is tapped. */
  onClick?:  () => void;
  children:  ReactNode;
}

export default function SmoothScrollLink({ to, className, style, onClick, children }: SmoothScrollLinkProps) {
  return (
    <a
      href={`#${to}`}
      className={className}
      style={style}
      onClick={(e) => {
        e.preventDefault();
        const el = document.getElementById(to);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        onClick?.();
      }}
    >
      {children}
    </a>
  );
}
