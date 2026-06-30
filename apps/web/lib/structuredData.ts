/**
 * schema.org structured data (JSON-LD) for the marketing site, rendered
 * via <JsonLd data={...} />.
 *
 * Prices mirror PricingCards (Owner Op $99 / Growth $149 / Fleet $199
 * monthly) as an AggregateOffer (low 99 / high 199). Update both together
 * if the plans change.
 */

export const SITE_URL = 'https://fleetcal.app';

const ORG_ID = `${SITE_URL}/#organization`;

const OFFERS = {
  '@type': 'AggregateOffer',
  priceCurrency: 'USD',
  lowPrice: '99',
  highPrice: '199',
  offerCount: 3,
};

export const organizationLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': ORG_ID,
  name: 'FleetCal',
  url: SITE_URL,
  logo: `${SITE_URL}/logo-square.png`,
  description:
    'Dispatch calendar built by a carrier, for fleets. From load to invoice in one platform.',
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    email: 'hello@fleetcal.app',
    url: `${SITE_URL}/support`,
  },
};

export const websiteLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${SITE_URL}/#website`,
  name: 'FleetCal',
  url: SITE_URL,
  publisher: { '@id': ORG_ID },
};

export const fleetcalAppLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'FleetCal',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web, iOS, Android',
  url: SITE_URL,
  description:
    'See every truck and load on one calendar. FleetCal takes you from load to invoice in one system, built by a 14-truck carrier.',
  publisher: { '@id': ORG_ID },
  offers: OFFERS,
};

export function faqPageLd(faqs: ReadonlyArray<{ q: string; a: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

function breadcrumbLd(items: ReadonlyArray<{ name: string; url: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

const PRODUCTS = {
  calendar: {
    label: 'Dispatch Calendar',
    name: 'FleetCal Dispatch Calendar',
    operatingSystem: 'Web',
    description:
      'Drop a rate con, drag it to a truck, dispatch in seconds. One column per truck on a live dispatch calendar.',
  },
  'driver-app': {
    label: 'Driver App',
    name: 'FleetCal Driver App',
    operatingSystem: 'iOS, Android',
    description:
      "Loads, navigation, and POD scanning in the driver's pocket. Syncs live to the dispatch calendar. iOS and Android.",
  },
  paperwork: {
    label: 'Paperwork Verification',
    name: 'FleetCal Paperwork Verification',
    operatingSystem: 'Web',
    description:
      "Verify PODs against the rate con side by side, flag what's missing, release clean loads for billing.",
  },
  billing: {
    label: 'Billing',
    name: 'FleetCal Billing',
    operatingSystem: 'Web',
    description:
      "Batch a week of invoices in one pass. AI reads each customer's billing instructions so you get paid clean.",
  },
  payroll: {
    label: 'Payroll',
    name: 'FleetCal Payroll',
    operatingSystem: 'Web',
    description:
      'Driver pay calculates itself from delivered loads. Adjust, defer, and finalize payroll in minutes.',
  },
  dashboard: {
    label: 'Dashboard',
    name: 'FleetCal Dashboard',
    operatingSystem: 'Web',
    description:
      "Revenue by truck, customer, and lane, updated live. Know exactly what's making money.",
  },
} as const;

export type ProductSlug = keyof typeof PRODUCTS;

export function productJsonLd(slug: ProductSlug) {
  const p = PRODUCTS[slug];
  const url = `${SITE_URL}/product/${slug}`;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: p.name,
      applicationCategory: 'BusinessApplication',
      operatingSystem: p.operatingSystem,
      url,
      description: p.description,
      publisher: { '@id': ORG_ID },
      offers: OFFERS,
    },
    breadcrumbLd([
      { name: 'Home', url: SITE_URL },
      { name: p.label, url },
    ]),
  ];
}
