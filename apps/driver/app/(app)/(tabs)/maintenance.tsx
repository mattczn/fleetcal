/**
 * Driver maintenance screen.
 *
 * Single screen with two stacked sections:
 *   1. Report form: pick truck OR trailer, describe the issue,
 *      attach photos, submit.
 *   2. History rail: every report on the selected truck/trailer
 *      (cross-driver, so the driver sees what's already been filed).
 *
 * Drivers can NOT set priority, status, or out-of-service flags. Those
 * are ops decisions and live on the action-item side. Drivers also
 * can NOT pick BOTH a truck and trailer — one or the other per report.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform, RefreshControl, Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Wrench, Truck, Container, Camera, ChevronDown, Check, X } from "lucide-react-native";
import * as Location from "expo-location";
import * as ImagePicker from "expo-image-picker";
import { railway } from "@/lib/railway";
import type { MaintenanceReport } from "@fleetcal/types";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

interface AssetOption   { id: number; name: string; unit?: string; truck?: string; }
interface TrailerOption { id: number; name: string; trailerNumber?: string; category: string; }

type TargetKind = "asset" | "trailer";

interface LocalPhoto {
  /** Local file URI (file:///...). Sent to the API on submit; not persisted in DB. */
  uri:       string;
  mimeType?: string;
  fileName?: string;
}

export default function MaintenanceScreen() {
  const [targetKind, setTargetKind] = useState<TargetKind>("asset");

  const [assets,         setAssets]         = useState<AssetOption[]>([]);
  const [trailers,       setTrailers]       = useState<TrailerOption[]>([]);
  const [optsLoading,    setOptsLoading]    = useState(true);

  const [assetId,        setAssetId]        = useState<number | null>(null);
  const [trailerId,      setTrailerId]      = useState<number | null>(null);
  const [pickerOpen,     setPickerOpen]     = useState(false);

  const [description,    setDescription]    = useState("");
  const [photos,         setPhotos]         = useState<LocalPhoto[]>([]);

  const [submitting,     setSubmitting]     = useState(false);

  const [history,        setHistory]        = useState<MaintenanceReport[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [refreshing,     setRefreshing]     = useState(false);

  // GPS captured silently for the audit trail. Not user-visible.
  const gpsRef = useRef<{ latitude: number; longitude: number; state?: string } | null>(null);

  // Initial load: trucks + trailers + GPS.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // Asset suggestion is only used for the truck path (we don't
        // store trailer assignments the same way). Drivers can still
        // override by tapping the picker.
        const [a, t, suggested] = await Promise.all([
          railway.listAssets(),
          railway.listTrailers(),
          railway.suggestedAsset().catch(() => ({ assetId: null, source: null as null })),
        ]);
        if (!alive) return;
        setAssets(a.assets);
        setTrailers(t.trailers);
        if (suggested.assetId != null && a.assets.some(x => x.id === suggested.assetId)) {
          setAssetId(suggested.assetId);
        }
      } catch (err) {
        console.warn("[maint] load assets/trailers:", err);
      } finally {
        if (alive) setOptsLoading(false);
      }
    })();

    void (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== "granted") return;
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!alive) return;
        gpsRef.current = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        const res = await Location.reverseGeocodeAsync({
          latitude: pos.coords.latitude, longitude: pos.coords.longitude,
        });
        if (!alive) return;
        const region = res[0]?.region ?? undefined;
        if (region && gpsRef.current) gpsRef.current.state = region;
      } catch (err) {
        console.warn("[maint] GPS:", err);
      }
    })();

    return () => { alive = false; };
  }, []);

  const loadHistory = useCallback(async () => {
    const id = targetKind === 'asset' ? assetId : trailerId;
    if (id == null) { setHistory([]); return; }
    setHistoryLoading(true);
    try {
      const res = await railway.listMaintenanceHistory(
        targetKind === 'asset' ? { assetId: id } : { trailerId: id },
        10,
      );
      setHistory(res.reports);
    } catch (err) {
      console.warn("[maint] history:", err);
    } finally {
      setHistoryLoading(false);
    }
  }, [targetKind, assetId, trailerId]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const selectedLabel = useMemo(() => {
    if (targetKind === 'asset') {
      const a = assets.find(x => x.id === assetId);
      return a ? formatAssetLabel(a) : null;
    }
    const t = trailers.find(x => x.id === trailerId);
    return t ? formatTrailerLabel(t) : null;
  }, [targetKind, assetId, trailerId, assets, trailers]);

  function switchTarget(next: TargetKind) {
    if (next === targetKind) return;
    setTargetKind(next);
    setAssetId(null);
    setTrailerId(null);
    setPickerOpen(false);
    setHistory([]);
  }

  // Single "Upload Photo" entry point — prompts the driver to choose
  // camera or library. Mirrors the fuel form's chooseReceiptSource.
  async function choosePhotoSource() {
    if (photos.length >= 8) return;
    Alert.alert(
      "Add Photo",
      undefined,
      [
        { text: "Take Photo",          onPress: takePhoto },
        { text: "Choose from Library", onPress: pickPhotos },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  async function pickPhotos() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photos", "Enable photo access in Settings to attach pictures.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 0.85,
      selectionLimit: 8 - photos.length,
    });
    if (res.canceled) return;
    const newOnes: LocalPhoto[] = res.assets.map(a => ({
      uri:      a.uri,
      mimeType: a.mimeType,
      fileName: a.fileName ?? a.uri.split("/").pop() ?? "photo.jpg",
    }));
    setPhotos(prev => [...prev, ...newOnes].slice(0, 8));
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera", "Enable camera access in Settings to take pictures.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (res.canceled) return;
    const a = res.assets[0];
    if (!a) return;
    setPhotos(prev => [...prev, {
      uri: a.uri, mimeType: a.mimeType, fileName: a.fileName ?? `photo-${Date.now()}.jpg`,
    }].slice(0, 8));
  }

  function removePhoto(idx: number) {
    setPhotos(prev => prev.filter((_, i) => i !== idx));
  }

  const canSubmit =
    description.trim().length > 0 &&
    ((targetKind === 'asset' && assetId != null) ||
     (targetKind === 'trailer' && trailerId != null)) &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const submitted = await railway.submitMaintenanceReport({
        assetId:   targetKind === 'asset'   ? assetId!   : undefined,
        trailerId: targetKind === 'trailer' ? trailerId! : undefined,
        description: description.trim(),
        latitude:  gpsRef.current?.latitude,
        longitude: gpsRef.current?.longitude,
        state:     gpsRef.current?.state,
      });

      // Upload photos sequentially. Failures don't roll back the
      // report itself — the driver gets a notice and the team can
      // ask for resends.
      const uploadFailures: string[] = [];
      for (const p of photos) {
        try {
          const form = new FormData();
          // RN FormData accepts { uri, type, name } objects.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          form.append("file", { uri: p.uri, name: p.fileName ?? "photo.jpg", type: p.mimeType ?? "image/jpeg" } as any);
          await railway.uploadMaintenancePhoto(submitted.report.id, form);
        } catch (err) {
          console.warn("[maint] photo upload failed:", err);
          uploadFailures.push(p.fileName ?? "photo");
        }
      }

      // Clear the form, leave the target selected so the driver can
      // glance at the now-refreshed history rail.
      setDescription("");
      setPhotos([]);
      await loadHistory();

      if (uploadFailures.length > 0) {
        Alert.alert("Submitted", `Report submitted, but ${uploadFailures.length} photo${uploadFailures.length === 1 ? '' : 's'} failed to upload.`);
      } else {
        Alert.alert("Submitted", "Maintenance report sent to the shop.");
      }
    } catch (err) {
      Alert.alert("Submission failed", (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#f1f3f4" }} edges={["top"]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await loadHistory(); setRefreshing(false); }} />
          }>

          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
            <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: '#fff7ed', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
              <Wrench size={18} color="#c2410c" strokeWidth={2.4} />
            </View>
            <Text style={[txt(800), { fontSize: 22, color: '#202124' }]}>Report Issue</Text>
          </View>

          {/* Form card */}
          <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 16 }}>

            {/* Target kind toggle */}
            <Text style={[txt(700), { fontSize: 11, color: '#5f6368', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }]}>
              What's affected?
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
              <ToggleChip
                Icon={Truck}
                label="Truck"
                active={targetKind === 'asset'}
                onPress={() => switchTarget('asset')}
              />
              <ToggleChip
                Icon={Container}
                label="Trailer"
                active={targetKind === 'trailer'}
                onPress={() => switchTarget('trailer')}
              />
            </View>

            {/* Asset / trailer picker */}
            <FieldLabel label={targetKind === 'asset' ? 'Truck' : 'Trailer'} required />
            <TouchableOpacity
              onPress={() => { if (!optsLoading) setPickerOpen(o => !o); }}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: '#f8f9fa',
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 12,
              }}>
              <Text style={[txt(selectedLabel ? 700 : 500), { fontSize: 15, color: selectedLabel ? '#202124' : '#9aa0a6' }]}>
                {selectedLabel ?? (optsLoading ? 'Loading…' : 'Select')}
              </Text>
              <ChevronDown size={16} color="#5f6368" />
            </TouchableOpacity>
            {pickerOpen && (
              <View style={{
                marginTop: 6, backgroundColor: '#fff', borderRadius: 10,
                borderWidth: 1, borderColor: '#e8eaed', maxHeight: 260, overflow: 'hidden',
              }}>
                <ScrollView nestedScrollEnabled>
                  {targetKind === 'asset'
                    ? assets.map(a => (
                        <TouchableOpacity key={a.id}
                          onPress={() => { setAssetId(a.id); setPickerOpen(false); }}
                          activeOpacity={0.6}
                          style={{ paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#f1f3f4' }}>
                          <Text style={[txt(600), { fontSize: 14, color: '#202124' }]}>{formatAssetLabel(a)}</Text>
                        </TouchableOpacity>
                      ))
                    : trailers.map(t => (
                        <TouchableOpacity key={t.id}
                          onPress={() => { setTrailerId(t.id); setPickerOpen(false); }}
                          activeOpacity={0.6}
                          style={{ paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#f1f3f4' }}>
                          <Text style={[txt(600), { fontSize: 14, color: '#202124' }]}>{formatTrailerLabel(t)}</Text>
                        </TouchableOpacity>
                      ))}
                </ScrollView>
              </View>
            )}

            {/* Description */}
            <FieldLabel label="Describe the issue" required />
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="What's wrong? Where on the truck/trailer? When did you notice?"
              placeholderTextColor="#9aa0a6"
              multiline
              style={[
                txt(600),
                {
                  backgroundColor: '#f8f9fa',
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  fontSize: 15,
                  color: '#202124',
                  minHeight: 110,
                  textAlignVertical: 'top',
                },
              ]}
            />

            {/* Photos */}
            <FieldLabel label={`Photos (${photos.length}/8)`} />
            {photos.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {photos.map((p, i) => (
                  <View key={`${p.uri}-${i}`} style={{ width: 72, height: 72, borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
                    <Image source={{ uri: p.uri }} style={{ width: '100%', height: '100%' }} />
                    <TouchableOpacity
                      onPress={() => removePhoto(i)}
                      style={{
                        position: 'absolute', top: 2, right: 2,
                        width: 22, height: 22, borderRadius: 11,
                        backgroundColor: 'rgba(0,0,0,0.55)',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                      <X size={12} color="#fff" strokeWidth={2.8} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
            {photos.length < 8 && (
              <TouchableOpacity onPress={choosePhotoSource}
                style={{
                  width: '100%',
                  paddingVertical: 18,
                  borderRadius: 10,
                  borderWidth: 1.5, borderColor: '#1a73e8', borderStyle: 'dashed',
                  alignItems: 'center', justifyContent: 'center',
                  flexDirection: 'row',
                  gap: 8,
                  backgroundColor: '#e8f0fe',
                }}>
                <Camera size={18} color="#1a73e8" strokeWidth={2.2} />
                <Text style={[txt(700), { fontSize: 14, color: '#1a73e8' }]}>
                  {photos.length === 0 ? 'Upload Photo' : 'Add Another Photo'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Submit */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!canSubmit}
              activeOpacity={0.85}
              style={{
                marginTop: 18,
                backgroundColor: canSubmit ? '#c2410c' : '#fed7aa',
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: 'center',
                flexDirection: 'row',
                justifyContent: 'center',
                gap: 8,
              }}>
              {submitting
                ? <ActivityIndicator color="#fff" />
                : <Check size={18} color="#fff" strokeWidth={2.6} />}
              <Text style={[txt(800), { fontSize: 15, color: '#fff', letterSpacing: 0.3 }]}>
                {submitting ? 'Submitting…' : 'Submit Report'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* History rail */}
          <View style={{ marginTop: 24 }}>
            <Text style={[txt(800), { fontSize: 11, color: '#5f6368', letterSpacing: 1.1, marginBottom: 8 }]}>
              {selectedLabel ? `RECENT REPORTS · ${selectedLabel.toUpperCase()}` : 'RECENT REPORTS'}
            </Text>
            {!selectedLabel ? (
              <Text style={[txt(500), { fontSize: 13, color: '#9aa0a6', padding: 12 }]}>
                Select a {targetKind === 'asset' ? 'truck' : 'trailer'} above to see recent reports.
              </Text>
            ) : historyLoading ? (
              <View style={{ padding: 16, alignItems: 'center' }}>
                <ActivityIndicator />
              </View>
            ) : history.length === 0 ? (
              <Text style={[txt(500), { fontSize: 13, color: '#9aa0a6', padding: 12 }]}>
                No prior reports.
              </Text>
            ) : (
              history.map(r => <HistoryRow key={r.id} report={r} />)
            )}
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────

function ToggleChip({
  Icon, label, active, onPress,
}: {
  Icon: typeof Truck; label: string; active: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 12,
        borderRadius: 10,
        backgroundColor: active ? '#c2410c' : '#f8f9fa',
        borderWidth: 1,
        borderColor: active ? '#c2410c' : '#e8eaed',
      }}>
      <Icon size={16} color={active ? '#fff' : '#5f6368'} strokeWidth={2.2} />
      <Text style={[txt(700), { fontSize: 14, color: active ? '#fff' : '#5f6368' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14, marginBottom: 6, gap: 4 }}>
      <Text style={[txt(700), { fontSize: 11, color: '#5f6368', letterSpacing: 0.5, textTransform: 'uppercase' }]}>{label}</Text>
      {required && <Text style={[txt(700), { fontSize: 11, color: '#c62828' }]}>*</Text>}
    </View>
  );
}

function HistoryRow({ report }: { report: MaintenanceReport }) {
  const date = new Date(report.reportedAt);
  const dateLabel = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const statusColor =
    report.status === 'open'        ? { bg: '#fef3c7', fg: '#92400e', label: 'Open' } :
    report.status === 'reviewed'    ? { bg: '#dbeafe', fg: '#1e40af', label: 'Reviewed' } :
    report.status === 'converted'   ? { bg: '#dcfce7', fg: '#15803d', label: 'Scheduled' } :
                                      { bg: '#f3f4f6', fg: '#4b5563', label: 'Dismissed' };
  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Text style={[txt(500), { fontSize: 12, color: '#5f6368' }]}>{dateLabel}</Text>
        <View style={{
          paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
          backgroundColor: statusColor.bg,
        }}>
          <Text style={[txt(700), { fontSize: 10, color: statusColor.fg }]}>{statusColor.label}</Text>
        </View>
      </View>
      <Text style={[txt(600), { fontSize: 14, color: '#202124', marginTop: 4 }]} numberOfLines={3}>
        {report.description}
      </Text>
    </View>
  );
}

function formatAssetLabel(a: AssetOption): string {
  if (a.unit) return `#${a.unit}${a.name ? ` · ${a.name}` : ''}`;
  return a.name;
}
function formatTrailerLabel(t: TrailerOption): string {
  if (t.trailerNumber) return `#${t.trailerNumber}${t.name ? ` · ${t.name}` : ''}`;
  return t.name;
}
