'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, CheckCircle2, Loader2, Menu, Search, X, Trash2, RotateCcw, BarChart2, Users, LayoutDashboard, MoreHorizontal, SlidersHorizontal, FileCheck2, Receipt, Eye, Fuel, Wrench, Container } from 'lucide-react';
import { OrganizationSwitcher, UserButton, useUser } from '@clerk/nextjs';
import { useCalendarStore } from '@/store/useCalendarStore';
import { localDateStr, nowInTz } from '@/lib/time-utils';
import { searchEvents } from '@/lib/db';
import LearningCenter from '@/components/onboarding/LearningCenter';
import { NotificationsBell } from '@/components/toolbar/NotificationsBell';
import Tooltip from '@/components/ui/Tooltip';
import { Authorize } from '@/components/Authorize';
import DatePicker from '@/components/calendar/DatePicker';
import TrailerFleetMapPanel from '@/components/calendar/TrailerFleetMapPanel';

function formatToolbarDate(d: Date, viewMode: 'day' | 'week'): string {
  if (viewMode === 'day') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // Week range — built manually to avoid ICU quirks with partial date options
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dow = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - ((dow + 6) % 7));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const sameMonth = mon.getMonth() === sun.getMonth();
  const sameYear  = mon.getFullYear() === sun.getFullYear();
  const monStr = `${MONTHS[mon.getMonth()]} ${mon.getDate()}`;
  if (sameMonth && sameYear)
    return `${monStr} – ${sun.getDate()}, ${sun.getFullYear()}`;
  if (sameYear)
    return `${monStr} – ${MONTHS[sun.getMonth()]} ${sun.getDate()}, ${sun.getFullYear()}`;
  return `${monStr}, ${mon.getFullYear()} – ${MONTHS[sun.getMonth()]} ${sun.getDate()}, ${sun.getFullYear()}`;
}

function isToday(d: Date, tz: string): boolean {
  return localDateStr(d) === localDateStr(nowInTz(tz));
}

function eventDateLabel(start: string): string {
  const [y, m, d] = start.split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function CalendarToolbar() {
  const {
    currentDate, setCurrentDate, resourceWidth, setResourceWidth, resourceWidthLocked, unlockResourceWidth,
    rowHeight, setRowHeight,
    sidebarOpen, toggleSidebar,
    events, assets, trailers, openEditModal, openCreateModal, mergeEvents,
    deletedEvents, restoreEvent, purgeEvent, clearTrash,
    viewMode, setViewMode,
    batchParseProgress, batchParseTotal, batchMinimized, batchItems, modalOpen, clearBatch, requestBatchCancel,
    calendarTimezone,
    showStatusOverlay,    setShowStatusOverlay,
    showConfirmedOverlay, setShowConfirmedOverlay,
    showPodOverlay,       setShowPodOverlay,
    showBillingOverlay,   setShowBillingOverlay,
  } = useCalendarStore();

  const { user } = useUser();
  const currentUserName = user?.fullName ?? user?.firstName ?? 'Unknown';

  const [searchOpen,         setSearchOpen]         = useState(false);
  const [query,              setQuery]              = useState('');
  const [trashOpen,          setTrashOpen]          = useState(false);
  const [trailerFleetOpen,   setTrailerFleetOpen]   = useState(false);
  // Hide the button when no trailers — keeps the toolbar clean for
  // orgs that don't use trailers yet. Retired trailers don't count.
  const hasActiveTrailers = trailers.some(t => !t.activeTo);
  const [trashAllOpen,       setTrashAllOpen]       = useState(false);
  const [trashQuery,         setTrashQuery]         = useState('');
  const [confirmClearTrash,  setConfirmClearTrash]  = useState(false);
  const [moreOpen,           setMoreOpen]           = useState(false);
  const [viewOpen,           setViewOpen]           = useState(false);
  const [layersOpen,         setLayersOpen]         = useState(false);
  const [confirmCancelBatch, setConfirmCancelBatch] = useState(false);
  const searchInputRef  = useRef<HTMLInputElement>(null);
  const searchContainer = useRef<HTMLDivElement>(null);
  const trashContainer  = useRef<HTMLDivElement>(null);
  const moreContainer   = useRef<HTMLDivElement>(null);
  const viewContainer   = useRef<HTMLDivElement>(null);
  const layersContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const batchVisible = (batchParseTotal > 0 && batchMinimized) || (batchItems.length > 0 && batchParseTotal === 0 && !modalOpen);
  useEffect(() => {
    if (!batchVisible) setConfirmCancelBatch(false);
  }, [batchVisible]);

  useEffect(() => {
    if (!searchOpen && !trashOpen && !moreOpen && !viewOpen && !layersOpen) return;
    const handler = (e: MouseEvent) => {
      if (searchOpen && searchContainer.current && !searchContainer.current.contains(e.target as Node)) {
        setSearchOpen(false); setQuery('');
      }
      if (trashOpen && trashContainer.current && !trashContainer.current.contains(e.target as Node)) {
        setTrashOpen(false);
      }
      if (moreOpen && moreContainer.current && !moreContainer.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
      if (viewOpen && viewContainer.current && !viewContainer.current.contains(e.target as Node)) {
        setViewOpen(false);
      }
      if (layersOpen && layersContainer.current && !layersContainer.current.contains(e.target as Node)) {
        setLayersOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [searchOpen, trashOpen, moreOpen, viewOpen, layersOpen]);

  function daysUntilPurge(deletedAt: string): number {
    const age = Date.now() - new Date(deletedAt).getTime();
    return Math.max(0, 30 - Math.floor(age / (24 * 60 * 60 * 1000)));
  }

  const q = query.trim().toLowerCase();

  // DB-backed search — searches all history, not just the loaded window
  const { orgId } = useCalendarStore();
  const [dbResults,     setDbResults]     = useState<typeof events>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) { setDbResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      const results = await searchEvents(orgId ?? '', q);
      setDbResults(results);
      setSearchLoading(false);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q, orgId]);

  // Merge DB results with in-memory events (DB results win, deduped by id)
  const searchResults = q.length < 1 ? [] : (() => {
    const inMemory = events.filter(ev =>
      ev.title.toLowerCase().includes(q) ||
      (ev.loadNum    ?? '').toLowerCase().includes(q) ||
      (ev.refNums?.join(' ') ?? '').toLowerCase().includes(q) ||
      (ev.driverName ?? '').toLowerCase().includes(q) ||
      (ev.notes      ?? '').toLowerCase().includes(q)
    );
    const merged = new Map(dbResults.map(e => [e.id, e]));
    inMemory.forEach(e => { if (!merged.has(e.id)) merged.set(e.id, e); });
    return Array.from(merged.values()).slice(0, 10);
  })();

  const handleSelectResult = (eventId: string, start: string) => {
    const [y, m, d] = start.split('T')[0].split('-').map(Number);
    setCurrentDate(new Date(y, m - 1, d));
    // For cancelled-keep-load + recently-deleted hits, the event isn't
    // in the live events store (calendar only loads active rows in the
    // visible window). Merge the search-returned event so the modal
    // can find it on open. Calendar columns already filter out
    // deletedAt rows so this doesn't draw a bar on the grid.
    const hit = searchResults.find(e => e.id === eventId);
    if (hit && !events.some(e => e.id === eventId)) {
      mergeEvents([hit]);
    }
    openEditModal(eventId);
    setSearchOpen(false); setQuery('');
  };

  const handleRestore = (id: string, start: string) => {
    const [y, m, d] = start.split('T')[0].split('-').map(Number);
    setCurrentDate(new Date(y, m - 1, d));
    const restoreEntry = { changedAt: new Date().toISOString(), changedByName: currentUserName, loadRestored: true };
    restoreEvent(id, restoreEntry);
  };

  const go = (delta: number) => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + (viewMode === 'week' ? delta * 7 : delta));
    setCurrentDate(d);
  };

  const goToday = () => {
    const n = nowInTz(calendarTimezone);
    setCurrentDate(new Date(n.getFullYear(), n.getMonth(), n.getDate()));
  };

  // Withhold the "today" highlight until after mount — server SSR may render
  // at a different wall-clock day than the client hydrates, causing a
  // hydration mismatch on the Today pill.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const today = mounted && isToday(currentDate, calendarTimezone);

  return (
    <>
    <header
      className="shrink-0 flex items-center gap-3 px-4 select-none"
      style={{ background: 'var(--gc-surface)', height: 64, borderBottom: '1px solid var(--gc-border)' }}
    >
      {/* Hamburger — only when sidebar collapsed */}
      {!sidebarOpen && (
        <button onClick={toggleSidebar}
          className="p-2 rounded-full transition-colors mr-1"
          style={{ color: 'var(--gc-text-2)' }}
          onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
          <Menu size={20} />
        </button>
      )}

      {/* Today */}
      <button onClick={goToday}
        className="px-4 py-[7px] rounded-lg text-sm font-medium transition-all"
        style={{
          border: `1px solid ${today ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
          color: today ? 'var(--gc-blue)' : 'var(--gc-text-1)',
          background: today ? 'var(--gc-blue-light)' : 'transparent',
        }}
        onMouseOver={e => { if (!today) e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseOut={e => { e.currentTarget.style.background = today ? 'var(--gc-blue-light)' : 'transparent'; }}
      >
        Today
      </button>

      {/* Prev / Next */}
      <div className="flex items-center gap-0.5">
        {[{ delta: -1, icon: ChevronLeft }, { delta: 1, icon: ChevronRight }].map(({ delta, icon: Icon }) => (
          <button key={delta} onClick={() => go(delta)}
            className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
            <Icon size={18} />
          </button>
        ))}
      </div>

      {/* Date label — same popup picker as the load modal. Click to
          jump to a specific date; clicking opens the month calendar.
          We keep the toolbar's existing label format (compact for
          day view, range for week view) via the displayText override
          and strip the picker's default border so it sits flush like
          the original h1 did. */}
      <div suppressHydrationWarning className="hidden lg:block shrink-0">
        <DatePicker
          value={localDateStr(currentDate)}
          onChange={(v) => {
            const [y, m, d] = v.split('-').map(Number);
            setCurrentDate(new Date(y, m - 1, d));
          }}
          headerColor="#1a73e8"
          displayText={formatToolbarDate(currentDate, viewMode)}
          buttonStyle={{
            width: 'auto',
            border: 'none',
            background: 'transparent',
            padding: '4px 8px',
            fontSize: 20,
            fontWeight: 400,
            letterSpacing: '-0.2px',
            color: 'var(--gc-text-1)',
          }}
        />
      </div>

      {/* Command Center */}
      <Link
        href="/board"
        className="flex items-center gap-1.5 px-3 py-[7px] rounded-lg text-[13px] font-semibold transition-colors"
        style={{ background: '#1a73e8', color: '#fff', border: '1px solid #1a73e8' }}
        onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = '#1558d6'; (e.currentTarget as HTMLElement).style.borderColor = '#1558d6'; }}
        onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = '#1a73e8'; (e.currentTarget as HTMLElement).style.borderColor = '#1a73e8'; }}
      >
        <LayoutDashboard size={14} />
        Command Center
      </Link>

      <div className="flex-1" />

      {/* ── Right controls ── */}
      <div className="flex items-center gap-1 shrink-0">

        {/* Trailer fleet — one-click open of the fleet-wide trailer
            map. Hidden when the org hasn't set up any trailers yet. */}
        {hasActiveTrailers && (
          <Tooltip content="Trailer fleet map">
            <button
              onClick={() => setTrailerFleetOpen(true)}
              className="p-2 rounded-full transition-colors mr-1"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
            >
              <Container size={18} />
            </button>
          </Tooltip>
        )}

        {/* Batch progress / ready indicator */}
        {(() => {
          const isParsing = batchParseTotal > 0;
          const isReady   = batchItems.length > 0 && !isParsing && !modalOpen;
          const show      = (isParsing && batchMinimized) || isReady;
          if (!show) return null;
          const current = Math.min(batchParseProgress + 1, batchParseTotal);
          return (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg mr-1"
              style={{
                background: isParsing ? 'var(--gc-hover)' : '#f0fdf4',
                border: `1px solid ${isParsing ? 'var(--gc-border)' : '#bbf7d0'}`,
              }}>
              {isParsing ? (
                <>
                  <Loader2 size={13} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--gc-text-2)', whiteSpace: 'nowrap' }}>
                    Parsing {current} of {batchParseTotal}…
                  </span>
                  {confirmCancelBatch ? (
                    <>
                      <span className="text-xs" style={{ color: 'var(--gc-text-3)', marginLeft: 2 }}>Cancel?</span>
                      <button
                        onClick={() => { setConfirmCancelBatch(false); requestBatchCancel(); }}
                        className="text-xs font-semibold px-2 py-0.5 rounded-lg transition-colors"
                        style={{ color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#fee2e2')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#fef2f2')}>
                        Yes
                      </button>
                      <button
                        onClick={() => setConfirmCancelBatch(false)}
                        className="text-xs font-semibold transition-colors"
                        style={{ color: 'var(--gc-text-2)' }}
                        onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                        onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmCancelBatch(true)}
                      className="flex items-center justify-center rounded-full transition-colors"
                      style={{ color: 'var(--gc-text-3)', width: 16, height: 16 }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <X size={11} />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <CheckCircle2 size={13} style={{ color: '#16a34a' }} />
                  <span className="text-xs font-medium" style={{ color: '#15803d', whiteSpace: 'nowrap' }}>
                    {batchItems.length} load{batchItems.length !== 1 ? 's' : ''} ready
                  </span>
                  <button onClick={() => openCreateModal()}
                    className="text-xs font-semibold transition-colors ml-0.5"
                    style={{ color: 'var(--gc-blue)' }}
                    onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                    onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
                    Review
                  </button>
                  {confirmCancelBatch ? (
                    <>
                      <span className="text-xs" style={{ color: 'var(--gc-text-3)', marginLeft: 2 }}>Discard?</span>
                      <button
                        onClick={() => { setConfirmCancelBatch(false); clearBatch(); }}
                        className="text-xs font-semibold px-2 py-0.5 rounded-lg transition-colors"
                        style={{ color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#fee2e2')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#fef2f2')}>
                        Yes
                      </button>
                      <button
                        onClick={() => setConfirmCancelBatch(false)}
                        className="text-xs font-semibold transition-colors"
                        style={{ color: 'var(--gc-text-2)' }}
                        onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                        onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmCancelBatch(true)}
                      className="flex items-center justify-center rounded-full transition-colors"
                      style={{ color: 'var(--gc-text-3)', width: 16, height: 16 }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <X size={11} />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {/* Search */}
        <div ref={searchContainer} style={{ position: 'relative' }}>
          <div className="flex items-center"
            style={{
              border: searchOpen ? '1px solid var(--gc-blue)' : '1px solid transparent',
              borderRadius: 24,
              background: searchOpen ? 'var(--gc-surface)' : 'transparent',
              transition: 'width 200ms ease, background 150ms, border-color 150ms, box-shadow 150ms',
              width: searchOpen ? 260 : 36,
              height: 36,
              overflow: 'hidden',
              boxShadow: searchOpen ? 'var(--shadow-1)' : 'none',
            }}>
            <button
              onClick={() => { setSearchOpen(o => !o); if (searchOpen) setQuery(''); }}
              className="flex items-center justify-center shrink-0 rounded-full transition-colors"
              style={{ width: 36, height: 36, color: searchOpen ? 'var(--gc-blue)' : 'var(--gc-text-2)' }}
              onMouseOver={e => { if (!searchOpen) e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseOut={e => { if (!searchOpen) e.currentTarget.style.background = 'transparent'; }}>
              <Search size={17} />
            </button>
            <input ref={searchInputRef} type="text" value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { setSearchOpen(false); setQuery(''); } }}
              placeholder="Search loads…"
              style={{
                flex: 1, border: 'none', outline: 'none', fontSize: 14,
                color: 'var(--gc-text-1)', background: 'transparent',
                paddingRight: query ? 4 : 12, opacity: searchOpen ? 1 : 0,
              }} />
            {query && searchOpen && (
              <button onClick={() => setQuery('')}
                className="shrink-0 flex items-center justify-center mr-1 rounded-full"
                style={{ width: 20, height: 20, color: 'var(--gc-text-3)' }}
                onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                <X size={13} />
              </button>
            )}
          </div>

          {searchOpen && q.length > 0 && (
            <div className="absolute right-0 overflow-hidden"
              style={{ top: 'calc(100% + 6px)', minWidth: 320, borderRadius: 10, boxShadow: 'var(--shadow-3)', border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', zIndex: 100 }}>
              {searchLoading && searchResults.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm" style={{ color: 'var(--gc-text-3)' }}>
                  <Loader2 size={13} className="animate-spin" />
                  Searching…
                </div>
              ) : searchResults.length === 0 ? (
                <div className="px-4 py-3 text-sm" style={{ color: 'var(--gc-text-3)' }}>No loads found</div>
              ) : searchResults.map(ev => {
                const asset = assets.find(a => a.id === ev.assetId);
                // Status pill: distinguish active / cancelled-keep-load /
                // fully-deleted. cancel-keep-load drops the event row
                // but leaves the load record alive; full delete drops
                // both. See Load.deletedAt + Load.loadDeletedAt.
                const pill = ev.deletedAt
                  ? (ev.loadDeletedAt
                      ? { label: 'Deleted',   bg: '#fee2e2', fg: '#991b1b' }
                      : { label: 'Cancelled', bg: '#fef3c7', fg: '#92400e' })
                  : null;
                return (
                  <button key={ev.id} onClick={() => handleSelectResult(ev.id, ev.start)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                    onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: asset?.color ?? '#9aa0a6', opacity: pill ? 0.5 : 1 }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold truncate" style={{ color: pill ? 'var(--gc-text-2)' : 'var(--gc-text-1)' }}>{ev.title}</div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
                        {eventDateLabel(ev.start)}
                        {ev.loadNum && <> · <span style={{ color: 'var(--gc-text-2)', fontWeight: 600 }}>#{ev.loadNum}</span></>}
                        {asset && <> · {asset.name}{asset.unit ? ` #${asset.unit}` : ''}</>}
                        {ev.driverName && <> · {ev.driverName}</>}
                      </div>
                    </div>
                    {pill && (
                      <span
                        className="text-[10px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 shrink-0"
                        style={{ background: pill.bg, color: pill.fg, letterSpacing: '0.5px' }}
                      >
                        {pill.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Trash */}
        <div ref={trashContainer} style={{ position: 'relative' }}>
          <Tooltip content="Recently deleted" placement="bottom">
            <button
              data-tour="trash"
              onClick={() => setTrashOpen(o => !o)}
              className="flex items-center justify-center w-9 h-9 rounded-full transition-colors relative"
              style={{ color: trashOpen ? 'var(--gc-blue)' : 'var(--gc-text-2)', background: trashOpen ? 'var(--gc-blue-light)' : 'transparent' }}
              onMouseOver={e => { if (!trashOpen) e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseOut={e => { if (!trashOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Trash2 size={17} />
              {deletedEvents.length > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full" style={{ background: 'var(--gc-red)' }} />
              )}
            </button>
          </Tooltip>

          {trashOpen && (
            <div className="absolute right-0 flex flex-col"
              style={{ top: 'calc(100% + 6px)', width: 340, maxHeight: 420, borderRadius: 10, boxShadow: 'var(--shadow-3)', border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', zIndex: 100, overflow: 'hidden' }}>
              <div className="flex items-center justify-between px-4 py-3 shrink-0"
                style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                <span className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  Recently Deleted
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setTrashOpen(false); setTrashAllOpen(true); setTrashQuery(''); }}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg transition-colors"
                    style={{ color: 'var(--gc-blue)' }}
                    onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                    onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                    <Search size={11} />
                    View all
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                {deletedEvents.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-center" style={{ color: 'var(--gc-text-3)' }}>
                    Trash is empty
                  </div>
                ) : [...deletedEvents].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime()).slice(0, 10).map(ev => {
                  const asset = assets.find(a => a.id === ev.assetId);
                  const days  = daysUntilPurge(ev.deletedAt);
                  return (
                    <div key={ev.id}
                      className="flex items-center gap-3 px-4 py-2.5"
                      style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: asset?.color ?? '#9aa0a6' }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>{ev.title}</div>
                        <div className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
                          <span>{eventDateLabel(ev.start)}{ev.loadNum ? ` · #${ev.loadNum}` : ''}</span>
                          <span style={{ color: days <= 5 ? '#d93025' : 'var(--gc-text-3)' }}>· {days}d left</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button onClick={() => handleRestore(ev.id, ev.start)}
                          className="p-1.5 rounded-full transition-colors" title="Restore"
                          style={{ color: 'var(--gc-blue)' }}
                          onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                          onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                          <RotateCcw size={14} />
                        </button>
                        <button onClick={() => purgeEvent(ev.id)}
                          className="p-1.5 rounded-full transition-colors" title="Delete permanently"
                          style={{ color: 'var(--gc-text-3)' }}
                          onMouseOver={e => { e.currentTarget.style.color = '#d93025'; e.currentTarget.style.background = 'rgba(217,48,37,.08)'; }}
                          onMouseOut={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}>
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {deletedEvents.length > 10 && (
                  <button
                    onClick={() => { setTrashOpen(false); setTrashAllOpen(true); setTrashQuery(''); }}
                    className="w-full text-xs py-2.5 transition-colors"
                    style={{ color: 'var(--gc-blue)' }}
                    onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                    +{deletedEvents.length - 10} more — View all
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Trash — full search panel (modal overlay) */}
        {trashAllOpen && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center"
            style={{ paddingTop: 80, background: 'rgba(0,0,0,0.35)' }}
            onMouseDown={e => { if (e.target === e.currentTarget) setTrashAllOpen(false); }}
          >
            <div className="flex flex-col rounded-xl overflow-hidden"
              style={{ width: 520, maxHeight: '72vh', boxShadow: 'var(--shadow-3)', background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
              {/* Panel header */}
              <div className="flex items-center justify-between px-5 py-4 shrink-0"
                style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                <span className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  Deleted Loads ({deletedEvents.length})
                </span>
                <button onClick={() => setTrashAllOpen(false)}
                  className="p-1.5 rounded-full transition-colors"
                  style={{ color: 'var(--gc-text-3)' }}
                  onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                  <X size={16} />
                </button>
              </div>

              {/* Search bar */}
              <div className="px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
                  <Search size={14} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                  <input
                    autoFocus
                    value={trashQuery}
                    onChange={e => setTrashQuery(e.target.value)}
                    placeholder="Search deleted loads…"
                    className="flex-1 bg-transparent text-sm outline-none"
                    style={{ color: 'var(--gc-text-1)' }}
                  />
                  {trashQuery && (
                    <button onClick={() => setTrashQuery('')} style={{ color: 'var(--gc-text-3)' }}>
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>

              {/* Results */}
              <div className="flex-1 overflow-y-auto">
                {(() => {
                  const tq = trashQuery.trim().toLowerCase();
                  const filtered = [...deletedEvents]
                    .sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime())
                    .filter(ev =>
                      !tq ||
                      ev.title.toLowerCase().includes(tq) ||
                      (ev.loadNum ?? '').toLowerCase().includes(tq) ||
                      (ev.driverName ?? '').toLowerCase().includes(tq)
                    );
                  if (filtered.length === 0) {
                    return (
                      <div className="px-5 py-10 text-sm text-center" style={{ color: 'var(--gc-text-3)' }}>
                        {tq ? 'No results' : 'Trash is empty'}
                      </div>
                    );
                  }
                  return filtered.map(ev => {
                    const asset = assets.find(a => a.id === ev.assetId);
                    const days  = daysUntilPurge(ev.deletedAt);
                    return (
                      <div key={ev.id}
                        className="flex items-center gap-3 px-5 py-3"
                        style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: asset?.color ?? '#9aa0a6' }} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>{ev.title}</div>
                          <div className="text-[11px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--gc-text-3)' }}>
                            <span>{eventDateLabel(ev.start)}</span>
                            {ev.loadNum && <span>#{ev.loadNum}</span>}
                            {ev.driverName && <span>{ev.driverName}</span>}
                            {asset && <span>{asset.name}</span>}
                            <span style={{ color: days <= 5 ? '#d93025' : 'var(--gc-text-3)' }}>· {days}d until purge</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => { handleRestore(ev.id, ev.start); }}
                            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-colors"
                            style={{ color: 'var(--gc-blue)', border: '1px solid var(--gc-blue)' }}
                            onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                            <RotateCcw size={11} />
                            Restore
                          </button>
                          <button onClick={() => purgeEvent(ev.id)}
                            className="p-1.5 rounded-full transition-colors" title="Delete permanently"
                            style={{ color: 'var(--gc-text-3)' }}
                            onMouseOver={e => { e.currentTarget.style.color = '#d93025'; e.currentTarget.style.background = 'rgba(217,48,37,.08)'; }}
                            onMouseOut={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}>
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-5 py-3 shrink-0"
                style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
                {confirmClearTrash ? (
                  <div className="flex items-center gap-3 w-full">
                    <span className="text-xs flex-1" style={{ color: 'var(--gc-text-2)' }}>
                      Permanently delete expired loads?
                    </span>
                    <button
                      onClick={() => { clearTrash(); setConfirmClearTrash(false); }}
                      className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                      style={{ background: '#d93025', color: '#fff' }}
                      onMouseOver={e => (e.currentTarget.style.background = '#b31412')}
                      onMouseOut={e => (e.currentTarget.style.background = '#d93025')}>
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmClearTrash(false)}
                      className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                      style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                      onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
                      Loads are permanently deleted after 30 days
                    </span>
                    {deletedEvents.some(e => daysUntilPurge(e.deletedAt) === 0) && (
                      <button
                        onClick={() => setConfirmClearTrash(true)}
                        className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                        style={{ color: '#d93025' }}
                        onMouseOver={e => (e.currentTarget.style.background = 'rgba(217,48,37,.08)')}
                        onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                        Clear expired
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Learning Center */}
        <LearningCenter />

        {/* Layers popover — toggle which info overlays render on the
            calendar event cards (status, confirmed, POD, billing). */}
        <div ref={layersContainer} style={{ position: 'relative' }}>
          <Tooltip content="Layers" placement="bottom">
            <button
              onClick={() => setLayersOpen(o => !o)}
              className="flex items-center justify-center w-9 h-9 rounded-full transition-colors"
              style={{ color: layersOpen ? 'var(--gc-blue)' : 'var(--gc-text-2)', background: layersOpen ? 'var(--gc-blue-light)' : 'transparent' }}
              onMouseOver={e => { if (!layersOpen) e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseOut={e => { if (!layersOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Eye size={16} />
            </button>
          </Tooltip>
          {layersOpen && (
            <div className="absolute right-0 flex flex-col"
              style={{
                top: 'calc(100% + 6px)', width: 240, borderRadius: 10,
                boxShadow: 'var(--shadow-3)', border: '1px solid var(--gc-border-light)',
                background: 'var(--gc-surface)', zIndex: 100, padding: 6,
              }}>
              <div className="px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-wider"
                style={{ color: 'var(--gc-text-1)' }}>
                Show on calendar
              </div>
              {([
                { key: 'status',    label: 'Load status pill',   value: showStatusOverlay,    set: setShowStatusOverlay    },
                { key: 'confirmed', label: 'Driver confirmed',   value: showConfirmedOverlay, set: setShowConfirmedOverlay },
                { key: 'pod',       label: 'POD uploaded',       value: showPodOverlay,       set: setShowPodOverlay       },
              ] as const).map(row => (
                <label key={row.key}
                  className="flex items-center justify-between gap-3 px-2.5 py-2 rounded cursor-pointer transition-colors"
                  style={{ background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <span className="text-[13px]" style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>
                    {row.label}
                  </span>
                  {/* Tiny custom toggle — switch-like, ~30×16 */}
                  <span
                    role="switch"
                    aria-checked={row.value}
                    onClick={(e) => { e.preventDefault(); row.set(!row.value); }}
                    style={{
                      width: 30, height: 16, borderRadius: 999,
                      background: row.value ? 'var(--gc-blue)' : 'var(--gc-border)',
                      position: 'relative', flexShrink: 0,
                      transition: 'background 150ms',
                    }}>
                    <span style={{
                      position: 'absolute', top: 2, left: row.value ? 16 : 2,
                      width: 12, height: 12, borderRadius: 999, background: '#fff',
                      transition: 'left 150ms',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                    }} />
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* View sliders popover */}
        <div ref={viewContainer} style={{ position: 'relative' }}>
          <Tooltip content="Screen adjustments" placement="bottom">
            <button
              onClick={() => setViewOpen(o => !o)}
              className="flex items-center justify-center w-9 h-9 rounded-full transition-colors"
              style={{ color: viewOpen ? 'var(--gc-blue)' : 'var(--gc-text-2)', background: viewOpen ? 'var(--gc-blue-light)' : 'transparent' }}
              onMouseOver={e => { if (!viewOpen) e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseOut={e => { if (!viewOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <SlidersHorizontal size={16} />
            </button>
          </Tooltip>
          {viewOpen && (
            <div className="absolute right-0 flex flex-col"
              style={{ top: 'calc(100% + 6px)', width: 220, borderRadius: 10, boxShadow: 'var(--shadow-3)', border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', zIndex: 100, padding: '12px 16px', gap: 12, display: 'flex', flexDirection: 'column' }}>
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-medium w-8 shrink-0" style={{ color: 'var(--gc-text-3)' }}>Cols</span>
                <input type="range" min={80} max={800} value={resourceWidth}
                  onChange={e => setResourceWidth(+e.target.value, true)}
                  className="flex-1 cursor-pointer" />
                {resourceWidthLocked && (
                  <button
                    onClick={() => unlockResourceWidth()}
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
                    style={{ color: 'var(--gc-blue)', background: 'var(--gc-blue-light)', border: 'none', cursor: 'pointer' }}
                    title="Reset to auto-fit"
                  >Auto</button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-medium w-8 shrink-0" style={{ color: 'var(--gc-text-3)' }}>Rows</span>
                <input type="range" min={40} max={160} value={rowHeight}
                  onChange={e => setRowHeight(+e.target.value)}
                  className="flex-1 cursor-pointer" />
              </div>
            </div>
          )}
        </div>

        {/* Day / Week toggle */}
        <div
          data-tour="view-toggle"
          className="flex items-center rounded-full ml-1 shrink-0"
          style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-hover)', padding: 2 }}
        >
          {(['day', 'week'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className="px-3 py-1 rounded-full text-[13px] font-medium transition-all capitalize"
              style={{
                background: viewMode === mode ? 'var(--gc-surface)' : 'transparent',
                color:      viewMode === mode ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                boxShadow:  viewMode === mode ? 'var(--shadow-1)' : 'none',
              }}
            >
              {mode === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </div>

        {/* More menu */}
        <div ref={moreContainer} style={{ position: 'relative' }}>
          <button
            onClick={() => setMoreOpen(o => !o)}
            className="flex items-center gap-1.5 px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors"
            style={{
              color: moreOpen ? 'var(--gc-blue)' : 'var(--gc-text-2)',
              border: `1px solid ${moreOpen ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
              background: moreOpen ? 'var(--gc-blue-light)' : 'transparent',
            }}
            onMouseOver={e => { if (!moreOpen) e.currentTarget.style.background = 'var(--gc-hover)'; }}
            onMouseOut={e => { if (!moreOpen) e.currentTarget.style.background = 'transparent'; }}
          >
            <MoreHorizontal size={14} />
            More
          </button>
          {moreOpen && (
            <div className="absolute right-0 flex flex-col overflow-hidden"
              style={{ top: 'calc(100% + 6px)', minWidth: 180, borderRadius: 10, boxShadow: 'var(--shadow-3)', border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', zIndex: 100 }}>
              <Authorize cap="dashboard.access">
                <Link href="/dashboard" onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors"
                  style={{ color: 'var(--gc-text-1)' }}
                  onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
                  onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <BarChart2 size={15} style={{ color: 'var(--gc-text-3)' }} />
                  Dashboard
                </Link>
              </Authorize>
              <Authorize cap="closeout.access" module="closeout">
                <Link href="/closeout" onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors"
                  style={{ color: 'var(--gc-text-1)', borderTop: '1px solid var(--gc-border-light)' }}
                  onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
                  onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <FileCheck2 size={15} style={{ color: 'var(--gc-text-3)' }} />
                  Closeout
                </Link>
              </Authorize>
              <Authorize cap="accounting.access" module="accounting">
                <Link href="/accounting" onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors"
                  style={{ color: 'var(--gc-text-1)', borderTop: '1px solid var(--gc-border-light)' }}
                  onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
                  onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <Receipt size={15} style={{ color: 'var(--gc-text-3)' }} />
                  Accounting
                </Link>
              </Authorize>
              <Authorize cap="payroll.access" module="payroll">
                <Link href="/payroll" onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors"
                  style={{ color: 'var(--gc-text-1)', borderTop: '1px solid var(--gc-border-light)' }}
                  onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
                  onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <Users size={15} style={{ color: 'var(--gc-text-3)' }} />
                  Payroll
                </Link>
              </Authorize>
              <Authorize cap="fuel.access" module="fuel">
                <Link href="/fuel" onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors"
                  style={{ color: 'var(--gc-text-1)', borderTop: '1px solid var(--gc-border-light)' }}
                  onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
                  onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <Fuel size={15} style={{ color: 'var(--gc-text-3)' }} />
                  Fuel
                </Link>
              </Authorize>
              <Authorize cap="maintenance.access" module="maintenance">
                <Link href="/maintenance" onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors"
                  style={{ color: 'var(--gc-text-1)', borderTop: '1px solid var(--gc-border-light)' }}
                  onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
                  onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <Wrench size={15} style={{ color: 'var(--gc-text-3)' }} />
                  Maintenance
                </Link>
              </Authorize>
            </div>
          )}
        </div>

        {/* Notifications bell — driver nudges + scheduled-push log
            for the last 48h. Sits before the org/user group so the
            badge isn't visually competing with the avatars. */}
        <div className="flex items-center ml-1 pl-3" style={{ borderLeft: '1px solid var(--gc-border-light)' }}>
          <NotificationsBell />
        </div>

        {/* Org + User — icon-only avatars to save toolbar space */}
        <div className="flex items-center gap-1.5 pl-3" style={{ borderLeft: '1px solid var(--gc-border-light)' }}>
          <OrganizationSwitcher
            hidePersonal
            afterCreateOrganizationUrl="/calendar"
            afterSelectOrganizationUrl="/calendar"
            appearance={{
              elements: {
                rootBox: 'flex items-center',
                organizationSwitcherTrigger: 'flex items-center p-0',
                // Hide the org name text — show avatar only
                organizationPreviewMainIdentifier: { display: 'none' },
                organizationPreviewSecondaryIdentifier: { display: 'none' },
                organizationPreviewAvatarContainer: { margin: 0 },
                organizationSwitcherTriggerIcon: { display: 'none' },
              },
            }}
          />
          <UserButton />
        </div>
      </div>
    </header>
    {trailerFleetOpen && <TrailerFleetMapPanel onClose={() => setTrailerFleetOpen(false)} />}
    </>
  );
}
