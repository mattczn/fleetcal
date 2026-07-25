'use client';

/**
 * Meta (Facebook) Pixel — id 4624566077821102.
 *
 * Loaded site-wide from the root layout. The init snippet fires the first
 * PageView on load; because Next.js App Router navigations are client-side
 * (no full reload), the standard pixel would never re-fire, so we mirror
 * each route change with an explicit PageView — skipping the initial mount
 * so the landing hit isn't double-counted.
 *
 * next/script (afterInteractive) is used instead of a raw <script> tag so
 * Next controls injection/ordering reliably. No CSP is set on this app
 * (see next.config.ts), so connect.facebook.net / facebook.com load freely.
 */

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

const PIXEL_ID = '4624566077821102';

export default function MetaPixel() {
  const pathname = usePathname();
  const firstLoad = useRef(true);

  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false; // init snippet already fired this PageView
      return;
    }
    window.fbq?.('track', 'PageView');
  }, [pathname]);

  return (
    <>
      <Script id="meta-pixel" strategy="afterInteractive">
        {`!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${PIXEL_ID}');
fbq('track', 'PageView');`}
      </Script>
      <noscript>
        <img
          height="1"
          width="1"
          style={{ display: 'none' }}
          src={`https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1`}
          alt=""
        />
      </noscript>
    </>
  );
}
