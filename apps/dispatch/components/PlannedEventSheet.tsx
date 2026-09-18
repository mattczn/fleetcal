import React, { useMemo, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ScrollView, TextInput,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { X, Search, Clock, MoveRight, Truck, User, CalendarRange, Link2, Plus, Trash2 } from "lucide-react-native";
import {
  PLANNED_PURPOSES, PLANNED_PURPOSE_LABEL,
  type PlannedEvent, type PlannedPurpose,
} from "@fleetcal/types";
import { txt } from "@/lib/font";
import { railway } from "@/lib/railway";
import { fetchLoadsForDay } from "@/lib/api";
import { PLANNED_QUERY_KEY } from "@/lib/planned";
import type { Asset } from "@/lib/types";
import { AssetPickerSheet } from "./AssetPickerSheet";
import { DriverPickerSheet } from "./DriverPickerSheet";
import { DateTimePickerSheet } from "./DateTimePickerSheet";

const ACCENT = "#475569";

const PURPOSE_ICON: Record<PlannedPurpose, typeof Search> = {
  find_load:     Search,
  expected_load: Clock,
  reposition:    MoveRight,
};

const TITLE_PLACEHOLDER: Record<PlannedPurpose, string> = {
  find_load:     "SLC → Vegas",
  expected_load: "ITS National · Spanish Fork → SLC",
  reposition:    "Empty to Vegas for Monday pickup",
};

export type PlanSheetState =
  | { mode: "create"; defaults: { assetId?: number; start: string; end: string } }
  | { mode: "edit"; plan: PlannedEvent };

interface Props {
  state:   PlanSheetState | null;
  orgId:   string;
  assets:  Asset[];
  onClose: () => void;
}

function fmtWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Create / edit a planned placeholder on FleetCal Go. Keyed by the
 * caller per plan, so the form seeds once from props.
 */
export function PlannedEventSheet({ state, orgId, assets, onClose }: Props) {
  if (!state) return null;
  const key = state.mode === "edit" ? `edit:${state.plan.id}` : `create:${state.defaults.assetId ?? ""}:${state.defaults.start}`;
  return <PlanSheetBody key={key} state={state} orgId={orgId} assets={assets} onClose={onClose} />;
}

function PlanSheetBody({ state, orgId, assets, onClose }: Props & { state: PlanSheetState }) {
  const router = useRouter();
  const qc = useQueryClient();
  const editing = state.mode === "edit" ? state.plan : null;
  const seed: Pick<PlannedEvent, "purpose" | "title" | "start" | "end" | "notes" | "driverId" | "driverName"> & { assetId?: number } =
    state.mode === "edit"
      ? state.plan
      : { ...state.defaults, purpose: "find_load", title: "" };

  const [purpose,    setPurpose]    = useState<PlannedPurpose>(seed.purpose);
  const [title,      setTitle]      = useState(seed.title);
  const [assetId,    setAssetId]    = useState<number | null>(seed.assetId ?? null);
  const [driverId,   setDriverId]   = useState<number | null>(seed.driverId ?? null);
  const [driverName, setDriverName] = useState<string | null>(seed.driverName ?? null);
  const [start,      setStart]      = useState(seed.start);
  const [end,        setEnd]        = useState(seed.end);
  const [notes,      setNotes]      = useState(seed.notes ?? "");
  const [busy,       setBusy]       = useState(false);
  const [picker,     setPicker]     = useState<null | "asset" | "driver" | "time">(null);
  const [showAttach, setShowAttach] = useState(false);

  const asset = assets.find((a) => a.id === assetId) ?? null;
  const truckOptions = useMemo(
    () => assets.filter((a) => !a.hidden && a.type !== "Unassigned" && a.name !== "Unassigned"),
    [assets],
  );

  // Loads on this truck on the plan's start and end days — the attach
  // picker's candidates. Only fetched once the picker is opened.
  const { data: candidates = [], isFetching: candidatesLoading } = useQuery({
    queryKey: ["plan-attach-candidates", orgId, editing?.id],
    enabled:  !!editing && showAttach,
    queryFn:  async () => {
      if (!editing) return [];
      const days = Array.from(new Set([editing.start.slice(0, 10), editing.end.slice(0, 10)]));
      const lists = await Promise.all(days.map((d) => fetchLoadsForDay(orgId, d)));
      const seen = new Set<string>();
      return lists.flat().filter((l) => {
        if (l.assetId !== editing.assetId || !l.loadId || l.eventKind === "non_revenue") return false;
        if (seen.has(l.loadId)) return false;
        seen.add(l.loadId);
        return true;
      });
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: [PLANNED_QUERY_KEY] });

  async function save() {
    if (!title.trim()) { Alert.alert("Add a title", "What you're looking for, e.g. “SLC → Vegas”."); return; }
    if (assetId == null) { Alert.alert("Pick a truck"); return; }
    if (!start || !end || end <= start) { Alert.alert("Check the times", "End has to be after start."); return; }
    setBusy(true);
    const body = { assetId, driverId, purpose, title: title.trim(), notes: notes.trim() || null, start, end };
    try {
      if (editing) await railway.updatePlannedEvent(editing.id, body);
      else await railway.createPlannedEvent(body);
      await refresh();
      onClose();
    } catch (err) {
      Alert.alert("Plan didn't save", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    if (!editing) return;
    Alert.alert("Delete this plan?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        setBusy(true);
        try {
          await railway.deletePlannedEvent(editing.id);
          await refresh();
          onClose();
        } catch (err) {
          Alert.alert("Plan wasn't deleted", err instanceof Error ? err.message : "Unknown error");
        } finally {
          setBusy(false);
        }
      } },
    ]);
  }

  async function attach(loadId: string) {
    if (!editing) return;
    setBusy(true);
    try {
      await railway.attachPlannedEvent(editing.id, loadId);
      await refresh();
      onClose();
    } catch (err) {
      Alert.alert("Couldn't attach the load", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  function createLoadFromPlan() {
    if (!editing) return;
    onClose();
    router.push({
      pathname: "/new-load",
      params: {
        planId: editing.id,
        assetId: String(editing.assetId),
        start: editing.start,
        end: editing.end,
        ...(editing.driverId != null ? { driverId: String(editing.driverId), driverName: editing.driverName ?? "" } : {}),
      },
    });
  }

  const row = (icon: React.ReactNode, label: string, value: string, onPress: () => void) => (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#f1f3f4" }}>
      {icon}
      <Text style={[txt(600), { fontSize: 12, color: "#5f6368", width: 64 }]}>{label}</Text>
      <Text style={[txt(700), { fontSize: 14, color: "#202124", flex: 1 }]} numberOfLines={1}>{value}</Text>
    </TouchableOpacity>
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={busy ? undefined : onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)" }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, justifyContent: "flex-end" }}>
          <Pressable onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: "#ffffff", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "90%", paddingBottom: 28, paddingTop: 8 }}>
            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#f1f3f4" }}>
              <View style={{ width: 32, height: 32, borderRadius: 8, borderWidth: 1.5, borderStyle: "dashed", borderColor: ACCENT, alignItems: "center", justifyContent: "center" }}>
                <CalendarRange size={16} color={ACCENT} strokeWidth={2.2} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[txt(800), { fontSize: 16, color: "#202124" }]}>{editing ? "Edit plan" : "New plan"}</Text>
                <Text style={[txt(500), { fontSize: 11, color: "#5f6368" }]}>
                  {editing?.expired ? "Expired — 24h past its end with no load attached" : "Drivers don't see plans"}
                </Text>
              </View>
              <TouchableOpacity onPress={onClose} hitSlop={10} disabled={busy}>
                <X size={20} color="#5f6368" strokeWidth={2.2} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, gap: 14 }} keyboardShouldPersistTaps="handled">
              {/* Purpose */}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {PLANNED_PURPOSES.map((p) => {
                  const Icon = PURPOSE_ICON[p];
                  const active = p === purpose;
                  return (
                    <TouchableOpacity key={p} onPress={() => setPurpose(p)} activeOpacity={0.8}
                      style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: active ? ACCENT : "#f1f3f4" }}>
                      <Icon size={13} color={active ? "#ffffff" : "#3c4043"} strokeWidth={2.4} />
                      <Text style={[txt(700), { fontSize: 12, color: active ? "#ffffff" : "#3c4043" }]}>{PLANNED_PURPOSE_LABEL[p]}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Title */}
              <TextInput value={title} onChangeText={setTitle} placeholder={TITLE_PLACEHOLDER[purpose]} placeholderTextColor="#9aa0a6"
                style={[txt(700), { fontSize: 15, color: "#202124", borderWidth: 1, borderColor: "#dadce0", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 }]} />

              <View>
                {row(<Truck size={16} color={asset?.color ?? "#5f6368"} strokeWidth={2.2} />, "Truck", asset?.name ?? "Select truck", () => setPicker("asset"))}
                {row(<User size={16} color="#5f6368" strokeWidth={2.2} />, "Driver", driverName ?? "No driver", () => setPicker("driver"))}
                {row(<Clock size={16} color="#5f6368" strokeWidth={2.2} />, "When", `${fmtWhen(start)} → ${fmtWhen(end)}`, () => setPicker("time"))}
                {driverId != null ? (
                  <TouchableOpacity onPress={() => { setDriverId(null); setDriverName(null); }} style={{ paddingTop: 6 }}>
                    <Text style={[txt(600), { fontSize: 12, color: "#5f6368" }]}>Clear driver</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              {/* Notes */}
              <TextInput value={notes} onChangeText={setNotes} multiline placeholder="Min $600 · Julio can pre-load Friday"
                placeholderTextColor="#9aa0a6"
                style={[txt(500), { fontSize: 14, color: "#202124", minHeight: 70, textAlignVertical: "top", borderWidth: 1, borderColor: "#dadce0", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 }]} />

              {editing ? (
                <View style={{ borderWidth: 1, borderColor: "#e8eaed", borderRadius: 12, padding: 12, gap: 8, backgroundColor: "#f8f9fa" }}>
                  <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]}>Turn this plan into a load</Text>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    <TouchableOpacity onPress={() => setShowAttach((v) => !v)} disabled={busy}
                      style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: ACCENT, backgroundColor: "#ffffff" }}>
                      <Link2 size={13} color={ACCENT} strokeWidth={2.4} />
                      <Text style={[txt(700), { fontSize: 12, color: ACCENT }]}>Attach existing load</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={createLoadFromPlan} disabled={busy}
                      style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: ACCENT, backgroundColor: "#ffffff" }}>
                      <Plus size={13} color={ACCENT} strokeWidth={2.4} />
                      <Text style={[txt(700), { fontSize: 12, color: ACCENT }]}>Create load from plan</Text>
                    </TouchableOpacity>
                  </View>
                  {showAttach ? (
                    candidatesLoading ? <ActivityIndicator color={ACCENT} /> :
                    candidates.length === 0 ? (
                      <Text style={[txt(500), { fontSize: 12, color: "#80868b" }]}>No loads on this truck on the plan's days.</Text>
                    ) : candidates.map((l) => (
                      <TouchableOpacity key={l.loadId} onPress={() => attach(l.loadId!)} disabled={busy}
                        style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: "#dadce0", backgroundColor: "#ffffff" }}>
                        <Text style={[txt(700), { fontSize: 13, color: "#202124" }]} numberOfLines={1}>{l.title}</Text>
                        <Text style={[txt(500), { fontSize: 11, color: "#5f6368" }]}>{fmtWhen(l.start)} → {fmtWhen(l.end)}</Text>
                      </TouchableOpacity>
                    ))
                  ) : null}
                </View>
              ) : null}

              {editing?.createdByName ? (
                <Text style={[txt(500), { fontSize: 11, color: "#80868b" }]}>Planned by {editing.createdByName}</Text>
              ) : null}

              {/* Actions */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 4 }}>
                {editing ? (
                  <TouchableOpacity onPress={remove} disabled={busy} style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 10 }}>
                    <Trash2 size={15} color="#d93025" strokeWidth={2.2} />
                    <Text style={[txt(700), { fontSize: 14, color: "#d93025" }]}>Delete</Text>
                  </TouchableOpacity>
                ) : null}
                <View style={{ flex: 1 }} />
                <TouchableOpacity onPress={save} disabled={busy}
                  style={{ paddingHorizontal: 20, paddingVertical: 11, borderRadius: 10, backgroundColor: ACCENT, opacity: busy ? 0.6 : 1 }}>
                  <Text style={[txt(800), { fontSize: 14, color: "#ffffff" }]}>{busy ? "Saving…" : editing ? "Save plan" : "Add plan"}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>

            <AssetPickerSheet visible={picker === "asset"} title="Select truck" assets={truckOptions}
              onClose={() => setPicker(null)} onSelect={(a) => { setAssetId(a.id); setPicker(null); }} />
            <DriverPickerSheet visible={picker === "driver"} orgId={orgId} currentId={driverId ?? undefined}
              onClose={() => setPicker(null)}
              onSelect={(id, name) => { setDriverId(id); setDriverName(name); setPicker(null); }} />
            <DateTimePickerSheet visible={picker === "time"} mode="range" title="Plan window"
              initialStart={start} initialEnd={end}
              onClose={() => setPicker(null)}
              onSave={(r) => { setStart(r.start); setEnd(r.end); setPicker(null); }} />
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
