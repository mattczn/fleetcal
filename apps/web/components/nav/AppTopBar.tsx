'use client';

/**
 * AppTopBar — slim 56px header rendered on every non-calendar page.
 *
 * Replaces the old chunky 64px ManagementHeader nav bar. With navigation
 * moved to the left rail (AppSidebar), this bar only carries:
 *   - Page title + icon (left, optional)
 *   - Page-specific actions (rightSlot, optional)
 *   - Global search input (loads-first — wiring up search results is
 *     Pass 2; for now this is a focusable input that on Enter routes
 *     to /calendar?search= so it's useful right out of the gate)
 *   - Notification bell
 *   - Org switcher + user avatar
 *
 * The right side mirrors the calendar toolbar's right-side group so
 * the global controls feel consistent between calendar and everywhere
 * else, even though the rest of the layout differs.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';

interface Props {
  /** Page title rendered on the left. Optional — some pages will
   *  render their own title block inside the body instead and pass
   *  nothing here. */
  title?: string;
  icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  /** Optional page-specific controls — e.g. a period selector on
   *  Drivers, a view toggle on Closeout. Rendered between the title
   *  block and the search input. */
  rightSlot?: React.ReactNode;
}

export default function AppTopBar({ title, icon: Icon, rightSlot }: Props) {
  const router = useRouter();
  const [searchValue, setSearchValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl-K focuses the search input. Standard SaaS shortcut so
  // power users land here without reaching for the mouse. We avoid
  // hijacking when an input/textarea is already focused so it
  // doesn't fight typing elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchValue.trim();
    if (!q) return;
    // Until the global-search modal is wired, jumping to the calendar
    // with the search applied is the most useful behavior — the
    // calendar toolbar already supports a `?search=` filter chip.
    router.push(`/calendar?search=${encodeURIComponent(q)}`);
  };

  return (
    <header
      className="shrink-0 flex items-center gap-3 px-4"
      style={{
        height: 56,
        background: 'var(--gc-surface)',
        borderBottom: '1px solid var(--gc-border-light)',
        zIndex: 20,
      }}>

      {/* Title block — optional. Pages that render their own page
          header inside the body can pass nothing and the left side
          just stays empty. */}
      {title && (
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon size={18} style={{ color: 'var(--gc-text-2)' }} />}
          <h1
            className="text-[16px] font-semibold truncate"
            style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.2px' }}>
            {title}
          </h1>
        </div>
      )}

      <div className="flex-1" />

      {rightSlot}

      {/* Search input — loads-first. The placeholder hints at the
          eventual scope (loads, drivers, brokers); v1 only routes
          to the calendar's load search. */}
      <form
        onSubmit={handleSearchSubmit}
        className="relative shrink-0"
        style={{ width: 280 }}>
        <Search
          size={14}
          style={{
            position: 'absolute',
            left: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--gc-text-3)',
            pointerEvents: 'none',
          }}
        />
        <input
          ref={searchRef}
          value={searchValue}
          onChange={e => setSearchValue(e.target.value)}
          placeholder="Search loads…"
          aria-label="Search loads"
          className="w-full rounded-md outline-none text-[13px]"
          style={{
            background: 'var(--gc-bg)',
            border: '1px solid var(--gc-border-light)',
            color: 'var(--gc-text-1)',
            padding: '7px 60px 7px 30px',
            transition: 'border-color 150ms, background 150ms',
          }}
          onFocus={e => {
            e.currentTarget.style.borderColor = 'var(--gc-blue)';
            e.currentTarget.style.background = 'var(--gc-surface)';
          }}
          onBlur={e => {
            e.currentTarget.style.borderColor = 'var(--gc-border-light)';
            e.currentTarget.style.background = 'var(--gc-bg)';
          }}
        />
        {/* ⌘K hint — only renders when the input is empty + unfocused.
            Gives the user a discoverable cue without cluttering. */}
        {!searchValue && (
          <kbd
            className="hidden md:flex items-center pointer-events-none"
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              padding: '1px 6px',
              border: '1px solid var(--gc-border-light)',
              borderRadius: 4,
              fontSize: 10.5,
              fontFamily: 'inherit',
              color: 'var(--gc-text-3)',
              background: 'var(--gc-surface)',
            }}>
            ⌘K
          </kbd>
        )}
      </form>

      {/* Right-side global controls — org switcher + user button. */}
      <div className="flex items-center gap-2" style={{ borderLeft: '1px solid var(--gc-border-light)', paddingLeft: 12, marginLeft: 4 }}>
        <OrganizationSwitcher
          afterSelectOrganizationUrl="/calendar"
          hidePersonal
        />
        <UserButton />
      </div>
    </header>
  );
}
