'use client';

/**
 * Saved Locations directory body — placeholder for the 5th tab in
 * DirectoryModal. The locations management UI currently lives in
 * Settings → Saved Locations; lifting it into a directory-style
 * left-list/right-detail layout is a follow-up. For now the tab
 * deep-links to the settings panel so the entry point exists.
 */

import Link from 'next/link';
import { MapPin, ExternalLink } from 'lucide-react';

export default function SavedLocationsDirectoryBody() {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-4"
          style={{ background: 'var(--gc-blue-light)', color: 'var(--gc-blue)' }}>
          <MapPin size={20} />
        </div>
        <div className="text-base font-semibold mb-2" style={{ color: 'var(--gc-text-1)' }}>
          Saved locations
        </div>
        <p className="text-sm mb-5" style={{ color: 'var(--gc-text-2)' }}>
          Manage frequent pickup/delivery sites — Curzon yard, common shipper
          docks, etc. — in the dedicated directory view. The list itself lives
          in settings for now while the directory layout is being built.
        </p>
        <Link
          href="/settings#saved-locations"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          style={{ background: 'var(--gc-blue)', color: '#fff' }}>
          Open in settings <ExternalLink size={14} />
        </Link>
      </div>
    </div>
  );
}
