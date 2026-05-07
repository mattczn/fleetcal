import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Dimensions, TextInput, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useOrganization, useAuth } from "@clerk/clerk-expo";
import * as Clipboard from "expo-clipboard";
import {
  ArrowLeft, Truck, Building2, Clock, MapPin, User, Box, DollarSign, Hash,
  Briefcase, Info, ChevronDown, ChevronUp, ChevronRight, CircleDot, Copy, Check,
  Repeat2, HandCoins, CheckCircle2, Route, Pencil, Lock, Trash2, Plus, Split,
} from "lucide-react-native";
import { fetchLoad, updateLoadStatus, updateLoadTrailer, updateLoadFields, fetchAssets, fetchDrivers, fetchDriverAssetPrefs, fetchCustomers, displayBrokerName, saveStops, splitIntoRelay, removeRelay, softDeleteLoad } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { fetchMotiveLocations, distanceMiles, type MotiveLocation } from "@/lib/motive";
import { calcRoadMiles } from "@/lib/directions";
import { env } from "@/lib/env";
import { RouteMap } from "@/components/RouteMap";
import { DocumentsView } from "@/components/DocumentsView";
import { StatusPickerSheet } from "@/components/StatusPickerSheet";
import { TrailerPickerSheet } from "@/components/TrailerPickerSheet";
import { EditFieldSheet, type EditFieldKind } from "@/components/EditFieldSheet";
import { AssetPickerSheet } from "@/components/AssetPickerSheet";
import { DriverPickerSheet } from "@/components/DriverPickerSheet";
import { DateTimePickerSheet } from "@/components/DateTimePickerSheet";
import { BrokerEditSheet } from "@/components/BrokerEditSheet";
import { StopEditSheet } from "@/components/StopEditSheet";
import { RelaySplitSheet } from "@/components/RelaySplitSheet";
import { EditableStopCard } from "@/components/EditableStopCard";
import { AccessorialSheet } from "@/components/AccessorialSheet";
import { Toast } from "@/components/Toast";
import type { Accessorial, Load, LoadStatus, Stop, StopType } from "@/lib/types";
import { txt } from "@/lib/font";

const STOP_TINT: Record<StopType, { bg: string; fg: string; mark: string; label: string }> = {
  pickup:    { bg: "#dcfce7", fg: "#15803d", mark: "#16a34a", label: "Pickup" },
  delivery:  { bg: "#fee2e2", fg: "#b91c1c", mark: "#dc2626", label: "Delivery" },
  drop:      { bg: "#cffafe", fg: "#0e7490", mark: "#0891b2", label: "Drop Trailer" },
  drop_hook: { bg: "#dbeafe", fg: "#1e40af", mark: "#2563eb", label: "Drop & Hook" },
  stop:      { bg: "#fef9c3", fg: "#854d0e", mark: "#eab308", label: "Stop" },
  relay:     { bg: "#f3e8fd", fg: "#6b21a8", mark: "#8b5cf6", label: "Relay" },
};

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const t = iso.slice(11, 16);
  if (!t) return "—";
  const [h, m] = t.split(":");
  const hh = parseInt(h, 10);
  const ampm = hh >= 12 ? "PM" : "AM";
  return `${hh % 12 || 12}:${m} ${ampm}`;
}
function fmtFullDateTime(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Inline components ─────────────────────────────────────────────────────────

/**
 * Non-editable multiline TextInput — gives native long-press selection / copy
 * handles, which RN's <Text selectable> doesn't fully support on iOS.
 */
function SelectableText({ value, style }: { value: string; style: object }) {
  return (
    <TextInput
      value={value}
      editable={false}
      multiline
      scrollEnabled={false}
      style={[{ padding: 0, margin: 0, includeFontPadding: false } as object, style]}
    />
  );
}

function TimeAnchor({ kind, iso }: { kind: "start" | "end"; iso?: string }) {
  const label = kind === "start" ? "START TIME" : "END TIME";
  const tint  = { bg: "#e8f0fe", fg: "#1558d6", iconBg: "#1a73e8" };
  let display = "—";
  if (iso) {
    const d = new Date(iso.replace(" ", "T"));
    if (!isNaN(d.getTime())) {
      display = d.toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    }
  }
  return (
    <View
      style={{
        backgroundColor: "#ffffff",
        borderRadius:    14,
        marginBottom:    10,
        padding:         14,
        borderWidth:     1,
        borderColor:     "#e8eaed",
        flexDirection:   "row",
        alignItems:      "center",
        gap:             12,
      }}
    >
      <View
        style={{
          width: 40, height: 40, borderRadius: 12,
          backgroundColor: tint.iconBg,
          alignItems: "center", justifyContent: "center",
        }}
      >
        <Clock size={18} color="#ffffff" strokeWidth={2.4} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tint.bg, marginBottom: 4 }}>
          <Text style={[txt(800), { fontSize: 10, color: tint.fg, letterSpacing: 0.5 }]}>
            {label}
          </Text>
        </View>
        <Text style={[txt(800), { fontSize: 15, color: "#202124" }]} numberOfLines={1}>
          {display}
        </Text>
      </View>
    </View>
  );
}

/**
 * Tappable note chip. Collapsed shows one line + chevron — tap anywhere to
 * expand. Expanded shows the full text inside a SelectableText so the user can
 * long-press to highlight and copy. Tap the chevron to collapse again.
 */
function ExpandableNote({ text, tint }: { text: string; tint: { bg: string; fg: string } }) {
  const [open, setOpen] = useState(false);
  const couldOverflow = text.length > 50 || text.includes("\n");

  if (!open) {
    return (
      <TouchableOpacity
        activeOpacity={couldOverflow ? 0.7 : 1}
        onPress={() => couldOverflow && setOpen(true)}
        style={{
          flexDirection: "row", alignItems: "center", gap: 8,
          backgroundColor: tint.bg, borderRadius: 8,
          paddingHorizontal: 10, paddingVertical: 8, marginTop: 8,
        }}
      >
        <Info size={13} color={tint.fg} strokeWidth={2.4} />
        <Text
          style={[txt(600), { fontSize: 12, color: tint.fg, flex: 1, lineHeight: 17 }]}
          numberOfLines={1}
        >
          {text}
        </Text>
        {couldOverflow ? <ChevronDown size={14} color={tint.fg} strokeWidth={2.4} /> : null}
      </TouchableOpacity>
    );
  }

  return (
    <View style={{
      flexDirection: "row", alignItems: "flex-start", gap: 8,
      backgroundColor: tint.bg, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 8, marginTop: 8,
    }}>
      <Info size={13} color={tint.fg} strokeWidth={2.4} style={{ marginTop: 2 }} />
      <SelectableText
        value={text}
        style={{ ...txt(600), fontSize: 12, color: tint.fg, flex: 1, lineHeight: 17 }}
      />
      <TouchableOpacity
        onPress={() => setOpen(false)}
        hitSlop={10}
        style={{ paddingTop: 2, paddingLeft: 2 }}
      >
        <ChevronUp size={14} color={tint.fg} strokeWidth={2.4} />
      </TouchableOpacity>
    </View>
  );
}

function MetaRow({
  Icon, label, value, color = "#202124", last,
}: {
  Icon: typeof Truck; label: string; value: string; color?: string; last?: boolean;
}) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center",
      paddingVertical: 11,
      borderBottomWidth: last ? 0 : 1, borderBottomColor: "#f1f3f4",
    }}>
      <Icon size={15} color="#5f6368" strokeWidth={2} />
      <Text style={[txt(600), { fontSize: 13, color: "#5f6368", marginLeft: 10, flex: 1 }]}>
        {label}
      </Text>
      <Text style={[txt(700), { fontSize: 14, color, maxWidth: "60%", textAlign: "right" }]}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Row that switches between read-only display and a tappable edit affordance
 * based on `editing`. Tap fires `onEdit` (which opens the per-field sheet).
 * Adds a pencil icon when editable so the user knows the field is interactive.
 */
function EditableRow({
  Icon, label, value, color = "#202124", last, editing, modified, onEdit, placeholder = "—",
}: {
  Icon: typeof Truck;
  label: string;
  value: string | null | undefined;
  color?: string;
  last?: boolean;
  editing: boolean;
  modified?: boolean;
  onEdit: () => void;
  placeholder?: string;
}) {
  const display = value && value.trim() ? value : placeholder;
  if (!editing) {
    return <MetaRow Icon={Icon} label={label} value={display} color={color} last={last} />;
  }
  const valueColor = modified
    ? "#1a73e8"
    : value && value.trim() ? color : "#9aa0a6";
  return (
    <TouchableOpacity
      onPress={onEdit}
      activeOpacity={0.7}
      style={{
        flexDirection: "row", alignItems: "center",
        paddingVertical: 11,
        borderBottomWidth: last ? 0 : 1, borderBottomColor: "#f1f3f4",
      }}
    >
      <Icon size={15} color="#5f6368" strokeWidth={2} />
      <Text style={[txt(600), { fontSize: 13, color: "#5f6368", marginLeft: 10, flex: 1 }]}>
        {label}
      </Text>
      <Text
        style={[
          txt(modified ? 800 : 700),
          {
            fontSize: 14,
            color: valueColor,
            maxWidth: "55%",
            textAlign: "right",
            marginRight: 8,
          },
        ]}
        numberOfLines={1}
      >
        {display}
      </Text>
      <Pencil size={13} color={modified ? "#1a73e8" : "#9aa0a6"} strokeWidth={2.4} />
    </TouchableOpacity>
  );
}

function CopyMetaRow({
  Icon, label, value, last, onCopied,
}: {
  Icon: typeof Truck; label: string; value: string; last?: boolean; onCopied: (msg: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await Clipboard.setStringAsync(value);
    setCopied(true);
    onCopied(`${label} copied`);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <TouchableOpacity
      onPress={copy}
      activeOpacity={0.7}
      style={{
        flexDirection: "row", alignItems: "center",
        paddingVertical: 11,
        borderBottomWidth: last ? 0 : 1, borderBottomColor: "#f1f3f4",
      }}
    >
      <Icon size={15} color="#5f6368" strokeWidth={2} />
      <Text style={[txt(600), { fontSize: 13, color: "#5f6368", marginLeft: 10, flex: 1 }]}>
        {label}
      </Text>
      <Text style={[txt(700), { fontSize: 14, color: "#202124", marginRight: 10 }]} numberOfLines={1}>
        {value}
      </Text>
      <View style={{
        width: 26, height: 26, borderRadius: 8,
        backgroundColor: copied ? "#dcfce7" : "#f1f3f4",
        alignItems: "center", justifyContent: "center",
      }}>
        {copied
          ? <Check size={12} color="#15803d" strokeWidth={2.6} />
          : <Copy  size={12} color="#5f6368" strokeWidth={2.2} />}
      </View>
    </TouchableOpacity>
  );
}

function LinkMetaRow({
  Icon, label, value, last, onPress,
}: {
  Icon: typeof Truck; label: string; value: string; last?: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: "row", alignItems: "center",
        paddingVertical: 11,
        borderBottomWidth: last ? 0 : 1, borderBottomColor: "#f1f3f4",
      }}
    >
      <Icon size={15} color="#5f6368" strokeWidth={2} />
      <Text style={[txt(600), { fontSize: 13, color: "#5f6368", marginLeft: 10, flex: 1 }]}>
        {label}
      </Text>
      <Text style={[txt(700), { fontSize: 14, color: "#1a73e8", marginRight: 4 }]} numberOfLines={1}>
        {value}
      </Text>
      <ChevronRight size={14} color="#9aa0a6" strokeWidth={2.2} />
    </TouchableOpacity>
  );
}

const ACCESSORIAL_CATEGORY_LABEL: Record<string, string> = {
  detention:    "Detention",
  lumper:       "Lumper",
  layover:      "Layover",
  scale_ticket: "Scale Ticket",
  other:        "Other",
};

const ACCESSORIAL_STATUS_TINT: Record<string, { bg: string; fg: string }> = {
  requested: { bg: "#fef3c7", fg: "#92400e" },
  approved:  { bg: "#e6f4ea", fg: "#15803d" },
  denied:    { bg: "#fce8e6", fg: "#b91c1c" },
};

function AccessorialCard({
  acc, onEdit,
}: {
  acc:    Accessorial;
  onEdit: () => void;
}) {
  const label = ACCESSORIAL_CATEGORY_LABEL[acc.category] ?? "Accessorial";
  const statusTint = acc.status ? ACCESSORIAL_STATUS_TINT[acc.status] : null;
  const inner = (
    <View style={{
      backgroundColor: "#ffffff",
      borderRadius: 12,
      borderWidth: 1, borderColor: "#e8eaed",
      padding: 12,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[txt(800), { fontSize: 13, color: "#202124", flex: 1 }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[txt(800), { fontSize: 14, color: "#15803d" }]}>
          {fmtMoney(acc.amount ?? 0)}
        </Text>
        <Pencil size={13} color="#9aa0a6" strokeWidth={2.2} />
      </View>
      {acc.description ? (
        <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 3 }]} numberOfLines={2}>
          {acc.description}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {acc.billable ? (
          <View style={{
            paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999,
            backgroundColor: "#e8f0fe",
          }}>
            <Text style={[txt(800), { fontSize: 9, color: "#1558d6", letterSpacing: 0.3 }]}>
              BILLABLE
            </Text>
          </View>
        ) : (
          <View style={{
            paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999,
            backgroundColor: "#f1f3f4",
          }}>
            <Text style={[txt(800), { fontSize: 9, color: "#5f6368", letterSpacing: 0.3 }]}>
              NOT BILLABLE
            </Text>
          </View>
        )}
        {acc.payToDriver ? (
          <View style={{
            paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999,
            backgroundColor: "#e6f4ea",
          }}>
            <Text style={[txt(800), { fontSize: 9, color: "#15803d", letterSpacing: 0.3 }]}>
              PAY DRIVER{acc.payDriverName ? ` · ${acc.payDriverName.toUpperCase()}` : ""}
            </Text>
          </View>
        ) : null}
        {statusTint ? (
          <View style={{
            paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999,
            backgroundColor: statusTint.bg,
          }}>
            <Text style={[txt(800), { fontSize: 9, color: statusTint.fg, letterSpacing: 0.3 }]}>
              {(acc.status ?? "").toUpperCase()}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
  return (
    <TouchableOpacity onPress={onEdit} activeOpacity={0.7}>
      {inner}
    </TouchableOpacity>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text style={[txt(800), { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", marginTop: 18, marginBottom: 10, textTransform: "uppercase" }]}>
      {children}
    </Text>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View style={{
      backgroundColor: "#ffffff", borderRadius: 14, paddingHorizontal: 14,
      borderWidth: 1, borderColor: "#e8eaed",
    }}>
      {children}
    </View>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

interface StopsTabProps {
  load:        Load;
  width:       number;
  truckLoc?:   MotiveLocation | null;
  /** Asset color used to tint the live truck pin on the route map. */
  assetColor?: string | null;
  onCopied:    (msg: string) => void;
  editMode:    boolean;
  draftStops?: Stop[]; // when editing, rendered list comes from draft
  dirty:       boolean;
  isSaving:    boolean;
  onMoveStop:  (idx: number, dir: -1 | 1) => void;
  onDeleteStop:(idx: number) => void;
  onTapStop:   (idx: number) => void;
  onAddStop:   () => void;
  onSplitRelay:() => void;
  canSplitRelay: boolean;
  onRemoveRelay?: () => void;       // shown only when this is a relay leg
  removingRelay?: boolean;
  onOpenPartner?: () => void;
  onCancelEdit: () => void;
  onSaveEdit:   () => void;
}

/**
 * Individual stop card. Shows:
 *  - colored numbered pill, type badge, facility, address
 *  - copy-address button in the top-right
 *  - appointment window
 *  - distance from the truck (if Motive location is available)
 *  - selectable instructions (long-press to copy)
 */
function StopCard({
  s, index, truckLoc, onCopied,
}: { s: Stop; index: number; truckLoc?: MotiveLocation | null; onCopied: (msg: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [showCheckIn, setShowCheckIn] = useState(false);
  const [eta, setEta] = useState<{ duration: string; arrival: string } | null>(null);
  const [etaLoading, setEtaLoading] = useState(false);
  const tint = STOP_TINT[s.type];
  const facility = s.facilityName ?? s.city ?? s.address ?? "—";
  const copyValue = s.address ?? s.city ?? s.facilityName ?? "";
  const window = s.apptStart && s.apptEnd && s.apptStart !== s.apptEnd
    ? `${fmtTime(s.apptStart)} – ${fmtTime(s.apptEnd)}`
    : fmtTime(s.apptStart);

  const distMi = truckLoc && s.lat != null && s.lng != null
    ? distanceMiles(truckLoc.lat, truckLoc.lon, s.lat, s.lng)
    : null;

  const distLabel = distMi == null
    ? null
    : distMi < 0.1 ? "On-site"
    : distMi < 10  ? `${distMi.toFixed(1)} mi from truck`
    :                `${Math.round(distMi)} mi from truck`;

  async function handleCopy() {
    if (!copyValue) return;
    await Clipboard.setStringAsync(copyValue);
    setCopied(true);
    onCopied("Address copied");
    setTimeout(() => setCopied(false), 1500);
  }

  async function fetchEta() {
    if (!truckLoc || s.lat == null || s.lng == null || !env.googleMapsKey || etaLoading) return;
    setEtaLoading(true);
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${truckLoc.lat},${truckLoc.lon}&destination=${s.lat},${s.lng}&key=${env.googleMapsKey}`;
      const res = await fetch(url);
      const data = await res.json() as {
        routes?: { legs?: { duration?: { value: number } }[] }[];
      };
      const seconds = data.routes?.[0]?.legs?.[0]?.duration?.value;
      if (typeof seconds === "number") {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.round((seconds % 3600) / 60);
        const duration = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        const arr = new Date(Date.now() + seconds * 1000);
        const tz = s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const arrival = arr
          .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })
          .toLowerCase();
        setEta({ duration, arrival });
      }
    } catch (err) {
      console.warn("fetchEta:", err);
    } finally {
      setEtaLoading(false);
    }
  }

  return (
    <View style={{
      flexDirection: "row", padding: 14, marginBottom: 10,
      backgroundColor: "#ffffff", borderRadius: 14,
      borderWidth: 1, borderColor: "#e8eaed",
      position: "relative",
    }}>
      {/* Top-right action buttons: check-in indicator (if any) + copy address */}
      <View style={{ position: "absolute", top: 10, right: 10, zIndex: 2, flexDirection: "row", gap: 6 }}>
        {s.arrivedAt ? (
          <TouchableOpacity
            onPress={() => setShowCheckIn((v) => !v)}
            hitSlop={8}
            activeOpacity={0.7}
            style={{
              width: 30, height: 30, borderRadius: 10,
              backgroundColor: showCheckIn ? "#16a34a" : "#dcfce7",
              alignItems: "center", justifyContent: "center",
              borderWidth: 1, borderColor: "#bbf7d0",
            }}
          >
            <CheckCircle2 size={14} color={showCheckIn ? "#ffffff" : "#15803d"} strokeWidth={2.4} />
          </TouchableOpacity>
        ) : null}
        {copyValue ? (
          <TouchableOpacity
            onPress={handleCopy}
            hitSlop={8}
            activeOpacity={0.7}
            style={{
              width: 30, height: 30, borderRadius: 10,
              backgroundColor: "#f1f3f4",
              alignItems: "center", justifyContent: "center",
              borderWidth: 1, borderColor: "#e8eaed",
            }}
          >
            {copied
              ? <Check size={14} color="#15803d" strokeWidth={2.6} />
              : <Copy  size={14} color="#5f6368" strokeWidth={2.2} />}
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={{
        width: 40, height: 40, borderRadius: 12,
        backgroundColor: tint.mark,
        alignItems: "center", justifyContent: "center",
        marginRight: 12,
      }}>
        <Text style={[txt(800), { color: "#ffffff", fontSize: 16 }]}>{index + 1}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tint.bg, marginBottom: 4 }}>
          <Text style={[txt(800), { fontSize: 10, color: tint.fg, letterSpacing: 0.5 }]}>
            {tint.label.toUpperCase()}
          </Text>
        </View>
        <Text style={[txt(800), { fontSize: 15, color: "#202124", paddingRight: s.arrivedAt ? 78 : 42 }]} numberOfLines={2}>
          {facility}
        </Text>
        {s.address && s.address !== facility ? (
          <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 2, paddingRight: s.arrivedAt ? 78 : 42 }]} numberOfLines={2}>
            {s.address}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 }}>
          <Clock size={12} color="#5f6368" strokeWidth={2.2} />
          <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]}>{window}</Text>
        </View>
        {distLabel ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Truck size={12} color="#1a73e8" strokeWidth={2.2} />
              <Text style={[txt(700), { fontSize: 12, color: "#1a73e8" }]}>{distLabel}</Text>
            </View>
            {eta ? (
              <Text style={[txt(700), { fontSize: 12, color: "#1a73e8" }]}>
                · {eta.duration} drive · arr {eta.arrival}
              </Text>
            ) : (
              <TouchableOpacity
                onPress={fetchEta}
                disabled={etaLoading}
                hitSlop={6}
                activeOpacity={0.7}
                style={{
                  paddingHorizontal: 8, paddingVertical: 2,
                  backgroundColor: "#e8f0fe", borderRadius: 999,
                  borderWidth: 1, borderColor: "#bfdbfe",
                }}
              >
                <Text style={[txt(800), { fontSize: 11, color: "#1a73e8", letterSpacing: 0.3 }]}>
                  {etaLoading ? "Calculating…" : "Get ETA"}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}
        {s.arrivedAt && showCheckIn ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
            <MapPin size={12} color="#15803d" strokeWidth={2.2} />
            <Text style={[txt(700), { fontSize: 12, color: "#15803d" }]}>
              Checked in {fmtFullDateTime(s.arrivedAt)}
            </Text>
          </View>
        ) : null}
        {s.instructions ? (
          <ExpandableNote text={s.instructions} tint={{ bg: "#fff7ed", fg: "#9a3412" }} />
        ) : null}
      </View>
    </View>
  );
}

function RelayDisclaimer({ load, onOpenPartner }: { load: Load; onOpenPartner?: () => void }) {
  if (!load.relayGroupId) return null;
  const isPickup = load.relayRole !== "delivery";
  const me      = load.driverName  ?? load.assetName ?? "This driver";
  const partner = load.partnerDriverName ?? load.partnerAssetName ?? "Another driver";
  const sentence = isPickup
    ? `${me} picks up · ${partner} delivers`
    : `${partner} picks up · ${me} delivers`;
  return (
    <View
      style={{
        marginBottom: 14,
        padding: 14, borderRadius: 14,
        backgroundColor: "#f3e8fd",
        borderWidth: 1, borderColor: "#ddd6fe",
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Repeat2 size={20} color="#6b21a8" strokeWidth={2.2} style={{ marginTop: 2 }} />
        <View style={{ flex: 1 }}>
          <Text style={[txt(800), { fontSize: 13, color: "#6b21a8", letterSpacing: 0.2 }]}>
            Relay Load — {isPickup ? "Pickup Leg" : "Delivery Leg"}
          </Text>
          <Text style={[txt(600), { fontSize: 13, color: "#6b21a8", lineHeight: 19, marginTop: 4 }]}>
            {sentence}
          </Text>
        </View>
      </View>
      {onOpenPartner && load.partnerEventId ? (
        <TouchableOpacity
          onPress={onOpenPartner}
          activeOpacity={0.8}
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
            paddingVertical: 10, borderRadius: 10,
            backgroundColor: "#ffffff",
            borderWidth: 1, borderColor: "#ddd6fe",
          }}
        >
          <Text style={[txt(800), { fontSize: 12, color: "#6b21a8", letterSpacing: 0.3 }]}>
            Open {isPickup ? "delivery" : "pickup"} leg
          </Text>
          <ChevronRight size={14} color="#6b21a8" strokeWidth={2.4} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function RelayHandoffBanner({ mode, partnerName }: { mode: "pickup" | "delivery"; partnerName?: string }) {
  return (
    <View
      style={{
        marginVertical: 6, padding: 14, borderRadius: 14,
        backgroundColor: "#fee2e2",
        borderWidth: 1.5, borderColor: "#dc2626",
        flexDirection: "row", alignItems: "center", gap: 10,
      }}
    >
      <HandCoins size={20} color="#b91c1c" strokeWidth={2.4} />
      <View style={{ flex: 1 }}>
        <Text style={[txt(800), { fontSize: 13, color: "#b91c1c", letterSpacing: 0.4 }]}>
          RELAY HANDOFF
        </Text>
        <Text style={[txt(700), { fontSize: 13, color: "#b91c1c", marginTop: 2 }]}>
          {mode === "pickup"
            ? `${partnerName ?? "Partner driver"} continues from here.`
            : `${partnerName ?? "Partner driver"} brought it to this point.`}
        </Text>
      </View>
    </View>
  );
}

function StopsTab({
  load, width, truckLoc, assetColor, onCopied,
  editMode, draftStops, dirty, isSaving,
  onMoveStop, onDeleteStop, onTapStop, onAddStop, onSplitRelay, canSplitRelay,
  onRemoveRelay, removingRelay, onOpenPartner,
  onCancelEdit, onSaveEdit,
}: StopsTabProps) {
  // In edit mode, render the draft list flat (no relay dimming) so the user
  // edits the full sequence directly. Out of edit mode, keep the relay logic.
  if (editMode) {
    const editableStops = draftStops ?? load.stops;
    return (
      <ScrollView style={{ width, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
        {editableStops.length === 0 ? (
          <Text style={[txt(500), { fontSize: 13, color: "#9aa0a6", textAlign: "center", marginVertical: 30 }]}>
            No stops yet.
          </Text>
        ) : editableStops.map((stop, i) => (
          <EditableStopCard
            key={stop.id}
            stop={stop}
            index={i}
            isFirst={i === 0}
            isLast={i === editableStops.length - 1}
            onTap={() => onTapStop(i)}
            onUp={() => onMoveStop(i, -1)}
            onDown={() => onMoveStop(i, 1)}
            onDelete={() => onDeleteStop(i)}
          />
        ))}

        <TouchableOpacity
          onPress={onAddStop}
          activeOpacity={0.7}
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
            paddingVertical: 14, borderRadius: 14,
            backgroundColor: "#ffffff",
            borderWidth: 1, borderColor: "#bfdbfe",
            borderStyle: "dashed",
          }}
        >
          <Plus size={15} color="#1a73e8" strokeWidth={2.6} />
          <Text style={[txt(800), { fontSize: 13, color: "#1a73e8", letterSpacing: 0.3 }]}>
            Add stop
          </Text>
        </TouchableOpacity>

        {canSplitRelay ? (
          <TouchableOpacity
            onPress={onSplitRelay}
            activeOpacity={0.7}
            style={{
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
              paddingVertical: 12, borderRadius: 14,
              backgroundColor: "#f3e8fd",
              borderWidth: 1, borderColor: "#ddd6fe",
              marginTop: 8,
            }}
          >
            <Split size={14} color="#6b21a8" strokeWidth={2.4} />
            <Text style={[txt(800), { fontSize: 12, color: "#6b21a8", letterSpacing: 0.3 }]}>
              Split into relay
            </Text>
          </TouchableOpacity>
        ) : null}

        {onRemoveRelay ? (
          <TouchableOpacity
            onPress={onRemoveRelay}
            activeOpacity={0.7}
            disabled={removingRelay}
            style={{
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
              paddingVertical: 12, borderRadius: 14,
              backgroundColor: "#fef2f2",
              borderWidth: 1, borderColor: "#fecaca",
              marginTop: 8,
              opacity: removingRelay ? 0.5 : 1,
            }}
          >
            {removingRelay
              ? <ActivityIndicator size="small" color="#b91c1c" />
              : <Repeat2 size={14} color="#b91c1c" strokeWidth={2.4} />}
            <Text style={[txt(800), { fontSize: 12, color: "#b91c1c", letterSpacing: 0.3 }]}>
              Remove relay split
            </Text>
          </TouchableOpacity>
        ) : null}

        <View style={{ marginTop: 24, gap: 8 }}>
          {dirty ? (
            <Text style={[txt(700), { fontSize: 11, color: "#1a73e8", letterSpacing: 0.4, textAlign: "center", marginBottom: 2 }]}>
              Unsaved stop changes
            </Text>
          ) : (
            <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", letterSpacing: 0.3, textAlign: "center", marginBottom: 2 }]}>
              Tap a stop to edit · use arrows to reorder
            </Text>
          )}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <TouchableOpacity
              onPress={onCancelEdit}
              activeOpacity={0.7}
              disabled={isSaving}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 14,
                backgroundColor: "#ffffff",
                borderWidth: 1, borderColor: "#e8eaed",
                alignItems: "center",
                opacity: isSaving ? 0.5 : 1,
              }}
            >
              <Text style={[txt(800), { fontSize: 14, color: "#3c4043", letterSpacing: 0.3 }]}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onSaveEdit}
              activeOpacity={0.85}
              disabled={!dirty || isSaving}
              style={{
                flex: 2, paddingVertical: 14, borderRadius: 14,
                backgroundColor: dirty && !isSaving ? "#1a73e8" : "#bfdbfe",
                alignItems: "center",
                flexDirection: "row", justifyContent: "center", gap: 8,
              }}
            >
              {isSaving
                ? <ActivityIndicator size="small" color="#ffffff" />
                : <Check size={15} color="#ffffff" strokeWidth={2.6} />}
              <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                Save changes
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    );
  }

  const isRelay  = !!load.relayGroupId;
  const isPickup = load.relayRole !== "delivery";
  const stops    = load.stops;
  // The event's stop list already contains the full journey (pickup → relay → delivery).
  // Relay role determines which side of the relay stop is "mine":
  //   pickup leg   → stops up to and including the relay are highlighted
  //   delivery leg → stops from the relay onward are highlighted
  const relayIdx = isRelay ? stops.findIndex((s) => s.type === "relay") : -1;

  type Entry = { stop: Stop; mine: boolean };
  const combined: Entry[] = stops.map((s, i) => {
    if (!isRelay || relayIdx === -1) return { stop: s, mine: true };
    const mine = isPickup ? i <= relayIdx : i >= relayIdx;
    return { stop: s, mine };
  });

  return (
    <ScrollView style={{ width, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <View style={{ marginBottom: 14 }}>
        <RouteMap
          stops={combined.map((e) => e.stop)}
          truckLat={truckLoc?.lat}
          truckLng={truckLoc?.lon}
          assetColor={assetColor ?? undefined}
        />
      </View>

      <RelayDisclaimer load={load} onOpenPartner={onOpenPartner} />

      <View style={{ position: "relative" }}>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 33, top: 30, bottom: 30, width: 2,
            backgroundColor: "#c8d4ee",
            borderRadius: 1,
          }}
        />

        {combined.length === 0 ? (
          <>
            <TimeAnchor kind="start" iso={load.start} />
            <Text style={[txt(500), { fontSize: 13, color: "#9aa0a6", marginBottom: 14 }]}>
              No stops on this load.
            </Text>
            <TimeAnchor kind="end" iso={load.end} />
          </>
        ) : (() => {
          // Find the boundary between "mine" and "partner" so we can drop the
          // event's End time anchor right where this driver's leg actually ends.
          const lastMine = combined.reduce((acc, e, i) => e.mine ? i : acc, -1);
          const firstMine = combined.findIndex((e) => e.mine);
          const out: React.ReactNode[] = [];

          combined.forEach(({ stop, mine }, i) => {
            // On a delivery leg, place Start anchor right before the first "mine" stop.
            if (isRelay && !isPickup && i === firstMine) {
              out.push(<TimeAnchor key="start" kind="start" iso={load.start} />);
            }
            // On a non-relay or pickup-leg load, Start anchor leads off the timeline.
            if (i === 0 && (!isRelay || isPickup)) {
              out.push(<TimeAnchor key="start" kind="start" iso={load.start} />);
            }

            out.push(
              <View
                key={stop.id}
                style={mine ? undefined : { opacity: 0.4 }}
                pointerEvents={mine ? "auto" : "none"}
              >
                <StopCard s={stop} index={i} truckLoc={mine ? truckLoc : null} onCopied={onCopied} />
              </View>
            );

            // On a pickup leg, drop End anchor immediately after the last "mine" stop.
            if (isRelay && isPickup && i === lastMine) {
              out.push(<TimeAnchor key="end" kind="end" iso={load.end} />);
            }
            // On a non-relay or delivery-leg load, End anchor closes the timeline.
            if (i === combined.length - 1 && (!isRelay || !isPickup)) {
              out.push(<TimeAnchor key="end" kind="end" iso={load.end} />);
            }
          });

          return out;
        })()}
      </View>
    </ScrollView>
  );
}

interface OpenEditField {
  title:    string;
  column:   string;
  initial:  string;
  kind:     EditFieldKind;
  hint?:    string;
  transform?: (raw: string) => unknown;
}

function DetailsTab({
  load, width, onCopied,
  onPickTrailer, onPickAsset, onPickDriver, onEditBroker, onEditDate,
  loadedMiles, editMode, onEditField, dirty,
  onCancelEdit, onSaveEdit, isSaving,
  onDeleteLoad, isDeleting,
  accessorials,
  onAddAccessorial, onEditAccessorial,
  customers,
}: {
  load: Load;
  width: number;
  onCopied: (msg: string) => void;
  onPickTrailer: () => void;
  onPickAsset:  () => void;
  onPickDriver: () => void;
  onEditBroker: () => void;
  onEditDate:   () => void;
  loadedMiles?: number | null;
  editMode: boolean;
  onEditField: (f: OpenEditField) => void;
  dirty: Set<string>;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  isSaving: boolean;
  onDeleteLoad: () => void;
  isDeleting:   boolean;
  /** Current accessorials list — draft when editing, otherwise from the load. */
  accessorials:        Accessorial[];
  onAddAccessorial:    () => void;
  onEditAccessorial:   (acc: Accessorial) => void;
  customers:           import("@/lib/api").Customer[];
}) {
  const refs   = load.refNums?.filter((r) => r.value) ?? [];
  const hasRef = !!load.loadNum || refs.length > 0;
  const hasFin = load.loadPrice != null || load.driverPay != null;
  const hasNotes = !!load.notes || !!load.specialInstructions;
  const totalBillable = useMemo(
    () => accessorials.filter((a) => a.billable).reduce((sum, a) => sum + (a.amount || 0), 0),
    [accessorials],
  );
  const ratePerMile = (load.loadPrice != null && loadedMiles != null && loadedMiles > 0)
    ? load.loadPrice / loadedMiles
    : null;

  // Editable text/number columns. Asset/Driver/Dates require pickers — deferred.
  const editLoadNum    = () => onEditField({ title: "Load #",    column: "load_num", initial: load.loadNum  ?? "", kind: "text",      transform: (v) => v.trim() || null });
  const editBroker     = () => onEditField({ title: "Broker",    column: "broker",   initial: load.broker   ?? "", kind: "text",      transform: (v) => v.trim() || null });
  const editTrailerTyp = () => onEditField({ title: "Trailer Type", column: "trailer_type", initial: load.trailerType ?? "", kind: "text", transform: (v) => v.trim() || null });
  const editLoadPrice  = () => onEditField({ title: "Load Price",   column: "load_price", initial: load.loadPrice != null ? String(load.loadPrice) : "", kind: "number", transform: (v) => v ? parseFloat(v) : null });
  const editDriverPay  = () => onEditField({ title: "Driver Pay",   column: "driver_pay", initial: load.driverPay != null ? String(load.driverPay) : "", kind: "number", transform: (v) => v ? parseFloat(v) : null });
  // Special Instructions writes to load.notes (the canonical column);
  // load.specialInstructions is read-only legacy data we display as fallback.
  const specialInstructionsValue = load.notes ?? load.specialInstructions ?? "";
  const editSpecial    = () => onEditField({ title: "Special Instructions", column: "notes", initial: specialInstructionsValue, kind: "multiline", transform: (v) => v.trim() || null });

  return (
    <ScrollView style={{ width, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>

      {/* Schedule */}
      <SectionLabel>Schedule</SectionLabel>
      <Card>
        {editMode ? (
          <>
            <EditableRow
              Icon={Clock} label="Start"
              value={fmtFullDateTime(load.start)}
              editing modified={dirty.has("start")}
              onEdit={onEditDate}
            />
            <EditableRow
              Icon={Clock} label="End"
              value={fmtFullDateTime(load.end)}
              editing modified={dirty.has("end")}
              onEdit={onEditDate}
              last
            />
          </>
        ) : (
          <>
            <MetaRow Icon={Clock} label="Start" value={fmtFullDateTime(load.start)} />
            <MetaRow Icon={Clock} label="End"   value={fmtFullDateTime(load.end)} last />
          </>
        )}
      </Card>

      {/* References */}
      {(load.internalLoadId != null || hasRef || editMode) ? (
        <>
          <SectionLabel>References</SectionLabel>
          <Card>
            {load.internalLoadId != null ? (
              <CopyMetaRow
                Icon={Hash}
                label="Internal ID"
                value={String(load.internalLoadId)}
                onCopied={onCopied}
                last={!hasRef && !editMode}
              />
            ) : null}
            {editMode ? (
              <EditableRow
                Icon={Hash} label="Load #" value={load.loadNum}
                editing modified={dirty.has("load_num")}
                onEdit={editLoadNum}
                last={refs.length === 0}
              />
            ) : load.loadNum ? (
              <CopyMetaRow
                Icon={Hash}
                label="Load #"
                value={load.loadNum}
                onCopied={onCopied}
                last={refs.length === 0}
              />
            ) : null}
            {!editMode ? refs.map((r, i) => (
              <CopyMetaRow
                key={`${r.label}-${i}`}
                Icon={Hash}
                label={r.label || "Reference"}
                value={r.value}
                onCopied={onCopied}
                last={i === refs.length - 1}
              />
            )) : null}
          </Card>
        </>
      ) : null}

      {/* Operations */}
      <SectionLabel>Operations</SectionLabel>
      <Card>
        <EditableRow
          Icon={Truck}
          label="Asset"
          value={load.assetName}
          editing={editMode}
          modified={dirty.has("asset_id")}
          onEdit={onPickAsset}
        />
        {editMode ? (
          <EditableRow
            Icon={User}
            label="Driver"
            value={load.driverName}
            editing
            modified={dirty.has("driver_id")}
            onEdit={onPickDriver}
          />
        ) : load.driverName ? (
          load.driverPhone ? (
            <CopyMetaRow
              Icon={User} label={load.driverName} value={load.driverPhone}
              onCopied={onCopied}
            />
          ) : (
            <MetaRow Icon={User} label="Driver" value={load.driverName} />
          )
        ) : null}
        <EditableRow
          Icon={Building2} label="Broker"
          value={editMode ? load.broker : displayBrokerName(load.broker, customers)}
          editing={editMode} modified={dirty.has("broker")}
          onEdit={onEditBroker}
        />
        <EditableRow
          Icon={Box} label="Trailer Type" value={load.trailerType}
          editing={editMode} modified={dirty.has("trailer_type")}
          onEdit={editTrailerTyp}
        />
        <LinkMetaRow
          Icon={Box}
          label="Trailer"
          value={load.trailerNum ? `#${load.trailerNum}` : "Tap to select"}
          onPress={onPickTrailer}
          last
        />
      </Card>

      {/* Financial */}
      {hasFin || loadedMiles != null || editMode || accessorials.length > 0 ? (
        <>
          <View style={{
            flexDirection: "row", alignItems: "center",
            marginTop: 18, marginBottom: 10,
          }}>
            <Text style={[txt(800), {
              fontSize: 11, letterSpacing: 1.1, color: "#5f6368",
              textTransform: "uppercase", flex: 1,
            }]}>
              Financial
            </Text>
            <TouchableOpacity
              onPress={onAddAccessorial}
              activeOpacity={0.7}
              hitSlop={6}
              style={{
                flexDirection: "row", alignItems: "center", gap: 4,
                paddingHorizontal: 10, paddingVertical: 6,
                borderRadius: 999,
                backgroundColor: "#e8f0fe",
              }}
            >
              <Plus size={12} color="#1a73e8" strokeWidth={2.6} />
              <Text style={[txt(800), { fontSize: 11, color: "#1a73e8", letterSpacing: 0.3 }]}>
                Accessorial
              </Text>
            </TouchableOpacity>
          </View>

          {hasFin || editMode ? (
            <Card>
              <EditableRow
                Icon={DollarSign} label="Load Price"
                value={load.loadPrice != null ? fmtMoney(load.loadPrice) : null}
                color="#15803d"
                editing={editMode} modified={dirty.has("load_price")}
                onEdit={editLoadPrice}
              />
              <EditableRow
                Icon={DollarSign} label="Driver Pay"
                value={load.driverPay != null ? fmtMoney(load.driverPay) : null}
                color="#15803d"
                editing={editMode} modified={dirty.has("driver_pay")}
                onEdit={editDriverPay}
                last
              />
            </Card>
          ) : null}

          {(loadedMiles != null || ratePerMile != null) ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: hasFin ? 10 : 0 }}>
              {loadedMiles != null ? (
                <View style={{
                  flexDirection: "row", alignItems: "center", gap: 6,
                  paddingHorizontal: 12, paddingVertical: 7,
                  backgroundColor: "#e8f0fe", borderRadius: 999,
                  borderWidth: 1, borderColor: "#bfdbfe",
                }}>
                  <Route size={13} color="#1a73e8" strokeWidth={2.4} />
                  <Text style={[txt(800), { fontSize: 12, color: "#1a73e8", letterSpacing: 0.2 }]}>
                    {loadedMiles.toLocaleString()} mi loaded
                  </Text>
                </View>
              ) : null}
              {ratePerMile != null ? (
                <View style={{
                  flexDirection: "row", alignItems: "center", gap: 6,
                  paddingHorizontal: 12, paddingVertical: 7,
                  backgroundColor: "#e6f4ea", borderRadius: 999,
                  borderWidth: 1, borderColor: "#bbf7d0",
                }}>
                  <DollarSign size={13} color="#15803d" strokeWidth={2.4} />
                  <Text style={[txt(800), { fontSize: 12, color: "#15803d", letterSpacing: 0.2 }]}>
                    ${ratePerMile.toFixed(2)} / mi
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {accessorials.length > 0 ? (
            <View style={{ marginTop: 10, gap: 8 }}>
              {accessorials.map((a) => (
                <AccessorialCard
                  key={a.id}
                  acc={a}
                  onEdit={() => onEditAccessorial(a)}
                />
              ))}
            </View>
          ) : null}

          {totalBillable > 0 && load.loadPrice != null ? (
            <View style={{
              marginTop: 10,
              paddingHorizontal: 12, paddingVertical: 10,
              borderRadius: 12,
              backgroundColor: "#f0fdf4",
              borderWidth: 1, borderColor: "#bbf7d0",
            }}>
              <Text style={[txt(700), { fontSize: 12, color: "#166534" }]}>
                Total billable to broker: <Text style={txt(800)}>
                  {fmtMoney((load.loadPrice ?? 0) + totalBillable)}
                </Text>
              </Text>
              <Text style={[txt(500), { fontSize: 11, color: "#166534", marginTop: 2 }]}>
                {fmtMoney(load.loadPrice ?? 0)} load + {fmtMoney(totalBillable)} accessorials
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      {(hasNotes || editMode) ? (
        <>
          <SectionLabel>Special Instructions</SectionLabel>
          {editMode ? (
            <TouchableOpacity
              onPress={editSpecial}
              activeOpacity={0.7}
              style={{
                backgroundColor: "#fef3c7", borderRadius: 12, padding: 12,
                borderWidth: 1, borderColor: dirty.has("notes") ? "#1a73e8" : "#fde68a",
                flexDirection: "row", alignItems: "flex-start", gap: 8,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={[txt(800), { fontSize: 11, color: "#92400e", letterSpacing: 0.4, marginBottom: 4 }]}>
                  SPECIAL INSTRUCTIONS{dirty.has("notes") ? " ·" : ""}
                </Text>
                <Text style={[txt(600), { fontSize: 13, color: specialInstructionsValue ? "#92400e" : "#9aa0a6", lineHeight: 18 }]}>
                  {specialInstructionsValue || "Tap to add"}
                </Text>
              </View>
              <Pencil size={13} color={dirty.has("notes") ? "#1a73e8" : "#92400e"} strokeWidth={2.4} style={{ marginTop: 2 }} />
            </TouchableOpacity>
          ) : specialInstructionsValue ? (
            <View style={{
              backgroundColor: "#fef3c7", borderRadius: 12, padding: 12,
              borderWidth: 1, borderColor: "#fde68a",
            }}>
              <Text style={[txt(600), { fontSize: 13, color: "#92400e", lineHeight: 18 }]}>
                {specialInstructionsValue}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      {editMode ? (
        <View style={{ marginTop: 24, gap: 8 }}>
          {dirty.size > 0 ? (
            <Text style={[txt(700), { fontSize: 11, color: "#1a73e8", letterSpacing: 0.4, textAlign: "center", marginBottom: 2 }]}>
              {dirty.size} unsaved {dirty.size === 1 ? "change" : "changes"}
            </Text>
          ) : (
            <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", letterSpacing: 0.3, textAlign: "center", marginBottom: 2 }]}>
              Tap any field above to edit
            </Text>
          )}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <TouchableOpacity
              onPress={onCancelEdit}
              activeOpacity={0.7}
              disabled={isSaving}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 14,
                backgroundColor: "#ffffff",
                borderWidth: 1, borderColor: "#e8eaed",
                alignItems: "center",
                opacity: isSaving ? 0.5 : 1,
              }}
            >
              <Text style={[txt(800), { fontSize: 14, color: "#3c4043", letterSpacing: 0.3 }]}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onSaveEdit}
              activeOpacity={0.85}
              disabled={dirty.size === 0 || isSaving}
              style={{
                flex: 2, paddingVertical: 14, borderRadius: 14,
                backgroundColor: dirty.size > 0 && !isSaving ? "#1a73e8" : "#bfdbfe",
                alignItems: "center",
                flexDirection: "row", justifyContent: "center", gap: 8,
              }}
            >
              {isSaving
                ? <ActivityIndicator size="small" color="#ffffff" />
                : <Check size={15} color="#ffffff" strokeWidth={2.6} />}
              <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                Save changes
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Danger zone — visible only when NOT in edit mode (to avoid competing
          with the Save/Cancel actions during an edit session). */}
      {!editMode ? (
        <TouchableOpacity
          onPress={onDeleteLoad}
          activeOpacity={0.7}
          disabled={isDeleting}
          style={{
            marginTop: 28, paddingVertical: 12, borderRadius: 12,
            backgroundColor: "#fef2f2",
            borderWidth: 1, borderColor: "#fecaca",
            alignItems: "center", justifyContent: "center",
            flexDirection: "row", gap: 6,
            opacity: isDeleting ? 0.5 : 1,
          }}
        >
          {isDeleting
            ? <ActivityIndicator size="small" color="#b91c1c" />
            : <Trash2 size={13} color="#b91c1c" strokeWidth={2.4} />}
          <Text style={[txt(800), { fontSize: 12, color: "#b91c1c", letterSpacing: 0.3 }]}>
            Delete load
          </Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function LoadDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { organization } = useOrganization();
  const { getToken } = useAuth();
  const orgId = organization?.id;
  const insets = useSafeAreaInsets();
  const SCREEN_W = Dimensions.get("window").width;

  const [tab, setTab] = useState<0 | 1 | 2>(0);
  const [statusPickerVisible, setStatusPickerVisible] = useState(false);
  const [trailerPickerVisible, setTrailerPickerVisible] = useState(false);
  const [assetPickerVisible,  setAssetPickerVisible]  = useState(false);
  const [driverPickerVisible, setDriverPickerVisible] = useState(false);
  const [brokerEditVisible,   setBrokerEditVisible]   = useState(false);
  const [scheduleEditOpen,    setScheduleEditOpen]    = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [accSheetState, setAccSheetState] = useState<{ initial: Accessorial | null } | null>(null);
  const [stopsEditMode, setStopsEditMode] = useState(false);
  const [stopsDraft, setStopsDraft]       = useState<Stop[] | null>(null);
  const [stopEditingIdx, setStopEditingIdx] = useState<number | null>(null);
  const [relaySplitOpen, setRelaySplitOpen] = useState(false);
  const [editingField, setEditingField] = useState<{
    title:  string;
    column: string;
    initial: string;
    kind:   EditFieldKind;
    hint?:  string;
    transform?: (raw: string) => unknown;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), 1800);
  };
  const pagerRef = useRef<ScrollView>(null);

  function goToTab(idx: 0 | 1 | 2) {
    setTab(idx);
    pagerRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
  }
  // Generic guard: if the user is editing the active tab and has unsaved
  // changes, prompt with Save/Discard/Keep editing before running `proceed`.
  function guardLeave(proceed: () => void) {
    const hasDetails = editMode && Object.keys(draft).length > 0;
    const hasStops   = stopsEditMode && stopsDirty();
    if (!hasDetails && !hasStops) { proceed(); return; }
    Alert.alert(
      "Unsaved changes",
      "You've made edits to this load. What would you like to do?",
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            if (hasDetails) { setDraft({}); setEditMode(false); }
            if (hasStops)   { setStopsDraft(null); setStopsEditMode(false); }
            proceed();
          },
        },
        {
          text: "Save",
          onPress: async () => {
            try {
              if (hasDetails) await saveDraftAsync(draft);
              if (hasStops && stopsDraft) await saveStopsAsync(stopsDraft);
              proceed();
            } catch { /* error handled in mutation */ }
          },
        },
      ],
    );
  }
  function selectTab(idx: 0 | 1 | 2) {
    const leavingActiveEdit =
      (tab === 1 && idx !== 1 && editMode) ||
      (tab === 0 && idx !== 0 && stopsEditMode);
    if (leavingActiveEdit) {
      guardLeave(() => goToTab(idx));
      return;
    }
    goToTab(idx);
  }

  const { data: load, isLoading, isFetching } = useQuery({
    queryKey: ["load", id],
    queryFn:  () => fetchLoad(id!, orgId!),
    enabled:  !!id && !!orgId,
  });

  const { data: assetsForPicker = [] } = useQuery({
    queryKey: ["assets", orgId],
    queryFn:  () => fetchAssets(orgId!),
    enabled:  !!orgId,
    staleTime: 5 * 60 * 1000,
  });
  const visiblePickerAssets = useMemo(() => assetsForPicker.filter((a) => !a.hidden), [assetsForPicker]);

  const { data: drivers = [] } = useQuery({
    queryKey: ["drivers", orgId],
    queryFn:  () => fetchDrivers(orgId!),
    enabled:  !!orgId,
    staleTime: 10 * 60 * 1000,
  });

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", orgId],
    queryFn:  () => fetchCustomers(orgId!),
    enabled:  !!orgId,
    staleTime: 10 * 60 * 1000,
  });

  const { data: driverPrefs } = useQuery({
    queryKey: ["driver-asset-prefs", orgId],
    queryFn:  () => fetchDriverAssetPrefs(orgId!),
    enabled:  !!orgId,
    staleTime: 10 * 60 * 1000,
  });

  const { data: motiveLocations = [] } = useQuery({
    queryKey: ["motive-locations", orgId],
    queryFn:  () => fetchMotiveLocations(getToken),
    enabled:  !!orgId,
    staleTime: 5 * 60 * 1000,
  });
  // Resolve the motive vehicle id off the load's asset, not the load — the
  // events/loads tables don't carry motive_vehicle_id; it lives on assets.
  const loadAsset = load ? assetsForPicker.find((a) => a.id === load.assetId) ?? null : null;
  const truckLoc = loadAsset?.motiveVehicleId
    ? motiveLocations.find((l) => l.vehicleId === loadAsset.motiveVehicleId) ?? null
    : null;

  // Tracks the wall-clock time of our most recent local save so we can ignore
  // the realtime echo of our own write. Anything within ~3s is treated as
  // self. Stamped in `onMutate` (before the API call) — with Railway writes
  // the realtime broadcast can arrive before `onSuccess` runs.
  const lastSelfSaveAt = useRef(0);
  const stampSelf = () => { lastSelfSaveAt.current = Date.now(); };
  const [remoteUpdate, setRemoteUpdate] = useState(false);

  const { mutate: changeStatus, isPending: isUpdatingStatus } = useMutation({
    mutationFn: (s: LoadStatus) => updateLoadStatus(id!, orgId!, s),
    onMutate: stampSelf,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
    },
    onError: (err) => Alert.alert("Couldn't update status", err instanceof Error ? err.message : "Unknown error"),
  });

  const { mutate: changeTrailer } = useMutation({
    mutationFn: (trailerId: number | null) => updateLoadTrailer(id!, orgId!, trailerId),
    onMutate: stampSelf,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["load", id] }),
    onError:   (err) => Alert.alert("Couldn't update trailer", err instanceof Error ? err.message : "Unknown error"),
  });

  const { mutate: saveDraft, mutateAsync: saveDraftAsync, isPending: isSavingDraft } = useMutation({
    mutationFn: (fields: Record<string, unknown>) => updateLoadFields(id!, orgId!, fields),
    onMutate: stampSelf,
    onSuccess: (_data, fields) => {
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
      const count = Object.keys(fields).length;
      showToast(`Saved ${count} ${count === 1 ? "change" : "changes"}`);
      setDraft({});
      setEditMode(false);
      setRemoteUpdate(false);
    },
    onError: (err) => Alert.alert("Couldn't save", err instanceof Error ? err.message : "Unknown error"),
  });

  const { mutate: saveStopsM, mutateAsync: saveStopsAsync, isPending: isSavingStops } = useMutation({
    mutationFn: (next: Stop[]) => saveStops(id!, orgId!, next),
    onMutate: stampSelf,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
      showToast("Stops saved");
      setStopsDraft(null);
      setStopsEditMode(false);
      setRemoteUpdate(false);
    },
    onError: (err) => Alert.alert("Couldn't save stops", err instanceof Error ? err.message : "Unknown error"),
  });

  // Accessorials save immediately on Add/Edit/Delete from the sheet — they
  // don't wait for the editMode "Done" save flow, since the sheet is
  // available outside edit mode.
  const { mutate: saveAccessorialsM, isPending: isSavingAcc } = useMutation({
    mutationFn: (next: Accessorial[]) => updateLoadFields(id!, orgId!, { accessorials: next }),
    onMutate: stampSelf,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
      showToast("Accessorial saved");
      setRemoteUpdate(false);
      setAccSheetState(null);
    },
    onError: (err) => Alert.alert("Couldn't save accessorial", err instanceof Error ? err.message : "Unknown error"),
  });

  function enterStopsEditMode() {
    setStopsDraft(load?.stops ? [...load.stops] : []);
    setStopsEditMode(true);
  }
  function cancelStopsEditMode() {
    if (!stopsDirty()) { setStopsDraft(null); setStopsEditMode(false); return; }
    Alert.alert(
      "Discard stop changes?",
      "Your unsaved edits will be lost.",
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => { setStopsDraft(null); setStopsEditMode(false); } },
      ],
    );
  }
  function commitStopsEditMode() {
    if (!stopsDraft || !stopsDirty()) { setStopsEditMode(false); return; }
    saveStopsM(stopsDraft);
  }
  function stopsDirty(): boolean {
    if (!stopsDraft || !load) return false;
    if (stopsDraft.length !== load.stops.length) return true;
    return stopsDraft.some((s, i) => {
      const o = load.stops[i];
      return !o
        || s.id !== o.id
        || s.type !== o.type
        || s.facilityName !== o.facilityName
        || s.address !== o.address
        || s.apptStart !== o.apptStart
        || s.apptEnd !== o.apptEnd
        || s.instructions !== o.instructions
        || s.lat !== o.lat
        || s.lng !== o.lng;
    });
  }
  function moveStop(idx: number, dir: -1 | 1) {
    setStopsDraft((prev) => {
      if (!prev) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }
  function deleteStop(idx: number) {
    Alert.alert(
      "Delete stop?",
      "This will remove the stop when you save.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => {
          setStopsDraft((prev) => prev ? prev.filter((_, i) => i !== idx) : prev);
        }},
      ],
    );
  }
  // Relay-split available whenever this isn't already a relay leg, no relay
  // stop exists in the draft, and there are at least 2 stops to split between.
  // Auto-insertion rule handles where the relay goes regardless of stop types.
  function canSplitRelay(): boolean {
    if (!load) return false;
    if (load.relayGroupId) return false;
    const list = stopsDraft ?? load.stops;
    if (list.some((s) => s.type === "relay")) return false;
    return list.length >= 2;
  }

  const { mutate: splitRelay, isPending: isSplittingRelay } = useMutation({
    mutationFn: async (opts: {
      deliveryAssetId:    number;
      deliveryDriverId:   number | null;
      deliveryDriverName: string | null;
      pickupEndIso:       string;
      deliveryStartIso:   string;
      deliveryEndIso:     string;
      relayStop:          Stop;
      insertAfterIdx:     number;
    }) => {
      if (!load) throw new Error("Load not loaded");
      const list = stopsDraft ?? load.stops;
      const at = Math.min(Math.max(opts.insertAfterIdx + 1, 1), list.length);
      const merged = [...list.slice(0, at), opts.relayStop, ...list.slice(at)];
      const deliveryId = await splitIntoRelay({
        eventId:           id!,
        orgId:             orgId!,
        pickupEnd:         opts.pickupEndIso,
        deliveryStart:     opts.deliveryStartIso,
        deliveryEnd:       opts.deliveryEndIso,
        deliveryAssetId:   opts.deliveryAssetId,
        deliveryDriverId:  opts.deliveryDriverId,
        deliveryDriverName: opts.deliveryDriverName,
        mergedStops:       merged,
      });
      return deliveryId;
    },
    onMutate: stampSelf,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
      setRelaySplitOpen(false);
      setStopsDraft(null);
      setStopsEditMode(false);
      showToast("Split into relay");
    },
    onError: (err) => Alert.alert("Couldn't split load", err instanceof Error ? err.message : "Unknown error"),
  });

  const { mutate: deleteLoad, isPending: isDeletingLoad } = useMutation({
    mutationFn: () => softDeleteLoad(id!, orgId!),
    onMutate: stampSelf,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
      queryClient.invalidateQueries({ queryKey: ["deleted-loads", orgId] });
      showToast("Load moved to trash");
      router.back();
    },
    onError: (err) => Alert.alert("Couldn't delete", err instanceof Error ? err.message : "Unknown error"),
  });
  function confirmDeleteLoad() {
    Alert.alert(
      "Delete this load?",
      "It will move to Recently Deleted and be removed permanently after 30 days.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => deleteLoad() },
      ],
    );
  }

  const { mutate: undoRelay, isPending: isRemovingRelay } = useMutation({
    mutationFn: () => removeRelay(id!, orgId!),
    onMutate: stampSelf,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
      setStopsDraft(null);
      setStopsEditMode(false);
      showToast("Relay removed");
    },
    onError: (err) => Alert.alert("Couldn't remove relay", err instanceof Error ? err.message : "Unknown error"),
  });
  function confirmRemoveRelay() {
    if (!load) return;
    if (load.relayRole !== "pickup") {
      Alert.alert(
        "Edit pickup leg to remove",
        "Open the pickup leg of this relay to remove the split.",
      );
      return;
    }
    Alert.alert(
      "Remove relay split?",
      "The two legs will be merged back into one load. The delivery leg will be removed.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => undoRelay() },
      ],
    );
  }

  function applyStopEdit(next: Stop) {
    setStopsDraft((prev) => {
      if (!prev || stopEditingIdx == null) return prev;
      const out = [...prev];
      out[stopEditingIdx] = next;
      return out;
    });
    setNewStopIdx(null);
    setStopEditingIdx(null);
  }
  // When the user taps "+ Add stop", we append a placeholder stop and open
  // the edit sheet on it. If the user cancels without applying, we drop the
  // placeholder so cancelled adds don't pollute the draft.
  const [newStopIdx, setNewStopIdx] = useState<number | null>(null);
  function addStop() {
    const cur = stopsDraft ?? load?.stops ?? [];
    const defaultType: StopType =
      cur.length === 0 ? "pickup"
      : cur.every((s) => s.type === "pickup") ? "delivery"
      : "stop";
    const newStop: Stop = {
      id:       `tmp-${Date.now()}`,
      sequence: cur.length + 1,
      type:     defaultType,
    };
    const nextList = [...cur, newStop];
    setStopsDraft(nextList);
    setNewStopIdx(nextList.length - 1);
    setStopEditingIdx(nextList.length - 1);
  }
  function closeStopEdit() {
    // If the user cancels a brand-new untouched stop, remove it from the draft.
    if (newStopIdx != null && stopEditingIdx === newStopIdx) {
      setStopsDraft((prev) => prev ? prev.filter((_, i) => i !== newStopIdx) : prev);
      setNewStopIdx(null);
    }
    setStopEditingIdx(null);
  }

  function enterEditMode() {
    setDraft({});
    setEditMode(true);
  }
  function cancelEditMode() {
    if (Object.keys(draft).length === 0) {
      setEditMode(false);
      return;
    }
    Alert.alert(
      "Discard changes?",
      "Your unsaved edits will be lost.",
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => { setDraft({}); setEditMode(false); } },
      ],
    );
  }
  function commitEditMode() {
    if (Object.keys(draft).length === 0) { setEditMode(false); return; }
    saveDraft(draft);
  }
  function patchDraft(patch: Record<string, unknown>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  // Accessorials — always read from the server load and write through the
  // dedicated mutation; they're independent of the editMode draft so users
  // can add/edit/remove them without entering edit mode.
  const accessorialsCurrent: Accessorial[] = load?.accessorials ?? [];
  const accPayOpts: string[] = useMemo(() => {
    const opts: string[] = [];
    if (load?.driverName) opts.push(load.driverName);
    if (load?.partnerDriverName && !opts.includes(load.partnerDriverName)) {
      opts.push(load.partnerDriverName);
    }
    return opts;
  }, [load?.driverName, load?.partnerDriverName]);
  function commitAccessorial(acc: Accessorial) {
    const idx = accessorialsCurrent.findIndex((a) => a.id === acc.id);
    const next = idx >= 0
      ? accessorialsCurrent.map((a) => a.id === acc.id ? acc : a)
      : [...accessorialsCurrent, acc];
    saveAccessorialsM(next);
  }
  function deleteAccessorialFromSheet() {
    const initial = accSheetState?.initial;
    if (!initial) { setAccSheetState(null); return; }
    saveAccessorialsM(accessorialsCurrent.filter((a) => a.id !== initial.id));
  }

  // Loaded miles — Google Directions road distance through this load's geocoded stops.
  const stopsKey = (load?.stops ?? [])
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => `${s.lat},${s.lng}`)
    .join("|");
  const { data: loadedMiles } = useQuery({
    queryKey: ["loaded-miles", id, stopsKey],
    queryFn:  () => calcRoadMiles(
      (load?.stops ?? [])
        .filter((s): s is typeof s & { lat: number; lng: number } => s.lat != null && s.lng != null)
        .map((s) => ({ lat: s.lat, lng: s.lng })),
    ),
    enabled:   !!load && stopsKey.length > 0,
    staleTime: 60 * 60 * 1000,
  });

  // Realtime: listen for updates to THIS event from other dispatchers. Show a
  // banner; the user decides whether to refresh (and discard their draft) or
  // keep editing. Skip the echo of our own save by checking lastSelfSaveAt.
  useEffect(() => {
    if (!id || !orgId) return;
    const channel = supabase
      .channel(`event-${id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "events", filter: `id=eq.${id}` },
        (payload) => {
          const row = payload.new as { org_id?: string } | undefined;
          if (!row || row.org_id !== orgId) return;
          if (Date.now() - lastSelfSaveAt.current < 3000) return; // own echo
          setRemoteUpdate(true);
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, orgId]);

  function applyRemoteUpdate() {
    setDraft({});
    setEditMode(false);
    setRemoteUpdate(false);
    queryClient.invalidateQueries({ queryKey: ["load", id] });
    queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
  }
  function dismissRemoteUpdate() {
    if (Object.keys(draft).length === 0) {
      applyRemoteUpdate();
      return;
    }
    Alert.alert(
      "Reload load?",
      "Another dispatcher updated this load. Reloading will discard your unsaved changes.",
      [
        { text: "Keep my edits", style: "cancel" },
        { text: "Reload", style: "destructive", onPress: applyRemoteUpdate },
      ],
    );
  }

  // Merge draft over the loaded event so edit-mode rows reflect pending changes.
  const viewLoad: Load | undefined = useMemo(() => {
    if (!load) return undefined;
    if (Object.keys(draft).length === 0) return load;
    const v: Load = { ...load };
    if ("load_num" in draft)             v.loadNum             = (draft.load_num as string | null) ?? undefined;
    if ("broker" in draft)               v.broker              = (draft.broker as string | null) ?? undefined;
    if ("trailer_type" in draft)         v.trailerType         = (draft.trailer_type as string | null) ?? undefined;
    if ("load_price" in draft)           v.loadPrice           = (draft.load_price as number | null) ?? undefined;
    if ("driver_pay" in draft)           v.driverPay           = (draft.driver_pay as number | null) ?? undefined;
    if ("notes" in draft)                v.notes               = (draft.notes as string | null) ?? undefined;
    if ("special_instructions" in draft) v.specialInstructions = (draft.special_instructions as string | null) ?? undefined;
    if ("start" in draft)                v.start               = draft.start as string;
    if ("end" in draft)                  v.end                 = draft.end as string;
    if ("asset_id" in draft) {
      const aId = draft.asset_id as number;
      v.assetId = aId;
      const a = assetsForPicker.find((x) => x.id === aId);
      v.assetName = a?.name ?? "";
      v.motiveVehicleId = a?.motiveVehicleId;
    }
    if ("driver_id" in draft) {
      const dId = draft.driver_id as number | null;
      v.driverId = dId ?? undefined;
      if (dId == null) {
        v.driverName  = undefined;
        v.driverPhone = undefined;
      } else {
        const d = drivers.find((x) => x.id === dId);
        v.driverName  = ("driver_name" in draft ? (draft.driver_name as string | null) : d?.name) ?? undefined;
        v.driverPhone = d?.phone;
      }
    }
    return v;
  }, [load, draft, assetsForPicker, drivers]);
  const dirtyKeys = useMemo(() => new Set(Object.keys(draft)), [draft]);

  // Spin while the query is in flight (initial load or refetch). Distinguish
  // "loading" from "settled with no row" so we never get stuck on a spinner
  // when the cached value is null.
  if (!load) {
    const stillLoading = isLoading || isFetching;
    return (
      <View style={{ flex: 1, backgroundColor: "#1a73e8" }}>
        <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 12 }}>
          <TouchableOpacity onPress={() => router.back()}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}>
            <ArrowLeft size={18} color="#ffffff" strokeWidth={2.2} />
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f8f9fa", padding: 30 }}>
          {stillLoading ? (
            <ActivityIndicator color="#1a73e8" />
          ) : (
            <>
              <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>Load not found</Text>
              <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
                It may have been deleted or you don&apos;t have access.
              </Text>
              <TouchableOpacity
                onPress={() => router.back()}
                activeOpacity={0.7}
                style={{
                  marginTop: 14,
                  paddingHorizontal: 16, paddingVertical: 10,
                  borderRadius: 999,
                  backgroundColor: "#e8f0fe",
                  borderWidth: 1, borderColor: "#bfdbfe",
                }}
              >
                <Text style={[txt(800), { fontSize: 12, color: "#1a73e8", letterSpacing: 0.3 }]}>Go back</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      {/* Nav bar */}
      <View style={{ backgroundColor: "#1a73e8", paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <TouchableOpacity
            onPress={() => guardLeave(() => router.back())}
            activeOpacity={0.7}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}>
            <ArrowLeft size={18} color="#ffffff" strokeWidth={2.2} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={[txt(800), { fontSize: 16, color: "#ffffff" }]} numberOfLines={1}>
              {load.title}
            </Text>
            {load.eventKind === "non_revenue" ? (
              <View style={{
                alignSelf: "flex-start",
                flexDirection: "row", alignItems: "center", gap: 5,
                paddingHorizontal: 7, paddingVertical: 2,
                marginTop: 4,
                borderRadius: 999,
                backgroundColor: "rgba(255,255,255,0.18)",
              }}>
                <Text style={[txt(800), { fontSize: 9, color: "#ffffff", letterSpacing: 0.4 }]}>
                  NON-REVENUE
                </Text>
                {load.nonRevenueType ? (
                  <>
                    <Text style={[txt(700), { fontSize: 9, color: "rgba(255,255,255,0.7)" }]}>·</Text>
                    <Text style={[txt(800), { fontSize: 9, color: "#ffffff", letterSpacing: 0.3 }]} numberOfLines={1}>
                      {load.nonRevenueType.toUpperCase()}
                    </Text>
                  </>
                ) : null}
              </View>
            ) : null}
          </View>
          <TouchableOpacity
            onPress={() => setStatusPickerVisible(true)}
            activeOpacity={0.7}
            disabled={isUpdatingStatus}
            style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: "rgba(255,255,255,0.1)",
              alignItems: "center", justifyContent: "center",
              opacity: isUpdatingStatus ? 0.5 : 1,
            }}
          >
            <CircleDot size={18} color="#ffffff" strokeWidth={2.2} />
          </TouchableOpacity>
        </View>

        {/* Tab bar */}
        <View style={{ flexDirection: "row", paddingHorizontal: 6, marginTop: 12 }}>
          {(["Stops", "Details", "Documents"] as const).map((label, i) => {
            const isActive = tab === i;
            return (
              <TouchableOpacity
                key={label}
                onPress={() => selectTab(i as 0 | 1 | 2)}
                activeOpacity={0.7}
                style={{ flex: 1, alignItems: "center", paddingBottom: 10 }}
              >
                <Text style={[
                  txt(isActive ? 800 : 600),
                  { fontSize: 13, color: isActive ? "#ffffff" : "rgba(255,255,255,0.55)", marginBottom: 8 },
                ]}>
                  {label}
                </Text>
                <View style={{
                  height: 3, width: "60%", borderRadius: 2,
                  backgroundColor: isActive ? "#ffffff" : "transparent",
                }} />
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {remoteUpdate ? (
        <TouchableOpacity
          onPress={dismissRemoteUpdate}
          activeOpacity={0.85}
          style={{
            marginHorizontal: 12, marginTop: 8,
            paddingHorizontal: 14, paddingVertical: 10,
            backgroundColor: "#fef3c7",
            borderRadius: 12,
            borderWidth: 1, borderColor: "#fcd34d",
            flexDirection: "row", alignItems: "center", gap: 8,
          }}
        >
          <Info size={15} color="#92400e" strokeWidth={2.4} />
          <View style={{ flex: 1 }}>
            <Text style={[txt(800), { fontSize: 12, color: "#92400e", letterSpacing: 0.2 }]}>
              Updated by another dispatcher
            </Text>
            <Text style={[txt(500), { fontSize: 11, color: "#92400e", marginTop: 1 }]}>
              {Object.keys(draft).length > 0
                ? "Tap to review · keeps or discards your edits"
                : "Tap to refresh"}
            </Text>
          </View>
          <ChevronRight size={14} color="#92400e" strokeWidth={2.4} />
        </TouchableOpacity>
      ) : null}

      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W) as 0 | 1 | 2;
          const leavingDetails = tab === 1 && idx !== 1 && editMode && Object.keys(draft).length > 0;
          const leavingStops   = tab === 0 && idx !== 0 && stopsEditMode && stopsDirty();
          if (leavingDetails || leavingStops) {
            pagerRef.current?.scrollTo({ x: tab * SCREEN_W, animated: true });
            guardLeave(() => goToTab(idx));
            return;
          }
          setTab(idx);
        }}
        style={{ flex: 1 }}
      >
        <StopsTab
          load={load}
          width={SCREEN_W}
          truckLoc={truckLoc}
          assetColor={loadAsset?.color}
          onCopied={showToast}
          editMode={stopsEditMode}
          draftStops={stopsDraft ?? undefined}
          dirty={stopsDirty()}
          isSaving={isSavingStops}
          onMoveStop={moveStop}
          onDeleteStop={deleteStop}
          onTapStop={(i) => setStopEditingIdx(i)}
          onAddStop={addStop}
          onSplitRelay={() => setRelaySplitOpen(true)}
          canSplitRelay={canSplitRelay()}
          onRemoveRelay={load.relayGroupId ? confirmRemoveRelay : undefined}
          removingRelay={isRemovingRelay}
          onOpenPartner={load.partnerEventId
            ? () => guardLeave(() => router.push(`/load/${load.partnerEventId}`))
            : undefined}
          onCancelEdit={cancelStopsEditMode}
          onSaveEdit={commitStopsEditMode}
        />
        <DetailsTab
          load={viewLoad ?? load}
          width={SCREEN_W}
          onCopied={showToast}
          onPickTrailer={() => setTrailerPickerVisible(true)}
          onPickAsset={() => setAssetPickerVisible(true)}
          onPickDriver={() => setDriverPickerVisible(true)}
          onEditBroker={() => setBrokerEditVisible(true)}
          onEditDate={() => setScheduleEditOpen(true)}
          loadedMiles={loadedMiles}
          editMode={editMode}
          onEditField={(f) => setEditingField(f)}
          dirty={dirtyKeys}
          onCancelEdit={cancelEditMode}
          onSaveEdit={commitEditMode}
          isSaving={isSavingDraft}
          onDeleteLoad={confirmDeleteLoad}
          isDeleting={isDeletingLoad}
          accessorials={accessorialsCurrent}
          onAddAccessorial={() => setAccSheetState({ initial: null })}
          onEditAccessorial={(acc) => setAccSheetState({ initial: acc })}
          customers={customers}
        />
        {orgId ? (
          <DocumentsView
            eventId={load.id}
            orgId={orgId}
            loadId={load.loadId}
            rateConPath={load.rateConPdf}
            width={SCREEN_W}
          />
        ) : (
          <View style={{ width: SCREEN_W }} />
        )}
      </ScrollView>

      <StatusPickerSheet
        visible={statusPickerVisible}
        current={load.status}
        onClose={() => setStatusPickerVisible(false)}
        onSelect={(s) => {
          setStatusPickerVisible(false);
          if (s !== load.status) changeStatus(s);
        }}
      />

      {orgId ? (
        <TrailerPickerSheet
          visible={trailerPickerVisible}
          orgId={orgId}
          currentId={load.trailerId}
          onClose={() => setTrailerPickerVisible(false)}
          onSelect={(trailerId) => {
            setTrailerPickerVisible(false);
            if (trailerId !== load.trailerId) changeTrailer(trailerId);
          }}
        />
      ) : null}

      <EditFieldSheet
        visible={!!editingField}
        title={editingField?.title ?? ""}
        hint={editingField?.hint}
        initial={editingField?.initial ?? ""}
        kind={editingField?.kind ?? "text"}
        saving={false}
        onClose={() => setEditingField(null)}
        onSave={(raw) => {
          if (!editingField) return;
          const value = editingField.transform ? editingField.transform(raw) : raw;
          patchDraft({ [editingField.column]: value });
          setEditingField(null);
        }}
      />

      {orgId ? (
        <AssetPickerSheet
          visible={assetPickerVisible}
          title="Select asset"
          assets={visiblePickerAssets}
          onClose={() => setAssetPickerVisible(false)}
          onSelect={(a) => {
            setAssetPickerVisible(false);
            const currentAssetId = (viewLoad ?? load).assetId;
            if (a.id === currentAssetId) return;
            const patch: Record<string, unknown> = { asset_id: a.id };
            // Auto-stage preferred driver for the new asset (silent — user can override).
            const prefDriverId = driverPrefs?.[a.id];
            if (prefDriverId != null) {
              const prefDriver = drivers.find((d) => d.id === prefDriverId);
              if (prefDriver) {
                patch.driver_id   = prefDriver.id;
                patch.driver_name = prefDriver.name;
              }
            }
            patchDraft(patch);
          }}
        />
      ) : null}

      {orgId ? (
        <DriverPickerSheet
          visible={driverPickerVisible}
          orgId={orgId}
          currentId={(viewLoad ?? load).driverId}
          onClose={() => setDriverPickerVisible(false)}
          onSelect={(driverId, driverName) => {
            setDriverPickerVisible(false);
            patchDraft({ driver_id: driverId, driver_name: driverName });
          }}
        />
      ) : null}

      {orgId ? (
        <BrokerEditSheet
          visible={brokerEditVisible}
          orgId={orgId}
          initial={(viewLoad ?? load).broker ?? ""}
          saving={false}
          onClose={() => setBrokerEditVisible(false)}
          onSave={(broker) => {
            setBrokerEditVisible(false);
            patchDraft({ broker: broker || null });
          }}
        />
      ) : null}

      {orgId && load ? (
        <RelaySplitSheet
          visible={relaySplitOpen}
          orgId={orgId}
          loadEndIso={load.end}
          stops={stopsDraft ?? load.stops}
          assets={visiblePickerAssets}
          drivers={drivers}
          driverPrefs={driverPrefs}
          pickupAssetId={load.assetId}
          saving={isSplittingRelay}
          onClose={() => setRelaySplitOpen(false)}
          onConfirm={(opts) => splitRelay(opts)}
        />
      ) : null}

      <StopEditSheet
        visible={stopEditingIdx !== null}
        orgId={orgId ?? ""}
        stop={stopEditingIdx != null && stopsDraft ? stopsDraft[stopEditingIdx] ?? null : null}
        onClose={closeStopEdit}
        onSave={applyStopEdit}
      />

      <AccessorialSheet
        visible={accSheetState !== null}
        initial={accSheetState?.initial ?? null}
        payOpts={accPayOpts}
        onClose={() => setAccSheetState(null)}
        onSave={commitAccessorial}
        onDelete={accSheetState?.initial ? deleteAccessorialFromSheet : undefined}
      />

      <DateTimePickerSheet
        visible={scheduleEditOpen}
        mode="range"
        title="Schedule"
        initialStart={(viewLoad ?? load).start}
        initialEnd={(viewLoad ?? load).end}
        onClose={() => setScheduleEditOpen(false)}
        onSave={(range) => {
          setScheduleEditOpen(false);
          patchDraft({ start: range.start, end: range.end });
        }}
      />

      {/* Floating Edit pill — Stops or Details tab, hidden while editing either. */}
      {(tab === 0 && !stopsEditMode) || (tab === 1 && !editMode) ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            right: 16,
            bottom: insets.bottom + 6,
          }}
        >
          <TouchableOpacity
            onPress={tab === 0 ? enterStopsEditMode : enterEditMode}
            activeOpacity={0.85}
            style={{
              flexDirection: "row", alignItems: "center", gap: 6,
              paddingHorizontal: 18, paddingVertical: 12,
              borderRadius: 999,
              backgroundColor: "#1a73e8",
              shadowColor: "#1a73e8",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.3, shadowRadius: 12,
              elevation: 6,
            }}
          >
            <Pencil size={15} color="#ffffff" strokeWidth={2.6} />
            <Text style={[txt(800), { fontSize: 13, color: "#ffffff", letterSpacing: 0.3 }]}>
              Edit
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Toast message={toastMessage} />
    </View>
  );
}
