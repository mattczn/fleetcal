import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Plus_Jakarta_Sans } from 'next/font/google';
import ThemeProvider from '@/components/ThemeProvider';
import { RailwayClientProvider } from '@/components/RailwayClientProvider';
import './globals.css';

const font = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FleetCal',
  description: 'Fleet dispatch scheduling',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${font.variable} h-full`} suppressHydrationWarning>
        <head>
          {/* Theme init runs synchronously before paint to set
              data-theme on <html> from the user's saved preference.
              Loaded from a static file rather than inlined into the
              React tree — React 19 warns about inline <script>
              elements because they don't re-execute on client
              re-render. External script refs sidestep the warning
              and still block paint until evaluated (no async/defer). */}
          <script src="/theme-init.js" />
          <style dangerouslySetInnerHTML={{ __html: darkModeCSS }} />
        </head>
        <body className="h-full overflow-hidden antialiased" style={{ fontFamily: 'var(--font-jakarta), sans-serif' }}>
          <ThemeProvider />
          <RailwayClientProvider>{children}</RailwayClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
