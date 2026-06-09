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
 *   - Click on a page where the section EXISTS (the homepage) → smooth-
 *     scroll to it, no URL hash update, no history entry.
 *   - Click on any OTHER page (/pricing, /contact-sales, /sign-in…)
 *     → navigate to `/#${to}` so the browser lands on the homepage and
 *     the native hash-scroll picks it up. This is what makes the nav
 *     work from non-home routes — previously the no-op branch just
 *     swallowed the click and the user thought the link was broken.
 *   - For server-rendered deep links (someone pastes /#pricing in the
 *     URL bar from elsewhere), the browser's default anchor behaviour
 *     still kicks in via the section's `id` attribute — we don't need
 *     to intercept that case here.
 */
import { useRouter } from 'next/navigation';
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
  const router = useRouter();
  return (
    <a
      // href points home + hash so right-click "Open in new tab" and
      // middle-click both work, plus crawlers get a real navigable URL.
      // We intercept the click below to choose between in-page scroll
      // and a real navigation.
      href={`/#${to}`}
      className={className}
      style={style}
      onClick={(e) => {
        e.preventDefault();
        const el = typeof document !== 'undefined' ? document.getElementById(to) : null;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          router.push(`/#${to}`);
        }
        onClick?.();
      }}
    >
      {children}
    </a>
  );
}
