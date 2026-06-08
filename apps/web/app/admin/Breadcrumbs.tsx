'use client';

/**
 * Compact breadcrumb trail for the admin section. Rendered at the
 * very top of every /admin/* page so the super-admin can hop back
 * to the landing without using the browser back button.
 *
 * Pass in the trail as an array of {label, href}. The final entry
 * is rendered as plain text (no link) since it's the current page.
 *
 * Style intentionally mirrors a small <nav> chip strip rather than
 * full top-bar nav — AppShell already owns the title bar.
 */

import Link from 'next/link';
import { ChevronRight, Home } from 'lucide-react';

export interface Crumb {
  label: string;
  /** Omit on the final crumb (current page). */
  href?: string;
}

export default function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 text-[12px] flex-wrap"
      style={{ color: 'var(--gc-text-3)' }}>
      <Link
        href="/"
        className="inline-flex items-center gap-1 hover:underline"
        style={{ color: 'var(--gc-text-3)' }}>
        <Home size={12} />
        Home
      </Link>
      {trail.map((crumb, i) => {
        const isLast = i === trail.length - 1;
        return (
          <span key={`${crumb.label}-${i}`} className="inline-flex items-center gap-1">
            <ChevronRight size={12} style={{ opacity: 0.6 }} />
            {isLast || !crumb.href ? (
              <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>{crumb.label}</span>
            ) : (
              <Link
                href={crumb.href}
                className="hover:underline"
                style={{ color: 'var(--gc-text-3)' }}>
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
