/**
 * Marketing-flavored Clerk appearance.
 *
 * Used on auth-funnel pages — /sign-in, /sign-up, /create-organization —
 * where Clerk's form needs to match the Google Workspace marketing
 * aesthetic (Figtree + Hanken, pill buttons, rounded-2xl cards, soft
 * Material elevation). Keeps `clerkAppearance.ts` strictly for in-app
 * surfaces (UserButton popover, OrganizationSwitcher dropdown) where
 * Plus Jakarta Sans + 8px radius matches the surrounding dashboard.
 *
 * Apply via per-component prop:
 *
 *   <SignIn appearance={clerkAppearanceMarketing} />
 *
 * NOT via ClerkProvider — overriding the provider would change every
 * UserButton in the dashboard too, which we don't want.
 */
import type { Appearance } from '@clerk/types';

export const clerkAppearanceMarketing: Appearance = {
  variables: {
    colorPrimary:          'var(--gc-blue)',
    colorText:             '#202124',
    colorTextSecondary:    '#5f6368',
    colorBackground:       '#ffffff',
    colorInputBackground:  '#ffffff',
    colorInputText:        '#202124',
    colorDanger:           '#ea4335',

    // Bigger radius than the dashboard's 8px — matches the marketing
    // landing's 14–24px card / 9999px pill rhythm.
    borderRadius: '14px',

    // Hanken Grotesk for body / form fields (Figtree is reserved for
    // headings, set per-element below).
    fontFamily: 'var(--font-hanken), system-ui, sans-serif',
    fontSize:   '15px',
  },

  layout: {
    socialButtonsPlacement: 'top',
    showOptionalFields:     true,
    helpPageUrl:    '',
    privacyPageUrl: '',
    termsPageUrl:   '',
  },

  elements: {
    // ── Container ───────────────────────────────────────────────────
    rootBox: 'w-full',
    cardBox: 'w-full shadow-none',
    // Card chrome — soft elevation, generous radius, white bg.
    card: 'border border-[#e8eaed] bg-white',

    // ── Header ──────────────────────────────────────────────────────
    header:         'mb-7',
    headerTitle:    'font-display font-extrabold tracking-tight text-[26px] text-[#202124]',
    headerSubtitle: 'text-[14px] text-[#5f6368]',

    // ── OAuth (Google) ──────────────────────────────────────────────
    socialButtonsBlockButton:
      'border border-[#dadce0] hover:bg-[#f8f9fa] hover:shadow-[var(--shadow-1)] transition-all font-display font-semibold',
    socialButtonsBlockButtonText: 'font-display font-semibold text-[15px] text-[#202124]',

    // ── Divider (OR) ────────────────────────────────────────────────
    dividerLine: 'bg-[#e8eaed]',
    dividerText: 'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5f6368]',

    // ── Form fields ─────────────────────────────────────────────────
    formFieldLabel:
      'font-display text-[13px] font-semibold text-[#3c4043]',
    formFieldInput:
      'border border-[#dadce0] focus:border-[var(--gc-blue)] focus:outline-none focus:ring-2 focus:ring-[var(--gc-blue-light)] transition-colors',
    formFieldErrorText:   'text-[12px] text-[#ea4335]',
    formFieldSuccessText: 'text-[12px] text-[#1e8e3e]',

    // ── Primary CTA ─────────────────────────────────────────────────
    // Pill button matching marketing buttons exactly — full radius,
    // font-display semibold, soft elevation + hover bump.
    formButtonPrimary:
      'bg-[var(--gc-blue)] hover:bg-[var(--gc-blue-hover)] font-display font-semibold text-white shadow-[var(--shadow-1)] hover:shadow-[var(--shadow-2)] transition-all !rounded-full',

    // ── Footer / sub-links ──────────────────────────────────────────
    footerAction:     'font-display text-[13px]',
    footerActionLink: 'text-[#1967d2] font-display font-semibold hover:underline',

    // ── Hide Clerk chrome ───────────────────────────────────────────
    footer:             'hidden',
    badge:              'hidden',
    poweredByClerkText: 'hidden',
    logoBox:            'hidden',

    // ── OTP ─────────────────────────────────────────────────────────
    otpCodeFieldInput:
      'border border-[#dadce0] focus:border-[var(--gc-blue)] focus:ring-2 focus:ring-[var(--gc-blue-light)]',

    // ── In-flow Create Organization (rendered inside <SignUp /> AND
    //    standalone via /create-organization) ───────────────────────
    organizationSwitcherTrigger: 'rounded-full',
    organizationPreviewMainIdentifier:      'font-display text-[14px] font-medium',
    organizationPreviewSecondaryIdentifier: 'text-[12px] text-[#5f6368]',
  },
};
