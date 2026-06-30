'use client';

/**
 * HeroFeatureNav — a pill of tabs that smooth-scrolls to each feature
 * section on the page (Google-style section switcher). The active tab
 * tracks whichever section is in view (IntersectionObserver). Jump targets
 * need `scroll-margin-top` to clear the sticky bar(s) above them.
 *
 *  - default (non-sticky): meant to be absolutely pinned inside a hero
 *    (the /product/* pages position it at the hero bottom).
 *  - sticky: renders a `position: sticky` row that sits at the hero bottom
 *    and pins under the 68px MarketingNav as you scroll, frosting a
 *    full-width backdrop once stuck (the home page).
 */
import { useEffect, useRef, useState } from 'react';

export interface FeatureTab { id: string; label: string }

export default function HeroFeatureNav({ items, sticky = false, accent = '#202124' }: { items: ReadonlyArray<FeatureTab>; sticky?: boolean; accent?: string }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? '');
  const [stuck, setStuck] = useState(false);
  const [barH, setBarH] = useState(73);
  const barRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // Active-tab scrollspy.
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive((vis[0].target as HTMLElement).id);
      },
      { rootMargin: '-42% 0px -52% 0px', threshold: 0 },
    );
    items.forEach((it) => {
      const el = document.getElementById(it.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [items]);

  // Keep the active tab centered in the horizontally-scrollable rail as the
  // scrollspy advances it — on mobile the rail scrolls, so the current
  // section's tab is always brought into view (no-op on desktop where it fits).
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const btn = rail.querySelector<HTMLElement>(`[data-tab-id="${active}"]`);
    if (!btn) return;
    const br = btn.getBoundingClientRect();
    const rr = rail.getBoundingClientRect();
    rail.scrollBy({ left: (br.left + br.width / 2) - (rr.left + rr.width / 2), behavior: 'smooth' });
  }, [active]);

  // Stuck detection (sticky mode): the row counts as "stuck" (which grows the
  // frosted backdrop) only once it has actually pinned up under the 68px nav
  // (its top reaches 68). It must NOT count as stuck just because it starts
  // below the fold on a tall hero at scroll 0 — that wrongly grew the frost and
  // looked like the nav bar sliding down at the very top of the page.
  useEffect(() => {
    if (!sticky) return;
    const el = barRef.current;
    if (!el) return;
    setBarH(el.offsetHeight);
    const obs = new IntersectionObserver(
      ([e]) => setStuck(e.boundingClientRect.top <= 69),
      { rootMargin: '-69px 0px 0px 0px', threshold: [0, 1] },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [sticky]);

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActive(id);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const pill = (
    <nav className="mx-auto w-full max-w-[1600px] px-5 sm:px-6 md:px-8 lg:px-12 flex justify-center">
      <style>{`.hfn-rail::-webkit-scrollbar{display:none}`}</style>
      <div
        ref={railRef}
        className="hfn-rail flex items-center gap-1"
        style={{
          background: '#fff',
          border: '1px solid #e8eaed',
          borderRadius: 999,
          boxShadow: 'var(--shadow-3)',
          padding: 6,
          maxWidth: '100%',
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {items.map((it) => {
          const on = active === it.id;
          return (
            <button
              key={it.id}
              type="button"
              data-tab-id={it.id}
              onClick={() => jump(it.id)}
              aria-current={on ? 'true' : undefined}
              className="font-display whitespace-nowrap transition-all"
              style={{
                fontWeight: on ? 700 : 500,
                fontSize: 14.5,
                lineHeight: 1,
                color: on ? accent : '#5f6368',
                background: 'transparent',
                border: 'none',
                borderRadius: 999,
                padding: '10px 18px',
                cursor: 'pointer',
                flex: 'none',
              }}
            >
              {it.label}
            </button>
          );
        })}
      </div>
    </nav>
  );

  if (!sticky) return pill;

  return (
    <>
      {/* ONE frosted layer behind BOTH the 68px MarketingNav and this pill
          row. Owning the frost in a single element avoids the seam that two
          stacked backdrop-filters produce where they meet. It grows to cover
          the pill row once stuck; the MarketingNav renders `frostless` on
          these pages so the top 68px isn't double-frosted. */}
      <div
        aria-hidden
        className="fixed inset-x-0 top-0 z-[39]"
        style={{
          height: stuck ? 68 + barH : 68,
          background: 'rgba(255,255,255,0.82)',
          WebkitBackdropFilter: 'saturate(180%) blur(12px)',
          backdropFilter: 'saturate(180%) blur(12px)',
          transition: 'height .25s',
          pointerEvents: 'none',
        }}
      />
      <div
        ref={barRef}
        className="sticky z-40 hidden md:block"
        style={{
          top: 68,
          paddingTop: 12,
          paddingBottom: 12,
          background: 'transparent',
        }}
      >
        {pill}
      </div>
    </>
  );
}
