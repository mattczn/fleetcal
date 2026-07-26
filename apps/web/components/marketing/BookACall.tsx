/**
 * BookACall — marketing CTA that sends a visitor straight to the founder's
 * Google Calendar appointment page (11am–4pm ET, Mon–Fri). A friendly, tinted
 * callout meant to sit alongside a form or a pricing block as the "rather just
 * talk?" shortcut. Opens the booking page in a new tab.
 *
 * Presentational only (no client state) so it drops into server OR client
 * pages. Light-mode palette to match the rest of the marketing surfaces.
 */
import { CalendarClock, ArrowRight } from 'lucide-react';

/** Public Google Calendar appointment link. Keep in sync with
 *  CRM_SETTINGS_DEFAULTS.bookingUrl in packages/types/crm.ts. */
export const BOOKING_URL = 'https://calendar.app.google/VxAWq62VAGBmDrk27';

export default function BookACall({
  url     = BOOKING_URL,
  heading = 'Rather just talk it through?',
  blurb   = 'Grab a 15-minute slot on my calendar — weekdays, 11am–4pm ET.',
  cta     = 'Book a call',
}: {
  url?:     string;
  heading?: string;
  blurb?:   string;
  cta?:     string;
}) {
  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6"
      style={{
        background:   'linear-gradient(135deg, #f6f9fe 0%, #eef4fe 100%)',
        border:       '1px solid #d2e3fc',
        borderRadius: 24,
        padding:      '22px 26px',
      }}
    >
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <span
          className="shrink-0"
          style={{
            width: 46, height: 46, borderRadius: 14,
            background: '#fff', border: '1px solid #d2e3fc',
            display: 'grid', placeItems: 'center',
          }}
        >
          <CalendarClock size={22} style={{ color: '#1967d2' }} />
        </span>
        <div className="min-w-0">
          <div className="font-display" style={{ fontWeight: 700, fontSize: 18, lineHeight: 1.2, color: '#202124' }}>
            {heading}
          </div>
          <div style={{ fontSize: 14.5, lineHeight: 1.45, color: '#5f6368', marginTop: 3 }}>
            {blurb}
          </div>
        </div>
      </div>

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-display shrink-0 inline-flex items-center justify-center gap-2"
        style={{
          background:     'var(--gc-blue)',
          color:          '#fff',
          fontWeight:     600,
          fontSize:       15,
          padding:        '13px 24px',
          borderRadius:   999,
          textDecoration: 'none',
          boxShadow:      'var(--shadow-1)',
          whiteSpace:     'nowrap',
        }}
      >
        {cta} <ArrowRight size={16} />
      </a>
    </div>
  );
}
