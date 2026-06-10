'use client';

/**
 * useBlockNavigation — warn the user before they leave the page while
 * a long-running operation is in progress.
 *
 * Covers three exit paths:
 *
 *   1. Browser-level (tab close, page reload, back/forward button) via
 *      the `beforeunload` event. Modern browsers ignore the custom
 *      message and show their own "Reload site?" / "Leave site?"
 *      dialog — that's the standard the user expects anyway.
 *
 *   2. In-app link clicks (Next.js <Link>, raw <a>, anything that
 *      navigates via DOM). A capture-phase document listener catches
 *      the click before Next.js's router runs, shows a window.confirm,
 *      and aborts the navigation if the user picks Stay.
 *
 *   3. Programmatic router.push from React code in the SAME component
 *      tree. Not covered here — pass `confirmMessage` to your own
 *      check before calling router.push() if you need this. The two
 *      cases above cover ~99% of real-world exit attempts though
 *      (sidebar clicks, header logo, search-result selection, etc).
 *
 * Pass `blocked: true` while the operation is running. When `false`,
 * the listeners detach immediately so navigation works normally.
 *
 * Usage inside a busy dialog:
 *   useBlockNavigation(busy, 'Invoices are still processing. Leave anyway?');
 */

import { useEffect } from 'react';

export function useBlockNavigation(blocked: boolean, message: string): void {
  useEffect(() => {
    if (!blocked) return;

    // ── 1. Browser-level (tab close / reload / back) ──────────────
    // Modern Chrome/Firefox/Safari ignore the returnValue string and
    // show their own dialog. Older browsers (and the spec) require
    // setting returnValue to trigger the prompt at all.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = message;
      return message;
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // ── 2. In-app link clicks ─────────────────────────────────────
    // Capture phase runs BEFORE Next.js <Link>'s click handler, so
    // we get first crack at the event. window.confirm is synchronous
    // — picking Cancel cleanly stops both the navigation and the
    // synthetic React event.
    const onClickCapture = (e: MouseEvent) => {
      // Modifier-clicks (Cmd/Ctrl/Shift) and middle-clicks open in a
      // new tab — they don't take the user away from this page, so
      // there's nothing to warn about.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;

      const target = e.target as Element | null;
      const anchor = target?.closest?.('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href) return;
      // Same-page hash links / javascript:void / mailto / tel — no
      // page exit, no warning.
      if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      // Anchor explicitly opens a new tab — not leaving this page.
      if (anchor.getAttribute('target') === '_blank') return;

      // Ask the user. confirm() blocks the event loop synchronously,
      // which is exactly what we want — by the time it returns we
      // either let the navigation proceed (OK) or stop it (Cancel).
      const ok = window.confirm(message);
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClickCapture, /* capture */ true);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [blocked, message]);
}
