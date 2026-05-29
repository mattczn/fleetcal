/**
 * Bottom-sheet editor for a maintenance action item (work order).
 *
 * Three modes the parent passes in:
 *   - "create":  blank form. Submit calls createMaintenanceActionItem.
 *   - "edit":    pre-filled from an existing item. Submit PATCHes.
 *   - "convert": pre-filled from a driver report. Submit POSTs
 *                /maintenance-reports/:id/convert.
 *
 * Designed for one-handed phone use:
 *   - Big-touch status row at the top so brother can flip Open → In
 *     Progress → Done without opening a separate picker.
 *   - Vendor + Total cost sit on the same line near the top — those are
 *     the fields he most often fills in at a shop.
 *   - Photo upload uses an action sheet (Take Photo / Choose from
 *     Library) so the camera is one tap away when standing next to the
 *     truck.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, TextInput, ScrollView,
  Alert, ActivityIndicator, Image, ActionSheetIOS, Platform,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { X, Plus, Trash2, Camera, CalendarDays, Truck, Container, CalendarClock } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import type {
  MaintenanceActionItem, MaintenanceActionStatus,
  MaintenancePriority, MaintenanceReport,
  Asset, Trailer,
} from "@fleetcal/types";
import { txt } from "@/lib/font";
import { railway } from "@/lib/railway";
import {
  STATUS_COLORS, PRIORITY_COLORS, fmtCost, fmtScheduledDate,
} from "@/lib/maintenanceUI";
import { DatePickerModal } from "./DatePickerModal";
import { DateTimePickerSheet } from "./DateTimePickerSheet";
import { AssetPickerSheet } from "./AssetPickerSheet";
import { TrailerPickerSheet } from "./TrailerPickerSheet";

export type ItemSheetMode =
  | { kind: "create" }
  | { kind: "edit";    item: MaintenanceActionItem }
  | { kind: "convert"; report: MaintenanceReport };

interface Props {
  visible: boolean;
  mode:    ItemSheetMode;
  /** Used to render asset / trailer names on the chips — TrailerPicker
   *  fetches its own list, but we still need the local data to show
   *  the currently-selected trailer's name without a second round-trip. */
  assets:    Asset[];
  trailers:  Trailer[];
  /** Org id is required by TrailerPickerSheet (it does its own fetch). */
  orgId:     string;
  onClose:   () => void;
  /** Notify the parent we mutated something so it can invalidate queries. */
  onMutated: () => void;
}

const STATUS_OPTIONS: MaintenanceActionStatus[] = ["open", "in_progress", "done"];
const PRIORITY_OPTIONS: MaintenancePriority[] = ["urgent", "high", "normal", "low"];

export function MaintenanceItemSheet({
  visible, mode, assets, trailers, orgId, onClose, onMutated,
}: Props) {
  const qc = useQueryClient();

  // ── Form state — initialized per-mode below ─────────────────────────
  const initial = useMemo(() => {
    if (mode.kind === "edit") {
      const i = mode.item;
      return {
        title:         i.title,
        description:   i.description ?? "",
        status:        i.status,
        priority:      i.priority,
        assetId:       i.assetId   ?? null,
        trailerId:     i.trailerId ?? null,
        scheduledDate: i.scheduledDate ?? null,
        vendor:        i.vendor ?? "",
        actualCost:   i.actualCost != null ? String(i.actualCost) : "",
      };
    }
    if (mode.kind === "convert") {
      const r = mode.report;
      // Title seeded from the driver's description (first ~60 chars).
      // Brother almost always wants to rewrite it; this is just a hint.
      const titleSeed = r.description.length > 60
        ? r.description.slice(0, 57).trim() + "…"
        : r.description.trim();
      return {
        title:         titleSeed || "Maintenance",
        description:   r.description,
        status:        "open" as MaintenanceActionStatus,
        priority:      "normal" as MaintenancePriority,
        assetId:       r.assetId   ?? null,
        trailerId:     r.trailerId ?? null,
        scheduledDate: null as string | null,
        vendor:        "",
        actualCost:    "",
      };
    }
    return {
      title:         "",
      description:   "",
      status:        "open" as MaintenanceActionStatus,
      priority:      "normal" as MaintenancePriority,
      assetId:       null as number | null,
      trailerId:     null as number | null,
      scheduledDate: null as string | null,
      vendor:        "",
      actualCost:    "",
    };
  }, [mode]);

  const [title,         setTitle]         = useState(initial.title);
  const [description,   setDescription]   = useState(initial.description);
  const [status,        setStatus]        = useState<MaintenanceActionStatus>(initial.status);
  const [priority,      setPriority]      = useState<MaintenancePriority>(initial.priority);
  const [assetId,       setAssetId]       = useState<number | null>(initial.assetId);
  const [trailerId,     setTrailerId]     = useState<number | null>(initial.trailerId);
  const [scheduledDate, setScheduledDate] = useState<string | null>(initial.scheduledDate);
  const [vendor,        setVendor]        = useState(initial.vendor);
  const [actualCost,    setActualCost]    = useState(initial.actualCost);

  // Reset state when the sheet opens with a different mode/item.
  useEffect(() => {
    if (!visible) return;
    setTitle(initial.title);
    setDescription(initial.description);
    setStatus(initial.status);
    setPriority(initial.priority);
    setAssetId(initial.assetId);
    setTrailerId(initial.trailerId);
    setScheduledDate(initial.scheduledDate);
    setVendor(initial.vendor);
    setActualCost(initial.actualCost);
  }, [visible, initial]);

  // ── Sub-sheet state ─────────────────────────────────────────────────
  const [dateOpen, setDateOpen] = useState(false);
  const [truckPickerOpen,   setTruckPickerOpen]   = useState(false);
  const [trailerPickerOpen, setTrailerPickerOpen] = useState(false);
  const [calendarBlockOpen, setCalendarBlockOpen] = useState(false);
  const [savingBlock, setSavingBlock] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [uploading, setUploading] = useState(false);

  // Newly-created event links from this sheet session, kept locally so
  // the chip shows up the instant we add a block — the parent's query
  // refetch lags by one render. Reset every time the sheet reopens.
  const [sessionLinks, setSessionLinks] = useState<Array<{ id: string; start: string }>>([]);
  useEffect(() => { if (visible) setSessionLinks([]); }, [visible]);

  const selectedAsset   = assets.find((a) => a.id === assetId)   ?? null;
  const selectedTrailer = trailers.find((t) => t.id === trailerId) ?? null;

  // Linked report photos — read-only in edit mode when the WO was
  // converted from a driver report.
  const linkedReportId = mode.kind === "edit" ? mode.item.reportId : undefined;
  const wOPhotos       = mode.kind === "edit" ? (mode.item.photos ?? []) : [];

  // Linked calendar events — denormalized on the WO by the server
  // (linkedEvents). Merge with session-local newly-created ones so the
  // UI reflects the latest state without waiting for a refetch.
  const persistedLinks =
    mode.kind === "edit" ? (mode.item.linkedEvents ?? []) : [];
  const allLinkedEvents = useMemo(() => {
    const map = new Map<string, { id: string; start: string }>();
    for (const e of persistedLinks) map.set(e.id, e);
    for (const e of sessionLinks)   map.set(e.id, e);
    return Array.from(map.values()).sort((a, b) => a.start.localeCompare(b.start));
  }, [persistedLinks, sessionLinks]);

  // ── Submit handler ──────────────────────────────────────────────────
  async function handleSave() {
    if (!title.trim()) {
      Alert.alert("Title required", "Give this work order a short title.");
      return;
    }
    if (assetId == null && trailerId == null) {
      Alert.alert("Equipment required", "Pick the truck or trailer this work order is for.");
      return;
    }
    setSaving(true);
    try {
      const costNum = actualCost.trim() ? Number(actualCost.replace(/[^0-9.]/g, "")) : null;
      const payload = {
        title:         title.trim(),
        description:   description.trim() || undefined,
        status,
        priority,
        category:      "repair" as const, // mobile MVP — full category picker lives in web
        assetId:       assetId ?? undefined,
        trailerId:     trailerId ?? undefined,
        scheduledDate: scheduledDate ?? undefined,
        vendor:        vendor.trim() || undefined,
        actualCost:    costNum ?? undefined,
      };

      if (mode.kind === "edit") {
        await railway.updateMaintenanceActionItem(mode.item.id, payload);
      } else if (mode.kind === "convert") {
        await railway.convertMaintenanceReport(mode.report.id, payload);
      } else {
        await railway.createMaintenanceActionItem(payload);
      }
      onMutated();
      onClose();
    } catch (err) {
      console.error("save WO:", err);
      Alert.alert("Save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (mode.kind !== "edit") return;
    Alert.alert("Delete work order?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          try {
            await railway.deleteMaintenanceActionItem(mode.item.id);
            onMutated();
            onClose();
          } catch (err) {
            console.error("delete WO:", err);
            Alert.alert("Delete failed", err instanceof Error ? err.message : "Unknown error");
          }
        },
      },
    ]);
  }

  // ── Calendar block flow ─────────────────────────────────────────────
  //
  // Create a non-revenue event on the WO's truck, then PATCH the WO
  // with the new event id added to its `eventIds`. Skipped when the WO
  // is for a trailer-only (the system blocks trucks on the calendar,
  // not trailers).
  async function handleSaveCalendarBlock(range: { start: string; end: string }) {
    if (mode.kind !== "edit") return;
    if (assetId == null) {
      Alert.alert("Pick a truck first", "Maintenance events block a truck on the calendar.");
      return;
    }
    setSavingBlock(true);
    try {
      const res = await railway.createEvent({
        title:          title.trim() || mode.item.title,
        start:          range.start,
        end:            range.end,
        assetId,
        nonRevenueType: "Maintenance",
      });
      const newEventId = res.loads?.[0]?.id;
      if (!newEventId) throw new Error("Server didn't return a new event id");

      const existingIds = (mode.item.linkedEvents ?? []).map((e) => e.id);
      const nextIds     = Array.from(new Set([...existingIds, newEventId]));
      await railway.updateMaintenanceActionItem(mode.item.id, { eventIds: nextIds });

      // Optimistically reflect the new link in this sheet before the
      // parent refetches.
      setSessionLinks((prev) => [...prev, { id: newEventId, start: range.start }]);
      onMutated();
      // Bust calendar caches too so the new event shows up immediately
      // when brother flips back to the calendar tab.
      await qc.invalidateQueries({ queryKey: ["loads"] });
      setCalendarBlockOpen(false);
    } catch (err) {
      console.error("create calendar block:", err);
      Alert.alert("Failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSavingBlock(false);
    }
  }

  // ── Photo flow ──────────────────────────────────────────────────────
  function presentPhotoChoice() {
    if (mode.kind !== "edit") {
      Alert.alert("Save first", "Save the work order before attaching photos.");
      return;
    }
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Take Photo", "Choose from Library"],
          cancelButtonIndex: 0,
        },
        (idx) => {
          if (idx === 1) pickPhoto("camera");
          if (idx === 2) pickPhoto("library");
        },
      );
    } else {
      // Android: simple two-button alert. Production could use a custom
      // bottom sheet but Alert keeps the dep footprint flat.
      Alert.alert("Add a photo", undefined, [
        { text: "Take Photo",         onPress: () => pickPhoto("camera") },
        { text: "Choose from Library", onPress: () => pickPhoto("library") },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }

  async function pickPhoto(source: "camera" | "library") {
    if (mode.kind !== "edit") return;
    try {
      const perm = source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", `Allow ${source === "camera" ? "camera" : "photo library"} access in Settings to attach photos.`);
        return;
      }
      const res = source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 0.8, mediaTypes: ImagePicker.MediaTypeOptions.Images })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.8, mediaTypes: ImagePicker.MediaTypeOptions.Images });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      setUploading(true);
      const name = a.fileName ?? `photo-${Date.now()}.jpg`;
      const type = a.mimeType  ?? "image/jpeg";
      await railway.uploadMaintenanceActionItemPhoto(mode.item.id, a.uri, name, type);
      onMutated();
      // Re-fetch the item so we get the new photo signed URL.
      await qc.invalidateQueries({ queryKey: ["maintenance-action-items"] });
    } catch (err) {
      console.error("upload photo:", err);
      Alert.alert("Upload failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setUploading(false);
    }
  }

  async function deletePhoto(photoId: string) {
    Alert.alert("Delete photo?", "", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          try {
            await railway.deleteMaintenanceActionItemPhoto(photoId);
            onMutated();
            await qc.invalidateQueries({ queryKey: ["maintenance-action-items"] });
          } catch (err) {
            console.error("delete photo:", err);
          }
        },
      },
    ]);
  }

  // ── Render ──────────────────────────────────────────────────────────
  const headerTitle =
    mode.kind === "create"  ? "New Work Order" :
    mode.kind === "convert" ? "Convert to Work Order" :
                              "Work Order";
  const submitLabel =
    mode.kind === "create"  ? "Create" :
    mode.kind === "convert" ? "Create Work Order" :
                              "Save";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            height: "90%",
            paddingTop: 8,
          }}
        >
          {/* Header */}
          <View style={{
            flexDirection: "row", alignItems: "center",
            paddingHorizontal: 18, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
          }}>
            <Text style={[txt(800), { fontSize: 17, color: "#202124", flex: 1 }]}>
              {headerTitle}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
            keyboardShouldPersistTaps="handled"
          >
            {/* Status row — only in edit mode (create starts at open) */}
            {mode.kind !== "create" ? (
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 18 }}>
                {STATUS_OPTIONS.map((s) => {
                  const c = STATUS_COLORS[s];
                  const active = status === s;
                  return (
                    <TouchableOpacity
                      key={s}
                      onPress={() => setStatus(s)}
                      activeOpacity={0.85}
                      style={{
                        flex: 1, paddingVertical: 11,
                        backgroundColor: active ? c.bg : "#ffffff",
                        borderWidth: 1, borderColor: active ? c.fg : "#e8eaed",
                        borderRadius: 10,
                        alignItems: "center",
                      }}
                    >
                      <Text style={[txt(800), {
                        fontSize: 11, color: active ? c.fg : "#5f6368",
                        letterSpacing: 0.3,
                      }]}>
                        {c.label.toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}

            {/* Title */}
            <Label>Title</Label>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="What needs to be done?"
              placeholderTextColor="#9aa0a6"
              style={inputStyle}
            />

            {/* Equipment picker — truck OR trailer */}
            <Label>Equipment</Label>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
              <TouchableOpacity
                onPress={() => { setTrailerId(null); setTruckPickerOpen(true); }}
                activeOpacity={0.8}
                style={{
                  flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
                  paddingHorizontal: 12, paddingVertical: 12,
                  borderWidth: 1, borderColor: selectedAsset ? "#1a73e8" : "#e8eaed",
                  backgroundColor: selectedAsset ? "#e8f0fe" : "#ffffff",
                  borderRadius: 10,
                }}
              >
                <Truck size={16} color={selectedAsset ? "#1967d2" : "#5f6368"} strokeWidth={2.2} />
                <Text
                  style={[txt(700), { fontSize: 13, color: selectedAsset ? "#1967d2" : "#5f6368", flex: 1 }]}
                  numberOfLines={1}
                >
                  {selectedAsset ? selectedAsset.name : "Truck"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setAssetId(null); setTrailerPickerOpen(true); }}
                activeOpacity={0.8}
                style={{
                  flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
                  paddingHorizontal: 12, paddingVertical: 12,
                  borderWidth: 1, borderColor: selectedTrailer ? "#1a73e8" : "#e8eaed",
                  backgroundColor: selectedTrailer ? "#e8f0fe" : "#ffffff",
                  borderRadius: 10,
                }}
              >
                <Container size={16} color={selectedTrailer ? "#1967d2" : "#5f6368"} strokeWidth={2.2} />
                <Text
                  style={[txt(700), { fontSize: 13, color: selectedTrailer ? "#1967d2" : "#5f6368", flex: 1 }]}
                  numberOfLines={1}
                >
                  {selectedTrailer
                    ? (selectedTrailer.trailerNumber
                        ? `Trailer ${selectedTrailer.trailerNumber}`
                        : selectedTrailer.name)
                    : "Trailer"}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Priority */}
            <Label>Priority</Label>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
              {PRIORITY_OPTIONS.map((p) => {
                const c = PRIORITY_COLORS[p];
                const active = priority === p;
                return (
                  <TouchableOpacity
                    key={p}
                    onPress={() => setPriority(p)}
                    activeOpacity={0.8}
                    style={{
                      flex: 1, paddingVertical: 9,
                      backgroundColor: active ? c.chipBg : "#ffffff",
                      borderWidth: 1, borderColor: active ? c.chipFg : "#e8eaed",
                      borderRadius: 8,
                      alignItems: "center",
                    }}
                  >
                    <Text style={[txt(800), { fontSize: 11, color: active ? c.chipFg : "#5f6368" }]}>
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Vendor + Total cost — side by side, the on-the-go priority fields */}
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 2 }}>
                <Label>Vendor / Shop</Label>
                <TextInput
                  value={vendor}
                  onChangeText={setVendor}
                  placeholder="Joe's Shop"
                  placeholderTextColor="#9aa0a6"
                  style={inputStyle}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Label>Total $</Label>
                <TextInput
                  value={actualCost}
                  onChangeText={setActualCost}
                  placeholder="0"
                  placeholderTextColor="#9aa0a6"
                  keyboardType="decimal-pad"
                  style={inputStyle}
                />
              </View>
            </View>

            {/* Scheduled date */}
            <Label>Scheduled for</Label>
            <TouchableOpacity
              onPress={() => setDateOpen(true)}
              activeOpacity={0.8}
              style={{
                flexDirection: "row", alignItems: "center", gap: 8,
                paddingHorizontal: 12, paddingVertical: 12,
                borderWidth: 1, borderColor: "#e8eaed",
                borderRadius: 10, marginBottom: 14,
              }}
            >
              <CalendarDays size={16} color="#5f6368" strokeWidth={2.2} />
              <Text style={[txt(600), { fontSize: 13, color: scheduledDate ? "#202124" : "#9aa0a6", flex: 1 }]}>
                {scheduledDate ? fmtScheduledDate(scheduledDate) : "No date set"}
              </Text>
              {scheduledDate ? (
                <TouchableOpacity onPress={() => setScheduledDate(null)} hitSlop={10}>
                  <X size={14} color="#9aa0a6" strokeWidth={2.2} />
                </TouchableOpacity>
              ) : null}
            </TouchableOpacity>

            {/* Calendar blocks — edit mode only (we need a WO id to link to) */}
            {mode.kind === "edit" ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4, marginBottom: 8 }}>
                  <Text style={[txt(700), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4 }]}>
                    CALENDAR BLOCKS
                  </Text>
                  <View style={{ flex: 1 }} />
                  <TouchableOpacity
                    onPress={() => {
                      if (assetId == null) {
                        Alert.alert(
                          "Pick a truck first",
                          "Maintenance events block a truck on the calendar.",
                        );
                        return;
                      }
                      setCalendarBlockOpen(true);
                    }}
                    activeOpacity={0.8}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 4,
                      paddingHorizontal: 10, paddingVertical: 6,
                      backgroundColor: "#e8f0fe", borderRadius: 999,
                    }}
                  >
                    <Plus size={12} color="#1967d2" strokeWidth={2.6} />
                    <Text style={[txt(800), { fontSize: 11, color: "#1967d2", letterSpacing: 0.3 }]}>
                      ADD
                    </Text>
                  </TouchableOpacity>
                </View>

                {allLinkedEvents.length === 0 ? (
                  <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginBottom: 14 }]}>
                    No calendar blocks yet.
                  </Text>
                ) : (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                    {allLinkedEvents.map((e) => (
                      <View
                        key={e.id}
                        style={{
                          flexDirection: "row", alignItems: "center", gap: 6,
                          paddingHorizontal: 10, paddingVertical: 6,
                          backgroundColor: "#e8f0fe", borderRadius: 999,
                        }}
                      >
                        <CalendarClock size={12} color="#1967d2" strokeWidth={2.4} />
                        <Text style={[txt(700), { fontSize: 11, color: "#1967d2" }]}>
                          {fmtBlockTime(e.start)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            ) : null}

            {/* Description */}
            <Label>Description</Label>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Details, symptoms, notes…"
              placeholderTextColor="#9aa0a6"
              multiline
              style={[inputStyle, { minHeight: 80, textAlignVertical: "top" }]}
            />

            {/* Photos — edit mode only (need an id to attach to) */}
            {mode.kind === "edit" ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6, marginBottom: 8 }}>
                  <Text style={[txt(700), { fontSize: 12, color: "#5f6368", letterSpacing: 0.3 }]}>
                    PHOTOS
                  </Text>
                  <View style={{ flex: 1 }} />
                  <TouchableOpacity
                    onPress={presentPhotoChoice}
                    disabled={uploading}
                    activeOpacity={0.8}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 4,
                      paddingHorizontal: 10, paddingVertical: 6,
                      backgroundColor: "#e8f0fe", borderRadius: 999,
                    }}
                  >
                    {uploading ? (
                      <ActivityIndicator size="small" color="#1967d2" />
                    ) : (
                      <Camera size={13} color="#1967d2" strokeWidth={2.4} />
                    )}
                    <Text style={[txt(800), { fontSize: 11, color: "#1967d2", letterSpacing: 0.3 }]}>
                      ADD
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* WO-owned photos */}
                <PhotoGrid
                  photos={wOPhotos.map((p) => ({ id: p.id, url: p.signedUrl }))}
                  onDelete={deletePhoto}
                  emptyHint="No photos yet."
                />

                {/* Linked report photos — read-only */}
                {linkedReportId && mode.item.photos /* placeholder, real read of report photos
                                                       requires a /v1/maintenance-reports/:id
                                                       round-trip we can add in v2 */
                  ? null
                  : null}
              </>
            ) : null}

            {/* Delete — bottom of edit mode */}
            {mode.kind === "edit" ? (
              <TouchableOpacity
                onPress={handleDelete}
                style={{
                  marginTop: 28, alignSelf: "center",
                  flexDirection: "row", alignItems: "center", gap: 6,
                  paddingHorizontal: 14, paddingVertical: 8,
                }}
              >
                <Trash2 size={14} color="#c5221f" strokeWidth={2.2} />
                <Text style={[txt(700), { fontSize: 12, color: "#c5221f" }]}>
                  Delete work order
                </Text>
              </TouchableOpacity>
            ) : null}
          </ScrollView>

          {/* Sticky save bar */}
          <View style={{
            position: "absolute", left: 0, right: 0, bottom: 0,
            paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28,
            backgroundColor: "#ffffff",
            borderTopWidth: 1, borderTopColor: "#f1f3f4",
          }}>
            <TouchableOpacity
              onPress={handleSave}
              disabled={saving}
              activeOpacity={0.85}
              style={{
                backgroundColor: saving ? "#5f9ee8" : "#1a73e8",
                paddingVertical: 14, borderRadius: 12,
                flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              {saving ? <ActivityIndicator size="small" color="#ffffff" /> : null}
              <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                {submitLabel}
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>

      {/* Sub-sheets — sit ON TOP of this modal */}
      <DatePickerModal
        visible={dateOpen}
        selected={scheduledDate ?? ""}
        onClose={() => setDateOpen(false)}
        onSelect={(d) => { setScheduledDate(d); setDateOpen(false); }}
      />
      <AssetPickerSheet
        visible={truckPickerOpen}
        title="Pick a truck"
        assets={assets}
        onClose={() => setTruckPickerOpen(false)}
        onSelect={(a) => { setAssetId(a.id); setTrailerId(null); setTruckPickerOpen(false); }}
      />
      <TrailerPickerSheet
        visible={trailerPickerOpen}
        orgId={orgId}
        currentId={trailerId ?? undefined}
        onClose={() => setTrailerPickerOpen(false)}
        onSelect={(id) => { setTrailerId(id); if (id != null) setAssetId(null); setTrailerPickerOpen(false); }}
      />
      <DateTimePickerSheet
        visible={calendarBlockOpen}
        mode="range"
        title="Block on calendar"
        saving={savingBlock}
        initialStart={defaultBlockStart(scheduledDate)}
        initialEnd={defaultBlockEnd(scheduledDate)}
        onClose={() => setCalendarBlockOpen(false)}
        onSave={handleSaveCalendarBlock}
      />
    </Modal>
  );
}

/** Default block start — WO's scheduledDate at 8 AM if set, otherwise
 *  today at 8 AM. Naive YYYY-MM-DDTHH:mm (the app's storage convention
 *  for non-revenue events). */
function defaultBlockStart(scheduledDate: string | null): string {
  const d = scheduledDate ?? todayDateString();
  return `${d}T08:00`;
}
function defaultBlockEnd(scheduledDate: string | null): string {
  const d = scheduledDate ?? todayDateString();
  return `${d}T17:00`;
}
function todayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Mon May 29 · 8 AM – 5 PM" for a naive `YYYY-MM-DDTHH:mm`. Falls
 *  back to the raw start if we can't parse it. */
function fmtBlockTime(start: string, end?: string): string {
  const m = start.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return start;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (end) {
    const m2 = end.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);
    if (m2) {
      const d2 = new Date(0, 0, 0, Number(m2[1]), Number(m2[2]));
      const t2 = d2.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return `${date} · ${time} – ${t2}`;
    }
  }
  return `${date} · ${time}`;
}

// ── Tiny inline helpers ───────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <Text style={[txt(700), {
      fontSize: 11, color: "#5f6368", letterSpacing: 0.4,
      marginBottom: 6, marginTop: 4,
    }]}>
      {String(children).toUpperCase()}
    </Text>
  );
}

const inputStyle = {
  borderWidth: 1, borderColor: "#e8eaed",
  borderRadius: 10,
  paddingHorizontal: 12, paddingVertical: 11,
  fontSize: 14, color: "#202124",
  fontFamily: "PlusJakartaSans_500Medium",
  marginBottom: 14,
} as const;

function PhotoGrid({
  photos, onDelete, emptyHint,
}: {
  photos:    { id: string; url?: string }[];
  onDelete?: (id: string) => void;
  emptyHint: string;
}) {
  if (photos.length === 0) {
    return (
      <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginBottom: 8 }]}>
        {emptyHint}
      </Text>
    );
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {photos.map((p) => (
        <View key={p.id} style={{ position: "relative" }}>
          {p.url ? (
            <Image
              source={{ uri: p.url }}
              style={{ width: 92, height: 92, borderRadius: 8, backgroundColor: "#f1f3f4" }}
            />
          ) : (
            <View style={{
              width: 92, height: 92, borderRadius: 8, backgroundColor: "#f1f3f4",
              alignItems: "center", justifyContent: "center",
            }}>
              <ActivityIndicator size="small" color="#9aa0a6" />
            </View>
          )}
          {onDelete ? (
            <TouchableOpacity
              onPress={() => onDelete(p.id)}
              style={{
                position: "absolute", top: -6, right: -6,
                width: 22, height: 22, borderRadius: 11,
                backgroundColor: "#ffffff",
                borderWidth: 1, borderColor: "#e8eaed",
                alignItems: "center", justifyContent: "center",
              }}
              hitSlop={6}
            >
              <X size={12} color="#5f6368" strokeWidth={2.4} />
            </TouchableOpacity>
          ) : null}
        </View>
      ))}
    </View>
  );
}
