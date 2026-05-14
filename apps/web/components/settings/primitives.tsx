/**
 * Settings primitives — Google-style design system for /settings.
 *
 * Pulls every panel onto a consistent visual language:
 *   - White elevated cards on a light neutral page background
 *   - Bold near-black typography with clear hierarchy
 *   - Saturated Google-blue primary + bold semantic accents
 *   - Material-style switches and filled-button hovers
 *   - Generous rounded corners (16-24px) for the modern feel
 *
 * Use these instead of building local styled divs per panel — every
 * settings page should be assembled from these building blocks so the
 * look stays in lockstep when we tweak the system later.
 */

"use client";

import type { CSSProperties, ReactNode } from "react";
import { Loader2 } from "lucide-react";

// ── Design tokens ───────────────────────────────────────────────────────

/**
 * Hard-coded hex values so the settings page renders consistently
 * regardless of theme variables. We override the app-wide --gc-*
 * tokens here because the goal is a deliberate, branded look — not
 * "whatever the theme happens to be."
 */
export const SETTINGS_COLORS = {
  // Surfaces
  pageBg:        "#f8f9fa",            // page wrap — Google's neutral
  panelBg:       "#ffffff",            // white card
  sectionBandBg: "#f3f4f6",            // section header band

  // Borders
  border:        "#e5e7eb",            // subtle
  borderStrong:  "#d1d5db",            // dividers between rows

  // Text
  text:          "#111827",            // titles, labels, headings
  textBody:      "#374151",            // body copy
  textMuted:     "#6b7280",            // hints, helpers
  textPlaceholder: "#9ca3af",

  // Semantic
  blue:          "#1a73e8",            // primary
  blueHover:     "#1558d6",
  blueLight:     "#e8f0fe",
  blueText:      "#1d4ed8",
  green:         "#16a34a",
  greenDark:     "#15803d",
  greenLight:    "#dcfce7",
  red:           "#dc2626",
  redDark:       "#b91c1c",
  redLight:      "#fee2e2",
  yellow:        "#f59e0b",
  yellowDark:    "#d97706",
  yellowLight:   "#fef3c7",
} as const;

export const SETTINGS_SHADOW = {
  card:  "0 1px 2px 0 rgba(60,64,67,0.16), 0 1px 3px 1px rgba(60,64,67,0.10)",
  cardHover: "0 1px 3px 0 rgba(60,64,67,0.20), 0 4px 8px 3px rgba(60,64,67,0.10)",
  button: "0 1px 2px 0 rgba(60,64,67,0.16)",
} as const;

export const SETTINGS_RADIUS = {
  panel:  16,
  section: 12,
  control: 8,
  pill: 999,
} as const;

// ── Panel ───────────────────────────────────────────────────────────────

interface SettingsPanelProps {
  title:        string;
  description?: ReactNode;
  /** Right-aligned slot in the header — e.g. a Save button. */
  actions?:     ReactNode;
  children:     ReactNode;
  /** Override max width. Default is 960px which keeps line lengths sane. */
  maxWidth?:    number | string;
  /** Override the card chrome — useful when a child component (like
   *  Clerk's OrganizationProfile) brings its own panel. */
  bare?:        boolean;
}

/** Top-level panel wrapper. One per settings section. */
export function SettingsPanel({
  title, description, actions, children, maxWidth = 960, bare,
}: SettingsPanelProps) {
  return (
    <div style={{ maxWidth, width: "100%" }}>
      {/* Header lives OUTSIDE the card to feel like a page heading
          rather than a card title — matches Google's settings pages
          (Photos, Drive, etc.) */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] font-bold leading-tight" style={{ color: SETTINGS_COLORS.text, letterSpacing: "-0.01em" }}>
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 text-[14px] leading-relaxed max-w-2xl" style={{ color: SETTINGS_COLORS.textMuted }}>
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">
            {actions}
          </div>
        )}
      </div>

      {bare ? children : (
        <div style={{
          background:    SETTINGS_COLORS.panelBg,
          border:        `1px solid ${SETTINGS_COLORS.border}`,
          borderRadius:  SETTINGS_RADIUS.panel,
          boxShadow:     SETTINGS_SHADOW.card,
          overflow:      "hidden",
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Section ─────────────────────────────────────────────────────────────

interface SettingsSectionProps {
  title?:       string;
  description?: ReactNode;
  /** Right-aligned slot in the header. */
  actions?:     ReactNode;
  children:     ReactNode;
  /** When true, removes the dividing border above. Use for the FIRST
   *  section inside a panel where the panel chrome already provides
   *  the top edge. */
  first?:       boolean;
}

/** A logical grouping inside a panel (e.g. "Theme" within Appearance).
 *  All-white surface; sections separated by a thin top divider only,
 *  so the panel reads as one continuous card with bold inline headers
 *  rather than alternating gray bands. */
export function SettingsSection({
  title, description, actions, children, first,
}: SettingsSectionProps) {
  return (
    <div style={{
      borderTop: first ? "none" : `1px solid ${SETTINGS_COLORS.border}`,
      padding: "24px 28px",
    }}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            {title && (
              <div className="text-[12px] font-extrabold uppercase tracking-wider" style={{ color: SETTINGS_COLORS.text }}>
                {title}
              </div>
            )}
            {description && (
              <div className="mt-1.5 text-[13px]" style={{ color: SETTINGS_COLORS.textMuted }}>
                {description}
              </div>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Field ───────────────────────────────────────────────────────────────

interface SettingsFieldProps {
  label?:       ReactNode;
  /** Inline hint below the label. */
  hint?:        ReactNode;
  /** Inline help / status to the right of the control (sub-200 char). */
  trailing?:    ReactNode;
  children:     ReactNode;
  /** When true, places the control on the same row as the label
   *  (label | control). Default stacks label above control. */
  inline?:      boolean;
}

/** One labeled control row. Inline mode (label | control) is used
 *  for toggle rows and yes/no switches — stacked mode is for inputs
 *  and selects. Inline rows get a top divider when they're the 2nd+
 *  field in a section; suppress it on the first one via the
 *  group's first-of-type styling at the call site. We use plain
 *  CSS-in-JS so the divider is consistent without a wrapper. */
export function SettingsField({
  label, hint, trailing, children, inline,
}: SettingsFieldProps) {
  if (inline) {
    return (
      <div className="flex items-center justify-between gap-4 py-3.5 first:pt-0 first:border-t-0" style={{
        borderTop: `1px solid ${SETTINGS_COLORS.border}`,
      }}>
        <div className="flex-1 min-w-0">
          {label && (
            <div className="text-[14px] font-semibold" style={{ color: SETTINGS_COLORS.text }}>
              {label}
            </div>
          )}
          {hint && (
            <div className="mt-0.5 text-[12.5px]" style={{ color: SETTINGS_COLORS.textMuted }}>
              {hint}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {children}
          {trailing}
        </div>
      </div>
    );
  }
  return (
    <div className="mb-5">
      {label && (
        <label className="block text-[14px] font-semibold mb-1.5" style={{ color: SETTINGS_COLORS.text }}>
          {label}
        </label>
      )}
      {hint && (
        <div className="mb-2 text-[12.5px]" style={{ color: SETTINGS_COLORS.textMuted }}>
          {hint}
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">{children}</div>
        {trailing}
      </div>
    </div>
  );
}

// ── Toggle (Material-style switch) ──────────────────────────────────────

interface SettingsToggleProps {
  checked:    boolean;
  onChange:   (next: boolean) => void;
  disabled?:  boolean;
  label?:     string;
}

export function SettingsToggle({ checked, onChange, disabled, label }: SettingsToggleProps) {
  return (
    <button type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex items-center transition-colors"
      style={{
        width: 40, height: 22, borderRadius: SETTINGS_RADIUS.pill,
        background: checked ? SETTINGS_COLORS.blue : SETTINGS_COLORS.borderStrong,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background-color 140ms ease",
      }}
    >
      <span className="absolute"
        style={{
          width: 16, height: 16, borderRadius: "50%",
          background: "#fff",
          top: "50%", transform: `translate(${checked ? 21 : 3}px, -50%)`,
          boxShadow: "0 1px 2px rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.15)",
          transition: "transform 140ms ease",
        }}
      />
    </button>
  );
}

// ── Button ──────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

interface SettingsButtonProps {
  variant?:  ButtonVariant;
  onClick?:  () => void;
  disabled?: boolean;
  loading?:  boolean;
  type?:     "button" | "submit";
  /** Render as a tighter pill — for table action cells, etc. */
  size?:     "sm" | "md";
  children:  ReactNode;
  style?:    CSSProperties;
}

export function SettingsButton({
  variant = "primary", onClick, disabled, loading, type = "button", size = "md", children, style,
}: SettingsButtonProps) {
  const padding = size === "sm" ? "6px 12px" : "8px 16px";
  const fontSize = size === "sm" ? 12.5 : 13.5;

  const palette: Record<ButtonVariant, CSSProperties> = {
    primary: {
      background: SETTINGS_COLORS.blue,
      color: "#fff",
      border: "1px solid transparent",
      boxShadow: SETTINGS_SHADOW.button,
    },
    secondary: {
      background: SETTINGS_COLORS.panelBg,
      color: SETTINGS_COLORS.text,
      border: `1px solid ${SETTINGS_COLORS.borderStrong}`,
    },
    danger: {
      background: SETTINGS_COLORS.red,
      color: "#fff",
      border: "1px solid transparent",
      boxShadow: SETTINGS_SHADOW.button,
    },
    ghost: {
      background: "transparent",
      color: SETTINGS_COLORS.blueText,
      border: "1px solid transparent",
    },
  };

  const isDisabled = !!(disabled || loading);

  return (
    <button type={type}
      onClick={onClick}
      disabled={isDisabled}
      className="inline-flex items-center justify-center gap-1.5 font-semibold transition-all"
      style={{
        padding, fontSize, borderRadius: SETTINGS_RADIUS.control,
        cursor: isDisabled ? "default" : "pointer",
        opacity: isDisabled ? 0.55 : 1,
        ...palette[variant],
        ...style,
      }}
      onMouseEnter={(e) => {
        if (isDisabled) return;
        if (variant === "primary") e.currentTarget.style.background = SETTINGS_COLORS.blueHover;
        else if (variant === "danger") e.currentTarget.style.background = SETTINGS_COLORS.redDark;
        else if (variant === "secondary") e.currentTarget.style.background = SETTINGS_COLORS.sectionBandBg;
        else if (variant === "ghost") e.currentTarget.style.background = SETTINGS_COLORS.blueLight;
      }}
      onMouseLeave={(e) => {
        if (isDisabled) return;
        const p = palette[variant];
        e.currentTarget.style.background = (p.background as string) ?? "transparent";
      }}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

// ── Inputs ──────────────────────────────────────────────────────────────

export const SETTINGS_INPUT_STYLE: CSSProperties = {
  width:        "100%",
  padding:      "9px 12px",
  fontSize:     14,
  border:       `1px solid ${SETTINGS_COLORS.borderStrong}`,
  borderRadius: SETTINGS_RADIUS.control,
  background:   SETTINGS_COLORS.panelBg,
  color:        SETTINGS_COLORS.text,
  outline:      "none",
  transition:   "border-color 140ms, box-shadow 140ms",
};

/** Hook up via `onFocus={inputFocusBlue}` and `onBlur={inputBlurDefault}`
 *  on raw <input> elements for the consistent focus ring. */
export function inputFocusBlue(e: React.FocusEvent<HTMLElement>) {
  const t = e.currentTarget;
  t.style.borderColor = SETTINGS_COLORS.blue;
  t.style.boxShadow   = `0 0 0 3px ${SETTINGS_COLORS.blueLight}`;
}
export function inputBlurDefault(e: React.FocusEvent<HTMLElement>) {
  const t = e.currentTarget;
  t.style.borderColor = SETTINGS_COLORS.borderStrong;
  t.style.boxShadow   = "none";
}

interface SettingsInputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function SettingsInput(props: SettingsInputProps) {
  return (
    <input
      {...props}
      style={{ ...SETTINGS_INPUT_STYLE, ...props.style }}
      onFocus={(e) => { inputFocusBlue(e); props.onFocus?.(e); }}
      onBlur={(e) => { inputBlurDefault(e); props.onBlur?.(e); }}
    />
  );
}

interface SettingsSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export function SettingsSelect(props: SettingsSelectProps) {
  return (
    <select
      {...props}
      style={{ ...SETTINGS_INPUT_STYLE, cursor: "pointer", ...props.style }}
      onFocus={(e) => { inputFocusBlue(e); props.onFocus?.(e); }}
      onBlur={(e) => { inputBlurDefault(e); props.onBlur?.(e); }}
    >
      {props.children}
    </select>
  );
}

interface SettingsTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function SettingsTextarea(props: SettingsTextareaProps) {
  return (
    <textarea
      {...props}
      style={{
        ...SETTINGS_INPUT_STYLE,
        minHeight: 80,
        resize: "vertical",
        ...props.style,
      }}
      onFocus={(e) => { inputFocusBlue(e); props.onFocus?.(e); }}
      onBlur={(e) => { inputBlurDefault(e); props.onBlur?.(e); }}
    />
  );
}

// ── Subtle utility ──────────────────────────────────────────────────────

/** Small inline "X added · Y total" stat strip. */
export function SettingsCount({ children }: { children: ReactNode }) {
  return (
    <span className="text-[12.5px] font-medium" style={{ color: SETTINGS_COLORS.textMuted }}>
      {children}
    </span>
  );
}

interface ReadOnlyBannerProps {
  /** Override the default message. */
  message?: string;
}

/** Yellow banner shown above a panel's content when the active user
 *  lacks edit permission. Pairs with `<ReadOnlyWrap>` below which
 *  visually dims and disables pointer events on the underlying controls. */
export function ReadOnlyBanner({ message }: ReadOnlyBannerProps) {
  return (
    <div className="flex items-start gap-3 mb-4" style={{
      padding: "12px 16px",
      borderRadius: SETTINGS_RADIUS.section,
      border: `1px solid ${SETTINGS_COLORS.yellow}40`,
      background: SETTINGS_COLORS.yellowLight,
    }}>
      <span aria-hidden style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22, height: 22, borderRadius: 999,
        background: SETTINGS_COLORS.yellow,
        color: "#fff", fontSize: 14, fontWeight: 700, flexShrink: 0,
      }}>!</span>
      <div className="text-[13px]" style={{ color: SETTINGS_COLORS.text }}>
        <div className="font-bold">Read-only</div>
        <div className="mt-0.5" style={{ color: SETTINGS_COLORS.textBody }}>
          {message ?? "Contact your org Admin or Owner to change these settings."}
        </div>
      </div>
    </div>
  );
}

/** Wraps panel content and visually disables it when `disabled` is
 *  true. Renders children with reduced opacity and blocks pointer
 *  events so clicks pass through to nothing. Form inputs inside still
 *  read fine; users just can't interact. */
export function ReadOnlyWrap({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  if (!disabled) return <>{children}</>;
  return (
    <div style={{
      opacity: 0.65,
      pointerEvents: "none",
      userSelect: "none",
    }} aria-disabled>
      {children}
    </div>
  );
}
