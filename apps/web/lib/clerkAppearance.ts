/**
 * Shared Clerk appearance config.
 *
 * Applied globally via <ClerkProvider appearance={clerkAppearance}> in
 * app/layout.tsx, so every Clerk component (SignUp, SignIn,
 * CreateOrganization, OrganizationProfile, OrganizationSwitcher,
 * UserButton, PricingTable) picks up the same FleetCal/Google-style
 * look without per-call overrides.
 *
 * The marketing landing (`/`, `/pricing`) uses a separate Systematica
 * style — those pages render OUR components, not Clerk's, so this
 * config doesn't touch them.
 *
 * If you want one-off overrides on a specific component (e.g. larger
 * headers on /sign-up), spread `clerkAppearance` into the prop and
 * extend it locally:
 *
 *   <SignUp appearance={{
 *     ...clerkAppearance,
 *     elements: { ...clerkAppearance.elements, headerTitle: '...' },
 *   }} />
 */
import type { Appearance } from '@clerk/types';

export const clerkAppearance: Appearance = {
  variables: {
    // Brand color — primary buttons, focus rings, links.
    colorPrimary:    'var(--gc-blue)',

    // Text + surface tokens. Resolved by globals.css; flips per
    // data-theme so Clerk follows the dashboard's light/dark.
    colorText:            'var(--gc-text-1)',
    colorTextSecondary:   'var(--gc-text-2)',
    colorBackground:      'var(--gc-bg)',
    colorInputBackground: 'var(--gc-surface)',
    colorInputText:       'var(--gc-text-1)',
    colorDanger:          'var(--gc-red)',

    // Global border radius — matches the dashboard's rounded-lg.
    borderRadius: '8px',

    // Plus Jakarta Sans throughout — same family the dashboard uses.
    fontFamily: 'var(--font-jakarta), system-ui, sans-serif',
    fontSize:   '14px',
  },

  layout: {
    socialButtonsPlacement: 'top',
    showOptionalFields:     true,
    // Hide the "Secured by Clerk" footer badge globally. Note: some
    // Clerk plans require the badge to remain visible per TOS — verify
    // your plan's policy before relying on this in production.
    helpPageUrl:    '',
    privacyPageUrl: '',
    termsPageUrl:   '',
  },

  elements: {
    // ── Cards / containers ────────────────────────────────────────
    rootBox: 'w-full',
    cardBox: 'w-full shadow-none',
    // Card chrome: thin border, no shadow — matches the dashboard's
    // panel look. Clerk applies its own padding inside.
    card: 'shadow-none border border-[var(--gc-border-light)] bg-[var(--gc-bg)]',

    // ── Header ────────────────────────────────────────────────────
    header:         'mb-6',
    headerTitle:    'font-semibold tracking-tight text-[20px] text-[var(--gc-text-1)]',
    headerSubtitle: 'text-[13px] text-[var(--gc-text-2)]',

    // ── OAuth (Sign in with Google / etc.) ────────────────────────
    socialButtonsBlockButton:
      'border border-[var(--gc-border)] hover:bg-[var(--gc-hover)] transition-colors font-medium',
    socialButtonsBlockButtonText: 'font-medium text-[14px] text-[var(--gc-text-1)]',

    // ── Divider (OR) ──────────────────────────────────────────────
    dividerLine: 'bg-[var(--gc-border-light)]',
    dividerText: 'text-[12px] font-medium uppercase tracking-wider text-[var(--gc-text-3)]',

    // ── Form fields ───────────────────────────────────────────────
    formFieldLabel: 'text-[13px] font-medium text-[var(--gc-text-2)]',
    formFieldInput:
      'border border-[var(--gc-border)] focus:border-[var(--gc-blue)] focus:outline-none focus:ring-1 focus:ring-[var(--gc-blue)] transition-colors',
    formFieldErrorText: 'text-[12px] text-[var(--gc-red)]',
    formFieldSuccessText: 'text-[12px] text-[var(--gc-green)]',

    // ── Primary CTA ───────────────────────────────────────────────
    formButtonPrimary:
      'bg-[var(--gc-blue)] hover:bg-[var(--gc-blue-hover)] font-semibold text-white shadow-sm transition-colors',

    // ── Footer links ("Already have an account?") ─────────────────
    footerAction:     'text-[13px]',
    footerActionLink: 'text-[var(--gc-blue)] font-semibold hover:underline',

    // ── Hide Clerk branding ───────────────────────────────────────
    // The whole footer block. Removes "Secured by Clerk" / dev-mode
    // badges that otherwise stamp onto every form.
    footer:                'hidden',
    badge:                 'hidden',
    poweredByClerkText:    'hidden',
    logoBox:               'hidden',

    // ── OTP / verification code inputs ────────────────────────────
    otpCodeFieldInput:
      'border border-[var(--gc-border)] focus:border-[var(--gc-blue)] focus:ring-1 focus:ring-[var(--gc-blue)]',

    // ── Modal / popover surfaces ──────────────────────────────────
    modalContent:                  'shadow-2xl',
    modalCloseButton:              'hover:bg-[var(--gc-hover)]',

    // ── UserButton popover ────────────────────────────────────────
    userButtonAvatarBox:           'rounded-full',
    userButtonPopoverCard:         'shadow-xl border border-[var(--gc-border-light)]',
    userButtonPopoverActionButton: 'hover:bg-[var(--gc-hover)] text-[var(--gc-text-1)]',
    userButtonPopoverFooter:       'hidden',

    // ── OrganizationSwitcher popover ──────────────────────────────
    organizationSwitcherTrigger:
      'hover:bg-[var(--gc-hover)] transition-colors px-2 py-1',
    organizationSwitcherPopoverCard:
      'shadow-xl border border-[var(--gc-border-light)]',
    organizationSwitcherPopoverActionButton:
      'hover:bg-[var(--gc-hover)] text-[var(--gc-text-1)]',
    organizationPreviewMainIdentifier: 'text-[14px] font-medium',
    organizationPreviewSecondaryIdentifier: 'text-[12px] text-[var(--gc-text-3)]',

    // ── OrganizationProfile (settings → Members & Roles) ──────────
    navbar:         'bg-[var(--gc-surface)] border-r border-[var(--gc-border-light)]',
    navbarButton:
      'hover:bg-[var(--gc-hover)] text-[var(--gc-text-2)] data-[active=true]:bg-[var(--gc-blue-light)] data-[active=true]:text-[var(--gc-blue)]',
    profileSection:  'border-b border-[var(--gc-border-light)]',
    profileSectionTitle: 'font-semibold text-[14px] text-[var(--gc-text-1)]',
    profileSectionContent: 'text-[13px] text-[var(--gc-text-2)]',

    // ── PricingTable (Clerk's billing UI on /onboarding/pick-plan) ──
    // Most PricingTable element keys are still maturing in Clerk's API.
    // What's exposed today gets the same hairline-bordered card look.
    pricingTableCard:
      'border border-[var(--gc-border-light)] bg-[var(--gc-bg)] shadow-sm',
  },
};
