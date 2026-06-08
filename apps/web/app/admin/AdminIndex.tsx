'use client';

/**
 * Client-side renderer for /admin. Server page handles the auth
 * gate; this just lays out three cards linking to the leaf
 * dashboards. AppShell needs to live inside a client component so
 * its internal Clerk + Zustand hooks have a client context.
 */

import Link from 'next/link';
import AppShell from '@/components/nav/AppShell';
import { Activity, Building2, ShieldAlert, ShieldCheck } from 'lucide-react';
import PulseCard from './PulseCard';

export default function AdminIndex() {
  return (
    <AppShell title="Admin" icon={ShieldCheck}>
      <div className="flex-1 flex flex-col min-h-0 px-6 pt-5 pb-6 gap-4 overflow-y-auto">
        <div>
          <div className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            FleetCal admin
          </div>
          <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
            Cross-org tools. Only visible to users in the SUPER_ADMIN_USER_IDS allowlist.
          </div>
        </div>

        <PulseCard />

        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <AdminCard
            href="/admin/ai-usage"
            icon={<Activity size={20} style={{ color: '#1558d6' }} />}
            iconBg="#e8f0fe"
            title="AI Usage"
            description="Per-org Anthropic spend, calls, error rate, and recent failures." />
          <AdminCard
            href="/admin/health"
            icon={<ShieldAlert size={20} style={{ color: '#b06000' }} />}
            iconBg="#fef7e0"
            title="Operational health"
            description="Cron-job heartbeats, last-run status, and 24-hour failure counts." />
          <AdminCard
            href="/admin/orgs"
            icon={<Building2 size={20} style={{ color: '#6b21a8' }} />}
            iconBg="#f3e8fd"
            title="Orgs activity"
            description="Every Clerk org with 30-day load + revenue. Flags churn-risk." />
        </div>
      </div>
    </AppShell>
  );
}

function AdminCard({ href, icon, iconBg, title, description }: {
  href:        string;
  icon:        React.ReactNode;
  iconBg:      string;
  title:       string;
  description: string;
}) {
  return (
    <Link href={href}
      className="block rounded-xl transition-all relative overflow-hidden"
      style={{
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border-light)',
        boxShadow:  'var(--shadow-1)',
        padding:    '20px',
      }}>
      <div className="flex items-start gap-3">
        <span style={{
          width:        40,
          height:       40,
          borderRadius: 10,
          display:      'grid',
          placeItems:   'center',
          background:   iconBg,
          flex:         'none',
        }}>
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
            {title}
          </div>
          <div className="text-[12.5px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
            {description}
          </div>
        </div>
      </div>
    </Link>
  );
}
