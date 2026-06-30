import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ClerkProvider } from '@clerk/nextjs';
import { Plus_Jakarta_Sans, Figtree, Hanken_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { Analytics } from '@vercel/analytics/next';
import ThemeProvider from '@/components/ThemeProvider';
import { RailwayClientProvider } from '@/components/RailwayClientProvider';
import { clerkAppearance } from '@/lib/clerkAppearance';
import './globals.css';

const font = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

// Marketing landing fonts — `/`, `/pricing`. Dashboard pages keep
// Plus Jakarta Sans (via body fontFamily). The marketing pages opt in
// by setting `font-display`, `font-sys`, or `font-mono` on their root.
//
// Figtree (display / headings) + Hanken Grotesk (body) shifted from
// the prior DM Serif + DM Sans pair as part of the Google-Workspace
// look refresh — friendlier geometric sans pairing, closer to the
// Google Sans family the dashboard already evokes.
const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-figtree',
  weight:   ['400', '500', '600', '700', '800', '900'],
  display:  'swap',
});
const hanken = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-hanken',
  weight:   ['400', '500', '600', '700'],
  display:  'swap',
});
const ibmMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-ibm-mono',
  weight:   ['400', '500', '700'],
  display:  'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://fleetcal.app'),
  title: 'FleetCal',
  description: 'Dispatch calendar built by a carrier, for fleets. From load to invoice in one platform.',
  openGraph: {
    type: 'website',
    siteName: 'FleetCal',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'FleetCal: Every Load. One Calendar. Dispatch to invoice in one platform.' }],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/og-image.png'],
  },
};

const darkModeCSS = `
[data-theme="dark"] {
  --gc-blue:          #8ab4f8;
  --gc-blue-hover:    #aecbfa;
  --gc-blue-light:    #1e3a5f;
  --gc-blue-text:     #8ab4f8;
  --gc-red:           #f28b82;
  --gc-surface:       #1e1e1e;
  --gc-bg:            #121212;
  --gc-border:        #3c4043;
  --gc-border-light:  #2d2e30;
  --gc-text-1:        #e8eaed;
  --gc-text-2:        #bdc1c6;
  --gc-text-3:        #9aa0a6;
  --gc-hover:         rgba(232,234,237,0.08);
  --gc-hover-strong:  rgba(232,234,237,0.16);
  --shadow-1: 0 1px 2px rgba(0,0,0,.5), 0 1px 3px 1px rgba(0,0,0,.25);
  --shadow-2: 0 1px 2px rgba(0,0,0,.5), 0 2px 6px 2px rgba(0,0,0,.25);
  --shadow-3: 0 4px 8px 3px rgba(0,0,0,.25), 0 1px 3px rgba(0,0,0,.5);
  --gc-grid-line-color: #2d2e30;
  --gc-grid-line-half-color: #262728;
}
`;

/**
 * Resolved theme is read from a cookie set by the client whenever the
 * user changes their preference (see store/setTheme + ThemeProvider).
 * Server applies the value directly as `data-theme` on <html> so the
 * first paint already shows the right palette — no JSX <script> tag
 * needed, which means no React 19 warning, no FOUC.
 *
 * Cookie missing (first visit ever) falls back to 'light'. The
 * ThemeProvider client component will resolve the user's actual
 * preference (including 'system' → OS detection) on mount and update
 * the cookie for the next page load. The brief mis-paint on a first
 * visit by a dark-OS user is unavoidable without a blocking script;
 * any subsequent navigation reads the correct theme from the cookie.
 */
function readThemeCookie(value: string | undefined): 'light' | 'dark' {
  return value === 'dark' ? 'dark' : 'light';
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const theme = readThemeCookie(cookieStore.get('fleetcal-theme')?.value);

  return (
    <ClerkProvider appearance={clerkAppearance}>
      <html
        lang="en"
        data-theme={theme}
        className={`${font.variable} ${figtree.variable} ${hanken.variable} ${ibmMono.variable} h-full`}
        suppressHydrationWarning
      >
        <head>
          <style dangerouslySetInnerHTML={{ __html: darkModeCSS }} />
        </head>
        <body className="h-full overflow-hidden antialiased" style={{ fontFamily: 'var(--font-jakarta), sans-serif' }}>
          <ThemeProvider />
          <RailwayClientProvider>{children}</RailwayClientProvider>
          {/* Sonner — single global toaster. Imperatively triggered
              via `toast.success(...)` / `toast.error(...)` from
              anywhere in the tree. richColors=true uses our blue/green/
              red palette via Sonner's default; theme="light" forces
              light styling regardless of the dashboard's dark-mode
              setting because the dashboard toasts should be readable
              on top of the calendar's color blocks. */}
          <Toaster
            position="top-right"
            theme="light"
            richColors
            closeButton
            duration={5000}
            toastOptions={{
              style: {
                fontFamily: 'var(--font-jakarta), system-ui, sans-serif',
              },
            }}
          />
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
