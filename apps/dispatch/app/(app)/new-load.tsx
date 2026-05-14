import React, { useEffect, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert, TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useOrganization, useAuth, useUser } from "@clerk/clerk-expo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  ArrowLeft, FileText, Sparkles, Truck, X, Hash, Building2, Clock, DollarSign,
  User, Box, Pencil, ChevronRight, Plus, Check,
} from "lucide-react-native";
import {
  fetchAssets, fetchDrivers, fetchDriverAssetPrefs,
  parseRateConViaApi, uploadRateConPdf, createLoad, saveStops,
  geocodeAddress, searchLoads, fetchCustomers,
  type ParsedRateCon, type Customer,
} from "@/lib/api";
import { railway } from "@/lib/railway";
import { useDriverPayPct } from "@/lib/settings";
import { EditFieldSheet, type EditFieldKind } from "@/components/EditFieldSheet";
import { AssetPickerSheet } from "@/components/AssetPickerSheet";
import { DriverPickerSheet } from "@/components/DriverPickerSheet";
import { BrokerEditSheet } from "@/components/BrokerEditSheet";
import { DateTimePickerSheet } from "@/components/DateTimePickerSheet";
import { StopEditSheet } from "@/components/StopEditSheet";
import { EditableStopCard } from "@/components/EditableStopCard";
import { txt } from "@/lib/font";
import type { Stop, StopType } from "@/lib/types";

type Stage = "pick" | "parsing" | "step1" | "step2" | "saving";

interface Draft {
  assetId:    number | null;
  driverId:   number | null;
  driverName: string | null;
  loadNum:    string;
  broker:     string;
  trailerType: string;
  start:      string;
  end:        string;
  loadPrice:  string;       // kept as string for entry
  driverPay:  string;
  specialInstructions: string;
}

const EMPTY: Draft = {
  assetId: null, driverId: null, driverName: null,
  loadNum: "", broker: "", trailerType: "",
  start: "", end: "",
  loadPrice: "", driverPay: "",
  specialInstructions: "",
};

function fmtFullDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function NewLoadScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { organization } = useOrganization();
  const { getToken } = useAuth();
  const { user } = useUser();
  const orgId = organization?.id;

  const [stage, setStage] = useState<Stage>("pick");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [stops, setStops] = useState<Stop[]>([]);
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
  // Tracks whether driverPay was auto-set from the configured percentage so we
  // know it's safe to recompute. Cleared the moment the user edits driverPay.
  const [driverPayAuto, setDriverPayAuto] = useState(true);
  const { pct: driverPayPct } = useDriverPayPct();

  // PDF rate-con (kept across stages so we can attach on save)
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string>("");

  const { data: assets = [] } = useQuery({
    queryKey: ["assets", orgId],
    queryFn:  () => fetchAssets(orgId!),
    enabled:  !!orgId,
    staleTime: 5 * 60 * 1000,
  });
  const visibleAssets = assets.filter((a) => !a.hidden);

  // Default to the org's "Unassigned" asset (matches web's convention) once
  // assets have loaded — saves the dispatcher a tap when the rate-con doesn't
  // specify a truck yet. Only kicks in when the form is still in its initial
  // empty state, so we don't blow away a user pick or a parse result.
  useEffect(() => {
    if (draft.assetId != null) return;
    const unassigned = assets.find((a) => a.name === "Unassigned" || a.type === "Unassigned");
    if (unassigned) setDraft((d) => ({ ...d, assetId: unassigned.id }));
  }, [assets, draft.assetId]);

  const { data: drivers = [] } = useQuery({
    queryKey: ["drivers", orgId],
    queryFn:  () => fetchDrivers(orgId!),
    enabled:  !!orgId,
    staleTime: 10 * 60 * 1000,
  });

  const { data: driverPrefs } = useQuery({
    queryKey: ["driver-asset-prefs", orgId],
    queryFn:  () => fetchDriverAssetPrefs(orgId!),
    enabled:  !!orgId,
    staleTime: 10 * 60 * 1000,
  });

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", orgId],
    queryFn:  () => fetchCustomers(orgId!),
    enabled:  !!orgId,
    staleTime: 10 * 60 * 1000,
  });
  const qc = useQueryClient();
  // Whether the parsed broker name lines up with any existing customer
  // (matches name, shortName, or any alias). Used to nudge the dispatcher
  // to add the customer when the AI extracted something brand new.
  const brokerMatchesCustomer = (() => {
    const q = draft.broker.trim().toLowerCase();
    if (!q) return true; // nothing to match yet — banner stays hidden
    return customers.some((c) => {
      if (c.name.toLowerCase() === q) return true;
      if ((c.shortName ?? "").toLowerCase() === q) return true;
      return c.aliases.some((a) => a.toLowerCase() === q);
    });
  })();

  async function addBrokerAsCustomer() {
    const name = draft.broker.trim();
    if (!name || !orgId) return;
    try {
      await railway.createCustomer({ name, aliases: [] });
      await qc.invalidateQueries({ queryKey: ["customers", orgId] });
    } catch (err) {
      Alert.alert("Couldn't add customer", err instanceof Error ? err.message : "Unknown error");
    }
  }

  // ── Sheet state ────────────────────────────────────────────────────────────
  const [assetPickerVisible,  setAssetPickerVisible]  = useState(false);
  const [driverPickerVisible, setDriverPickerVisible] = useState(false);
  const [brokerEditVisible,   setBrokerEditVisible]   = useState(false);
  const [scheduleOpen,        setScheduleOpen]        = useState(false);
  const [editingField, setEditingField] = useState<{
    title:   string;
    column:  keyof Draft;
    initial: string;
    kind:    EditFieldKind;
    transform?: (raw: string) => string;
  } | null>(null);

  // Stops sheet
  const [stopEditingIdx, setStopEditingIdx] = useState<number | null>(null);
  const [newStopIdx,     setNewStopIdx]     = useState<number | null>(null);

  function patch(p: Partial<Draft>) {
    setDraft((prev) => {
      let next = { ...prev, ...p };
      // If load price changed and driver pay is empty or auto-derived, recompute.
      // Skip when driverPay is also explicitly in this same patch (e.g. AI parse).
      if ("loadPrice" in p && !("driverPay" in p) && driverPayPct != null) {
        const lp = p.loadPrice ? parseFloat(p.loadPrice) : NaN;
        const dpEmptyOrAuto = !next.driverPay || driverPayAuto;
        if (Number.isFinite(lp) && lp > 0 && dpEmptyOrAuto) {
          const auto = Math.round(lp * (driverPayPct / 100) * 100) / 100;
          next = { ...next, driverPay: String(auto) };
          setDriverPayAuto(true);
        } else if (!Number.isFinite(lp) || lp <= 0) {
          if (driverPayAuto) next = { ...next, driverPay: "" };
        }
      }
      // If user edits driver pay manually, drop the auto flag.
      if ("driverPay" in p) {
        const fromAutoRecompute = "loadPrice" in p;
        if (!fromAutoRecompute) setDriverPayAuto(false);
      }
      return next;
    });
  }

  // ── AI parse path ─────────────────────────────────────────────────────────
  async function pickPdf() {
    if (!orgId) return;
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets[0]) return;
      const file = res.assets[0];
      const b64 = await FileSystem.readAsStringAsync(file.uri, { encoding: "base64" });
      setPdfBase64(b64);
      setPdfFileName(file.name);
      setStage("parsing");
      try {
        const result = await parseRateConViaApi(b64, getToken);
        if (result) applyParsed(result);
        setStage("step1");
      } catch (err) {
        Alert.alert("Couldn't parse", err instanceof Error ? err.message : "Unknown error");
        setStage("pick");
      }
    } catch (err) {
      Alert.alert("Couldn't pick file", err instanceof Error ? err.message : "Unknown error");
    }
  }

  function applyParsed(p: ParsedRateCon) {
    patch({
      loadNum:     p.loadNum     ?? "",
      broker:      p.broker      ?? "",
      trailerType: p.trailerType ?? "",
      start:       p.start       ?? "",
      end:         p.end         ?? "",
      loadPrice:   p.loadPrice != null ? String(p.loadPrice) : "",
      // driverPay parses through but the patch() recomputer auto-fills from
      // org pct when loadPrice is set and the AI didn't return one.
      driverPay:   p.driverPay != null ? String(p.driverPay) : "",
      // Legacy AI prompts may still emit `notes` — funnel into specialInstructions.
      specialInstructions: p.specialInstructions ?? p.notes ?? "",
    });
    if (p.stops?.length) {
      const next: Stop[] = p.stops.map((s, i) => ({
        id:           `tmp-${Date.now()}-${i}`,
        sequence:     s.sequence ?? i + 1,
        type:         (s.type as StopType) ?? "stop",
        facilityName: s.facilityName,
        address:      s.address,
        city:         s.city,
        // Server already geocoded — keep its coords/timezone if present.
        lat:          s.lat,
        lng:          s.lng,
        timezone:     s.timezone,
        apptStart:    s.apptStart,
        apptEnd:      s.apptEnd,
        instructions: s.instructions,
      }));
      setStops(next);
      // Fall back to client geocoding for any stop the server didn't resolve.
      void geocodeAll(next);
    }
  }

  /**
   * Geocodes every stop in `target` that has an address but no lat/lng.
   * Runs in parallel; updates state per-stop as each response arrives so the
   * "unverified" tag flips green on Step 2 in real time. Idempotent — safe to
   * call again as a "Verify all" button.
   */
  async function geocodeAll(target?: Stop[]) {
    const list = target ?? stops;
    const pending = list.filter((s) => {
      if (s.lat != null && s.lng != null) return false;
      return !!(s.address?.trim() || s.facilityName?.trim());
    });
    if (pending.length === 0) return;
    setVerifyingIds((prev) => {
      const n = new Set(prev);
      for (const s of pending) n.add(s.id);
      return n;
    });
    await Promise.all(pending.map(async (s) => {
      const addr = (s.address?.trim() || s.facilityName?.trim() || "");
      try {
        const r = await geocodeAddress(getToken, addr);
        if (r) {
          setStops((prev) => prev.map((p) => p.id === s.id
            ? { ...p, lat: r.lat, lng: r.lng, timezone: r.timezone ?? p.timezone }
            : p,
          ));
        }
      } catch { /* swallow — user can re-verify manually */ }
      finally {
        setVerifyingIds((prev) => { const n = new Set(prev); n.delete(s.id); return n; });
      }
    }));
  }

  // ── Stop helpers (step 2) ─────────────────────────────────────────────────
  function addStop() {
    const defaultType: StopType =
      stops.length === 0 ? "pickup"
      : stops.every((s) => s.type === "pickup") ? "delivery"
      : "stop";
    const newStop: Stop = {
      id:       `tmp-${Date.now()}`,
      sequence: stops.length + 1,
      type:     defaultType,
    };
    const next = [...stops, newStop];
    setStops(next);
    setNewStopIdx(next.length - 1);
    setStopEditingIdx(next.length - 1);
  }
  function moveStop(idx: number, dir: -1 | 1) {
    const t = idx + dir;
    if (t < 0 || t >= stops.length) return;
    const next = [...stops];
    [next[idx], next[t]] = [next[t], next[idx]];
    setStops(next);
  }
  function deleteStop(idx: number) {
    Alert.alert(
      "Delete stop?",
      "Remove this stop from the load.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () =>
          setStops((prev) => prev.filter((_, i) => i !== idx)),
        },
      ],
    );
  }
  function applyStopEdit(next: Stop) {
    setStops((prev) => {
      if (stopEditingIdx == null) return prev;
      const out = [...prev];
      out[stopEditingIdx] = next;
      return out;
    });
    setNewStopIdx(null);
    setStopEditingIdx(null);
  }
  function closeStopEdit() {
    if (newStopIdx != null && stopEditingIdx === newStopIdx) {
      setStops((prev) => prev.filter((_, i) => i !== newStopIdx));
      setNewStopIdx(null);
    }
    setStopEditingIdx(null);
  }

  // ── Step transitions ─────────────────────────────────────────────────────
  function goToStep2() {
    if (draft.assetId == null) { Alert.alert("Pick an asset", "Every load needs an asset assigned."); return; }
    if (!draft.start || !draft.end) { Alert.alert("Set times", "Start and end times are required."); return; }
    setStage("step2");
  }

  // Tracks the load# the dispatcher has acknowledged as a duplicate so a
  // second tap on Save proceeds without re-prompting.
  const [ackDupLoadNum, setAckDupLoadNum] = useState<string | null>(null);

  async function handleCreate() {
    if (!orgId || draft.assetId == null) return;
    if (!draft.start || !draft.end) return;

    // Duplicate-load# guard — searches the org's loads for an exact
    // loadNum match and prompts before creating another. Mirrors the web
    // app's behavior. Skipped when loadNum is empty or already acked.
    const loadNum = draft.loadNum.trim();
    if (loadNum && loadNum !== ackDupLoadNum) {
      const matches = await searchLoads(orgId, loadNum);
      const exact = matches.find((l) => (l.loadNum ?? "").trim() === loadNum);
      if (exact) {
        Alert.alert(
          "Duplicate load #",
          `Load #${loadNum} already exists. Create another with the same number?`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Create anyway",
              style: "destructive",
              onPress: () => { setAckDupLoadNum(loadNum); handleCreate(); },
            },
          ],
        );
        return;
      }
    }

    setStage("saving");
    try {
      // Auto-generate title from broker + first pickup-side stop. User can rename later.
      const firstStop = stops.find((s) => s.type === "pickup" || s.type === "stop") ?? stops[0];
      const stopLabel = firstStop?.facilityName ?? firstStop?.city ?? firstStop?.address ?? "New Load";
      const title    = draft.broker.trim()
        ? `${draft.broker.trim()}: ${stopLabel}`
        : stopLabel;

      let pdfPath: string | undefined;
      if (pdfBase64) {
        const path = await uploadRateConPdf({ orgId, base64: pdfBase64, fileName: pdfFileName });
        if (path) pdfPath = path;
      }

      const loadId = await createLoad({
        orgId,
        assetId:   draft.assetId,
        title,
        start:     draft.start,
        end:       draft.end,
        loadNum:   draft.loadNum.trim()    || undefined,
        broker:    draft.broker.trim()     || undefined,
        driverId:  draft.driverId,
        driverName: draft.driverName ?? undefined,
        loadPrice: draft.loadPrice ? parseFloat(draft.loadPrice) : undefined,
        driverPay: draft.driverPay ? parseFloat(draft.driverPay) : undefined,
        specialInstructions: draft.specialInstructions.trim() || undefined,
        rateConPdf:    pdfPath,
        createdByName: user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined,
      });

      if (!loadId) throw new Error("Couldn't create load");

      if (stops.length > 0) {
        await saveStops(loadId, orgId, stops);
      }

      router.replace({ pathname: "/load/[id]", params: { id: loadId } });
    } catch (err) {
      Alert.alert("Couldn't save", err instanceof Error ? err.message : "Unknown error");
      setStage("step2");
    }
  }

  // ── Lookups ───────────────────────────────────────────────────────────────
  const selectedAsset  = assets.find((a) => a.id === draft.assetId);
  const selectedDriver = drivers.find((d) => d.id === draft.driverId);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      {/* Nav bar */}
      <View style={{ backgroundColor: "#1a73e8", paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <TouchableOpacity onPress={() => stage === "step2" ? setStage("step1") : router.back()} activeOpacity={0.7}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}>
            <ArrowLeft size={18} color="#ffffff" strokeWidth={2.2} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={[txt(800), { fontSize: 16, color: "#ffffff" }]}>
              {stage === "pick"   ? "New Load"
              : stage === "step1" ? "Details"
              : stage === "step2" ? "Stops"
              : "New Load"}
            </Text>
            {stage === "step1" || stage === "step2" ? (
              <Text style={[txt(600), { fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 1 }]}>
                Step {stage === "step1" ? "1" : "2"} of 2
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {stage === "pick"     ? <PickStage onPickPdf={pickPdf} onManual={() => setStage("step1")} />
      : stage === "parsing" ? <ParsingStage />
      : stage === "step1"   ? (
        <Step1
          draft={draft}
          selectedAssetName={selectedAsset?.name}
          selectedDriverName={selectedDriver?.name ?? draft.driverName ?? null}
          brokerMatchesCustomer={brokerMatchesCustomer}
          onAddBrokerAsCustomer={addBrokerAsCustomer}
          onPickAsset={() => setAssetPickerVisible(true)}
          onPickDriver={() => setDriverPickerVisible(true)}
          onEditBroker={() => setBrokerEditVisible(true)}
          onEditDate={() => setScheduleOpen(true)}
          onEditField={(f) => setEditingField(f)}
        />
      )
      : stage === "step2"   ? (
        <Step2
          stops={stops}
          verifyingIds={verifyingIds}
          onAdd={addStop}
          onTap={(i) => setStopEditingIdx(i)}
          onMove={moveStop}
          onDelete={deleteStop}
          onVerifyAll={() => void geocodeAll()}
        />
      )
      : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color="#1a73e8" />
          <Text style={[txt(700), { fontSize: 14, color: "#3c4043", marginTop: 16 }]}>Creating load…</Text>
        </View>
      )}

      {/* Footer actions */}
      {stage === "step1" || stage === "step2" ? (
        <View style={{
          position: "absolute", left: 16, right: 16,
          bottom: insets.bottom + 12,
          flexDirection: "row", gap: 10,
        }}>
          <TouchableOpacity
            onPress={() => stage === "step2" ? setStage("step1") : router.back()}
            activeOpacity={0.7}
            style={{
              flex: 1, paddingVertical: 14, borderRadius: 14,
              backgroundColor: "#ffffff",
              borderWidth: 1, borderColor: "#e8eaed",
              alignItems: "center",
            }}
          >
            <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>
              {stage === "step2" ? "Back" : "Cancel"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => stage === "step1" ? goToStep2() : handleCreate()}
            activeOpacity={0.85}
            style={{
              flex: 2, paddingVertical: 14, borderRadius: 14,
              backgroundColor: "#1a73e8",
              alignItems: "center",
              flexDirection: "row", justifyContent: "center", gap: 8,
              shadowColor: "#1a73e8", shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
            }}
          >
            {stage === "step1" ? <ChevronRight size={15} color="#ffffff" strokeWidth={2.6} /> : <Check size={15} color="#ffffff" strokeWidth={2.6} />}
            <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
              {stage === "step1" ? "Next" : "Create Load"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Sheets */}
      {orgId ? (
        <AssetPickerSheet
          visible={assetPickerVisible}
          title="Select asset"
          assets={visibleAssets}
          onClose={() => setAssetPickerVisible(false)}
          onSelect={(a) => {
            setAssetPickerVisible(false);
            const next: Partial<Draft> = { assetId: a.id };
            // Auto-fill the asset's PRIMARY driver. Secondary stays a
            // reverse-lookup signal only (used in the driver picker
            // below to pre-fill the asset, not the other way around —
            // an asset's default driver is its primary).
            const prefId = driverPrefs?.primary?.[a.id];
            if (prefId != null) {
              const d = drivers.find((x) => x.id === prefId);
              if (d) { next.driverId = d.id; next.driverName = d.name; }
            }
            patch(next);
          }}
        />
      ) : null}

      {orgId ? (
        <DriverPickerSheet
          visible={driverPickerVisible}
          orgId={orgId}
          currentId={draft.driverId ?? undefined}
          onClose={() => setDriverPickerVisible(false)}
          onSelect={(driverId, driverName) => {
            setDriverPickerVisible(false);
            const next: Partial<Draft> = { driverId, driverName };
            // Reverse auto-fill — if this driver is the primary or
            // secondary preference on some asset, swap that asset in
            // even if one is already selected (common case:
            // reassigning a load to a different driver should bring
            // their truck along). Drivers with no asset preference
            // leave the asset slot untouched. Loop-safe because both
            // pickers fire synchronously on tap, no useEffect
            // watching either field.
            const primary   = driverPrefs?.primary   ?? {};
            const secondary = driverPrefs?.secondary ?? {};
            let targetAid: number | null = null;
            for (const [aidStr, did] of Object.entries(primary)) {
              if (did === driverId) { targetAid = Number(aidStr); break; }
            }
            if (targetAid == null) {
              for (const [aidStr, did] of Object.entries(secondary)) {
                if (did === driverId) { targetAid = Number(aidStr); break; }
              }
            }
            if (targetAid != null) next.assetId = targetAid;
            patch(next);
          }}
        />
      ) : null}

      {orgId ? (
        <BrokerEditSheet
          visible={brokerEditVisible}
          orgId={orgId}
          initial={draft.broker}
          onClose={() => setBrokerEditVisible(false)}
          onSave={(broker) => { setBrokerEditVisible(false); patch({ broker }); }}
        />
      ) : null}

      <DateTimePickerSheet
        visible={scheduleOpen}
        mode="range"
        title="Schedule"
        initialStart={draft.start}
        initialEnd={draft.end}
        onClose={() => setScheduleOpen(false)}
        onSave={(range) => {
          patch({ start: range.start, end: range.end });
          setScheduleOpen(false);
        }}
      />

      <EditFieldSheet
        visible={!!editingField}
        title={editingField?.title ?? ""}
        initial={editingField?.initial ?? ""}
        kind={editingField?.kind ?? "text"}
        onClose={() => setEditingField(null)}
        onSave={(raw) => {
          if (!editingField) return;
          const value = editingField.transform ? editingField.transform(raw) : raw;
          patch({ [editingField.column]: value } as Partial<Draft>);
          setEditingField(null);
        }}
      />

      {orgId ? (
        <StopEditSheet
          visible={stopEditingIdx !== null}
          orgId={orgId}
          stop={stopEditingIdx != null ? stops[stopEditingIdx] ?? null : null}
          onClose={closeStopEdit}
          onSave={applyStopEdit}
        />
      ) : null}
    </View>
  );
}

// ── Stage components ────────────────────────────────────────────────────────

function PickStage({ onPickPdf, onManual }: { onPickPdf: () => void; onManual: () => void }) {
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={[txt(800), { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", textTransform: "uppercase", marginBottom: 10 }]}>
        How do you want to start?
      </Text>

      <TouchableOpacity
        onPress={onPickPdf}
        activeOpacity={0.85}
        style={{
          backgroundColor: "#1a73e8", borderRadius: 16, padding: 18,
          flexDirection: "row", alignItems: "center", gap: 14,
          shadowColor: "#1a73e8", shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
        }}
      >
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" }}>
          <Sparkles size={22} color="#ffffff" strokeWidth={2.4} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[txt(800), { fontSize: 15, color: "#ffffff", letterSpacing: 0.2 }]}>
            Parse Rate Con (AI)
          </Text>
          <Text style={[txt(500), { fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 3 }]}>
            Upload a PDF — fields and stops pre-fill for review.
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onManual}
        activeOpacity={0.85}
        style={{
          marginTop: 12, backgroundColor: "#ffffff", borderRadius: 16, padding: 18,
          flexDirection: "row", alignItems: "center", gap: 14,
          borderWidth: 1, borderColor: "#e8eaed",
        }}
      >
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: "#f1f3f4", alignItems: "center", justifyContent: "center" }}>
          <FileText size={22} color="#3c4043" strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[txt(800), { fontSize: 15, color: "#202124" }]}>Create Manually</Text>
          <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 3 }]}>
            Fill in details, then add stops.
          </Text>
        </View>
      </TouchableOpacity>
    </ScrollView>
  );
}

function ParsingStage() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <ActivityIndicator size="large" color="#1a73e8" />
      <Text style={[txt(700), { fontSize: 14, color: "#3c4043", marginTop: 16 }]}>Reading rate con…</Text>
      <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
        AI is extracting load details. Hang tight.
      </Text>
      <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", marginTop: 18, textAlign: "center", maxWidth: 320, lineHeight: 16 }]}>
        AI can make mistakes — double-check broker, load #, prices, and stop addresses before saving.
      </Text>
    </View>
  );
}

// ── Step 1 — Details ──────────────────────────────────────────────────────────

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

function FormRow({
  Icon, label, value, onEdit, last, placeholder = "Tap to set",
}: {
  Icon: typeof Truck; label: string; value: string | null | undefined;
  onEdit: () => void; last?: boolean; placeholder?: string;
}) {
  const display = value && value.trim() ? value : placeholder;
  const empty   = !value || !value.trim();
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
          txt(700),
          {
            fontSize: 14,
            color: empty ? "#9aa0a6" : "#202124",
            maxWidth: "55%",
            textAlign: "right",
            marginRight: 8,
          },
        ]}
        numberOfLines={1}
      >
        {display}
      </Text>
      <Pencil size={13} color={empty ? "#9aa0a6" : "#1a73e8"} strokeWidth={2.4} />
    </TouchableOpacity>
  );
}

function Step1({
  draft, selectedAssetName, selectedDriverName,
  brokerMatchesCustomer, onAddBrokerAsCustomer,
  onPickAsset, onPickDriver, onEditBroker, onEditDate, onEditField,
}: {
  draft: Draft;
  selectedAssetName: string | undefined;
  selectedDriverName: string | null;
  brokerMatchesCustomer: boolean;
  onAddBrokerAsCustomer: () => void;
  onPickAsset:  () => void;
  onPickDriver: () => void;
  onEditBroker: () => void;
  onEditDate:   () => void;
  onEditField:  (f: { title: string; column: keyof Draft; initial: string; kind: EditFieldKind; transform?: (raw: string) => string }) => void;
}) {
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
      <SectionLabel>Schedule</SectionLabel>
      <Card>
        <FormRow Icon={Clock} label="Start"
          value={draft.start ? fmtFullDateTime(draft.start) : null}
          onEdit={onEditDate} />
        <FormRow Icon={Clock} label="End"
          value={draft.end ? fmtFullDateTime(draft.end) : null}
          onEdit={onEditDate} last />
      </Card>

      <SectionLabel>Operations</SectionLabel>
      <Card>
        <FormRow Icon={Truck} label="Asset"
          value={selectedAssetName ?? null}
          onEdit={onPickAsset} />
        <FormRow Icon={User} label="Driver"
          value={selectedDriverName}
          onEdit={onPickDriver} />
        <FormRow Icon={Building2} label="Broker"
          value={draft.broker || null}
          onEdit={onEditBroker} />
        <FormRow Icon={Box} label="Trailer Type"
          value={draft.trailerType || null}
          onEdit={() => onEditField({ title: "Trailer Type", column: "trailerType", initial: draft.trailerType, kind: "text", transform: (v) => v.trim() })}
          last />
      </Card>

      {!brokerMatchesCustomer && draft.broker.trim() ? (
        <TouchableOpacity
          onPress={() => Alert.alert(
            "Add to customers?",
            `'${draft.broker.trim()}' isn't in your customer list. Add it now?`,
            [
              { text: "Not now", style: "cancel" },
              { text: "Add", onPress: onAddBrokerAsCustomer },
            ],
          )}
          activeOpacity={0.7}
          style={{
            flexDirection: "row", alignItems: "center", gap: 10,
            backgroundColor: "#fef3c7", borderRadius: 12,
            borderWidth: 1, borderColor: "#fde68a",
            padding: 12, marginTop: 8,
          }}
        >
          <View style={{
            width: 28, height: 28, borderRadius: 8,
            backgroundColor: "#fff", alignItems: "center", justifyContent: "center",
            borderWidth: 1, borderColor: "#fde68a",
          }}>
            <Plus size={14} color="#92400e" strokeWidth={2.6} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[txt(800), { fontSize: 12, color: "#92400e" }]} numberOfLines={1}>
              Broker not in your customers
            </Text>
            <Text style={[txt(500), { fontSize: 11, color: "#92400e", marginTop: 1 }]} numberOfLines={1}>
              Tap to add &apos;{draft.broker.trim()}&apos;
            </Text>
          </View>
          <ChevronRight size={14} color="#92400e" strokeWidth={2.4} />
        </TouchableOpacity>
      ) : null}

      <SectionLabel>Reference</SectionLabel>
      <Card>
        <FormRow Icon={Hash} label="Load #"
          value={draft.loadNum || null}
          onEdit={() => onEditField({ title: "Load #", column: "loadNum", initial: draft.loadNum, kind: "text", transform: (v) => v.trim() })}
          last />
      </Card>

      <SectionLabel>Financial</SectionLabel>
      <Card>
        <FormRow Icon={DollarSign} label="Load Price"
          value={draft.loadPrice ? `$${parseFloat(draft.loadPrice).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null}
          onEdit={() => onEditField({ title: "Load Price", column: "loadPrice", initial: draft.loadPrice, kind: "number" })} />
        <FormRow Icon={DollarSign} label="Driver Pay"
          value={draft.driverPay ? `$${parseFloat(draft.driverPay).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null}
          onEdit={() => onEditField({ title: "Driver Pay", column: "driverPay", initial: draft.driverPay, kind: "number" })}
          last />
      </Card>

      <SectionLabel>Special Instructions</SectionLabel>
      <TouchableOpacity
        onPress={() => onEditField({ title: "Special Instructions", column: "specialInstructions", initial: draft.specialInstructions, kind: "multiline", transform: (v) => v.trim() })}
        activeOpacity={0.7}
        style={{
          backgroundColor: "#fef3c7", borderRadius: 12, padding: 12,
          borderWidth: 1, borderColor: "#fde68a",
          flexDirection: "row", alignItems: "flex-start", gap: 8,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={[txt(800), { fontSize: 11, color: "#92400e", letterSpacing: 0.4, marginBottom: 4 }]}>
            SPECIAL INSTRUCTIONS
          </Text>
          <Text style={[txt(600), { fontSize: 13, color: draft.specialInstructions ? "#92400e" : "#9aa0a6", lineHeight: 18 }]}>
            {draft.specialInstructions || "Tap to add"}
          </Text>
        </View>
        <Pencil size={13} color="#92400e" strokeWidth={2.4} style={{ marginTop: 2 }} />
      </TouchableOpacity>
    </ScrollView>
  );
}

// ── Step 2 — Stops ────────────────────────────────────────────────────────────

function Step2({
  stops, verifyingIds, onAdd, onTap, onMove, onDelete, onVerifyAll,
}: {
  stops: Stop[];
  verifyingIds: Set<string>;
  onAdd: () => void;
  onTap: (i: number) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onDelete: (i: number) => void;
  onVerifyAll: () => void;
}) {
  const verifyingCount = verifyingIds.size;
  const unverifiedCount = stops.filter((s) =>
    (s.lat == null || s.lng == null) && !!(s.address?.trim() || s.facilityName?.trim()),
  ).length;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
      {verifyingCount > 0 ? (
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 8,
          paddingHorizontal: 12, paddingVertical: 10,
          backgroundColor: "#e8f0fe", borderRadius: 12,
          borderWidth: 1, borderColor: "#bfdbfe",
          marginBottom: 10,
        }}>
          <ActivityIndicator size="small" color="#1a73e8" />
          <Text style={[txt(700), { fontSize: 12, color: "#1a73e8", flex: 1 }]}>
            Verifying {verifyingCount} {verifyingCount === 1 ? "stop" : "stops"}…
          </Text>
        </View>
      ) : unverifiedCount > 0 ? (
        <TouchableOpacity
          onPress={onVerifyAll}
          activeOpacity={0.7}
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
            paddingVertical: 10, borderRadius: 12,
            backgroundColor: "#fef3c7",
            borderWidth: 1, borderColor: "#fde68a",
            marginBottom: 10,
          }}
        >
          <Text style={[txt(800), { fontSize: 12, color: "#92400e", letterSpacing: 0.3 }]}>
            Verify {unverifiedCount} unverified {unverifiedCount === 1 ? "stop" : "stops"}
          </Text>
        </TouchableOpacity>
      ) : null}

      {stops.length === 0 ? (
        <Text style={[txt(500), { fontSize: 13, color: "#9aa0a6", textAlign: "center", marginVertical: 30 }]}>
          No stops yet. Tap &quot;Add stop&quot; to begin.
        </Text>
      ) : stops.map((stop, i) => (
        <EditableStopCard
          key={stop.id}
          stop={stop}
          index={i}
          isFirst={i === 0}
          isLast={i === stops.length - 1}
          verifying={verifyingIds.has(stop.id)}
          onTap={() => onTap(i)}
          onUp={() => onMove(i, -1)}
          onDown={() => onMove(i, 1)}
          onDelete={() => onDelete(i)}
        />
      ))}

      <TouchableOpacity
        onPress={onAdd}
        activeOpacity={0.7}
        style={{
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
          paddingVertical: 14, borderRadius: 14,
          backgroundColor: "#ffffff",
          borderWidth: 1, borderColor: "#bfdbfe",
          borderStyle: "dashed",
          marginTop: 4,
        }}
      >
        <Plus size={15} color="#1a73e8" strokeWidth={2.6} />
        <Text style={[txt(800), { fontSize: 13, color: "#1a73e8", letterSpacing: 0.3 }]}>
          Add stop
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
