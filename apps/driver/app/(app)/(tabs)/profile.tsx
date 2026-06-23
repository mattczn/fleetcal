/**
 * Driver Profile — edit own HR / compliance fields, upload + manage
 * documents (license / medical card / MVR / other). Field changes
 * save on blur. Documents render as a single flat list with a
 * category badge per row.
 *
 * Sync with the web's DriversModal: same DB columns, same API, same
 * normalization. The header (avatar + name + phone) re-fetches after
 * a first/last name save so the display matches what the web shows.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform, RefreshControl, Modal, Image,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  LogOut, User, FileText, Trash2, X, Share2, Eye, Plus, Calendar as CalendarIcon, ChevronDown,
  Pencil, Check,
} from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import { supabase } from "@/lib/supabase";
import { railway, type DriverMeResponse } from "@/lib/railway";
import type { DriverDocument, DriverDocumentKind } from "@fleetcal/types";
import {
  NOTIFICATION_RULE_KEYS,
  NOTIFICATION_RULE_LABEL,
  type NotificationRuleKey,
} from "@fleetcal/types";
import { useOrgTz, describeTz } from "@/lib/orgTz";
import { useTheme } from "@/lib/ThemeProvider";
import { useModules } from "@/lib/useModules";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

const DOC_KIND_LABEL: Record<DriverDocumentKind, string> = {
  license:      "License",
  medical_card: "Medical Card",
  mvr:          "MVR",
  other:        "Other",
};

// Theme-aware badge tints, keyed by document kind. Called inside the
// component with the active palette so the badges follow light/dark.
function docKindTint(C: ReturnType<typeof useTheme>["C"]): Record<DriverDocumentKind, { bg: string; fg: string }> {
  return {
    license:      { bg: C.blueBg,  fg: ACCENT_OF(C) },
    medical_card: { bg: C.redBg,   fg: C.redInk },
    mvr:          { bg: C.amberBg, fg: C.amberInk },
    other:        { bg: C.borderSoft, fg: C.t3 },
  };
}
// `ACCENT` equals `C.blue`; helper keeps the map readable.
function ACCENT_OF(C: ReturnType<typeof useTheme>["C"]) { return C.blue; }

// ── Address ⇄ structured parts ──────────────────────────────────────────

interface AddressParts { street: string; city: string; state: string; zip: string; }

function parseAddress(s: string | undefined): AddressParts {
  const empty = { street: "", city: "", state: "", zip: "" };
  if (!s) return empty;
  const m = s.match(/^(.*?),\s*(.*?),\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
  if (m) return { street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4] ?? "" };
  return { street: s, city: "", state: "", zip: "" };
}

function joinAddress(p: AddressParts): string | null {
  const parts: string[] = [];
  if (p.street.trim()) parts.push(p.street.trim());
  if (p.city.trim())   parts.push(p.city.trim());
  const tail = [p.state.trim().toUpperCase(), p.zip.trim()].filter(Boolean).join(" ");
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts.join(", ") : null;
}

// ── Date helpers ────────────────────────────────────────────────────────

function isoToDate(iso?: string): Date | undefined {
  if (!iso) return undefined;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoToDisplay(iso?: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

// ── Screen ──────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  // `reporting` (= Fuel OR Maintenance modules enabled) only gates the
  // Notifications section now. License, Compliance, and Documents all
  // ship in MVP — small carriers still want their drivers carrying a
  // photo of the CDL + med card from day one, even before the reporting
  // bundle is unlocked.
  const { reporting } = useModules();
  const { C, SHADOW, ACCENT, mode, setMode } = useTheme();
  const [me,         setMe]         = useState<DriverMeResponse | null>(null);
  const [docs,       setDocs]       = useState<DriverDocument[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Currently-open profile document in the in-app viewer. Replaces
  // the old Linking.openURL flow that punted to the system browser
  // and showed the user a raw Supabase signed URL.
  const [viewDocState, setViewDocState] = useState<DriverDocument | null>(null);
  // Captures the most recent /me fetch failure so the UI can render a
  // visible error state instead of empty form fields (which the
  // driver was reading as "I need to fill all of these in").
  const [loadError,  setLoadError]  = useState<string | null>(null);

  // Org tz read-only display. Query is gated on `me` being loaded so
  // it doesn't fire before auth context is ready.
  const orgTz = useOrgTz(me?.driverId, me?.orgId);

  // Editable form state — seeded from `me` after fetch.
  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [phone,     setPhone]     = useState("");
  const [email,     setEmail]     = useState("");
  const [addr,      setAddr]      = useState<AddressParts>({ street: "", city: "", state: "", zip: "" });
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseState,  setLicenseState]  = useState("");
  const [licenseExp,    setLicenseExp]    = useState<string | undefined>(undefined);
  const [medCardExp,    setMedCardExp]    = useState<string | undefined>(undefined);
  const [dob,           setDob]           = useState<string | undefined>(undefined);

  const [pickerOpen,      setPickerOpen]      = useState<'licenseExp' | 'medicalCardExp' | 'dob' | null>(null);
  const [statePickerOpen, setStatePickerOpen] = useState<'addr' | 'license' | null>(null);

  // ── Edit mode ─────────────────────────────────────────────────────
  // Profile is read-only by default with an Edit button in the
  // sticky action bar at the top. Tapping Edit unlocks the inputs
  // and swaps Edit for Save / Discard. The previous on-blur
  // auto-save pattern was discarded — it surprised drivers who tabbed
  // through fields they hadn't meant to change and got silent writes.
  const [editing, setEditing] = useState(false);
  const [saving,  setSaving]  = useState(false);

  // Reset all editable form state from a fresh `me` snapshot. Used
  // when Discard is tapped, when /me reloads after save, and on
  // initial hydration.
  function resetFromMe(src: DriverMeResponse) {
    setFirstName(src.firstName ?? "");
    setLastName(src.lastName ?? "");
    setPhone(src.phone ?? "");
    setEmail(src.email ?? "");
    setAddr(parseAddress(src.address));
    setLicenseNumber(src.licenseNumber ?? "");
    setLicenseState(src.licenseState ?? "");
    setLicenseExp(src.licenseExp);
    setMedCardExp(src.medicalCardExp);
    setDob(src.dob);
  }

  function discardEdits() {
    if (me) resetFromMe(me);
    setPickerOpen(null);
    setStatePickerOpen(null);
    setEditing(false);
  }

  async function saveAllEdits() {
    if (saving) return;
    setSaving(true);
    try {
      // One PATCH with every editable field. Server-side keeps untouched
      // values unchanged when the same value comes back in the payload,
      // so we don't need to compute a diff here.
      await railway.updateMe({
        firstName:      firstName.trim() || null,
        lastName:       lastName.trim()  || null,
        phone:          phone.trim()     || null,
        email:          email.trim()     || null,
        address:        joinAddress(addr),
        licenseNumber:  licenseNumber.trim() || null,
        licenseState:   licenseState || null,
        licenseExp:     licenseExp ?? null,
        medicalCardExp: medCardExp ?? null,
        dob:            dob ?? null,
      });
      await loadAll();
      setEditing(false);
    } catch (err) {
      Alert.alert("Save failed", (err as Error).message ?? "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  const loadAll = useCallback(async () => {
    try {
      const [meRes, docsRes] = await Promise.all([
        railway.me(),
        railway.listMyDocuments().catch(() => ({ documents: [] })),
      ]);
      setMe(meRes);
      setDocs(docsRes.documents);
      setFirstName(meRes.firstName ?? "");
      setLastName(meRes.lastName ?? "");
      setPhone(meRes.phone ?? "");
      setEmail(meRes.email ?? "");
      setAddr(parseAddress(meRes.address));
      setLicenseNumber(meRes.licenseNumber ?? "");
      setLicenseState(meRes.licenseState ?? "");
      setLicenseExp(meRes.licenseExp);
      setMedCardExp(meRes.medicalCardExp);
      setDob(meRes.dob);
      setLoadError(null);
    } catch (err) {
      console.warn("[profile] load:", err);
      // Surface the failure so the form doesn't render as a blank
      // canvas the driver mistakes for "incomplete profile, fill it in".
      setLoadError((err as Error).message || "Could not load your profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  // Document upload — single flat flow: pick category, then source.
  async function startUpload() {
    Alert.alert(
      "Upload Document",
      "What type of document?",
      [
        { text: "License",      onPress: () => pickSource("license") },
        { text: "Medical Card", onPress: () => pickSource("medical_card") },
        { text: "MVR",          onPress: () => pickSource("mvr") },
        { text: "Other",        onPress: () => pickSource("other") },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  async function pickSource(kind: DriverDocumentKind) {
    Alert.alert(
      `Upload ${DOC_KIND_LABEL[kind]}`,
      undefined,
      [
        { text: "Take Photo",          onPress: () => void uploadFrom(kind, "camera") },
        { text: "Choose from Library", onPress: () => void uploadFrom(kind, "library") },
        { text: "Choose File",         onPress: () => void uploadFrom(kind, "file") },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  async function uploadFrom(kind: DriverDocumentKind, source: "camera" | "library" | "file") {
    try {
      let uri: string | undefined;
      let mimeType: string | undefined;
      let fileName: string | undefined;

      if (source === "camera") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { Alert.alert("Permission needed", "Enable camera access in Settings."); return; }
        const res = await ImagePicker.launchCameraAsync({ quality: 0.85 });
        if (res.canceled) return;
        uri = res.assets[0]?.uri;
        mimeType = res.assets[0]?.mimeType ?? "image/jpeg";
        fileName = res.assets[0]?.fileName ?? `${kind}-${Date.now()}.jpg`;
      } else if (source === "library") {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) { Alert.alert("Permission needed", "Enable photo access in Settings."); return; }
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.85, allowsMultipleSelection: false,
        });
        if (res.canceled) return;
        uri = res.assets[0]?.uri;
        mimeType = res.assets[0]?.mimeType ?? "image/jpeg";
        fileName = res.assets[0]?.fileName ?? `${kind}-${Date.now()}.jpg`;
      } else {
        const res = await DocumentPicker.getDocumentAsync({
          type: ["application/pdf", "image/*"],
          multiple: false,
          copyToCacheDirectory: true,
        });
        if (res.canceled) return;
        const a = res.assets?.[0];
        uri = a?.uri;
        mimeType = a?.mimeType ?? "application/octet-stream";
        fileName = a?.name ?? `${kind}-${Date.now()}`;
      }

      if (!uri) return;

      const form = new FormData();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form.append("file", { uri, name: fileName, type: mimeType } as any);
      form.append("kind", kind);
      await railway.uploadMyDocument(form);
      await loadAll();
    } catch (err) {
      Alert.alert("Upload failed", (err as Error).message);
    }
  }

  function viewDoc(d: DriverDocument) {
    if (!d.signedUrl) {
      Alert.alert("Unavailable", "Refresh and try again.");
      return;
    }
    setViewDocState(d);
  }

  async function deleteDoc(d: DriverDocument) {
    Alert.alert(
      "Delete document",
      `Remove ${d.fileName}?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: async () => {
            try { await railway.deleteMyDocument(d.id); await loadAll(); }
            catch (err) { Alert.alert("Delete failed", (err as Error).message); }
          } },
      ],
    );
  }

  function handleSignOut() {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: async () => { await supabase.auth.signOut(); } },
    ]);
  }

  const initials = (me?.name ?? "?")
    .split(" ").map(s => s[0]).slice(0, 2).join("").toUpperCase();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={["top"]}>
      {/* Light header — matches the rest of the app */}
      <View style={{ backgroundColor: C.bg, paddingTop: 8, paddingBottom: 28, alignItems: "center" }}>
        <View style={{
          width: 84, height: 84, borderRadius: 26,
          backgroundColor: ACCENT,
          alignItems: "center", justifyContent: "center",
          marginBottom: 12,
        }}>
          {initials !== "?" ? (
            <Text style={[txt(800), { fontSize: 30, color: "#fff", letterSpacing: -0.5 }]}>{initials}</Text>
          ) : (
            <User size={36} color="#fff" strokeWidth={2.2} />
          )}
        </View>
        <Text style={[txt(800), { fontSize: 22, color: C.t1, letterSpacing: -0.3 }]}>{me?.firstName ?? me?.name ?? "—"}</Text>
        <Text style={[txt(500), { fontSize: 13, color: C.t3, marginTop: 2 }]}>
          {me?.phone ?? "—"}
        </Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          refreshControl={
            <RefreshControl refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await loadAll(); setRefreshing(false); }} />
          }>
          {loading ? (
            <View style={{ padding: 40, alignItems: "center" }}>
              <ActivityIndicator />
            </View>
          ) : loadError ? (
            // The /me fetch failed — render an explicit error state
            // instead of blank inputs. Blank inputs were being read as
            // "your profile is incomplete, fill it in" and drivers
            // would start re-entering data over top of values that
            // were still on the server.
            <View style={{ padding: 24, alignItems: "center" }}>
              <Text style={[txt(700), { fontSize: 15, color: C.redInk, marginBottom: 8, textAlign: "center" }]}>
                Could not load your profile
              </Text>
              <Text style={[txt(500), { fontSize: 13, color: C.t3, textAlign: "center", marginBottom: 16 }]}>
                {loadError}
              </Text>
              <TouchableOpacity
                onPress={() => { setLoading(true); void loadAll(); }}
                style={{ backgroundColor: ACCENT, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 }}
              >
                <Text style={[txt(700), { color: "#fff", fontSize: 13 }]}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* Appearance — in-app light/dark toggle */}
              <SectionHeader label="Appearance" />
              <Card>
                <View style={{ flexDirection: "row", gap: 10, paddingVertical: 6 }}>
                  <TouchableOpacity
                    onPress={() => setMode("light")}
                    activeOpacity={0.8}
                    style={{
                      flex: 1, alignItems: "center", justifyContent: "center",
                      paddingVertical: 12, borderRadius: 999,
                      backgroundColor: mode === "light" ? ACCENT : C.surfaceSunk,
                    }}>
                    <Text style={[txt(700), { fontSize: 14, color: mode === "light" ? "#fff" : C.t2 }]}>
                      Light
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setMode("dark")}
                    activeOpacity={0.8}
                    style={{
                      flex: 1, alignItems: "center", justifyContent: "center",
                      paddingVertical: 12, borderRadius: 999,
                      backgroundColor: mode === "dark" ? ACCENT : C.surfaceSunk,
                    }}>
                    <Text style={[txt(700), { fontSize: 14, color: mode === "dark" ? "#fff" : C.t2 }]}>
                      Dark
                    </Text>
                  </TouchableOpacity>
                </View>
              </Card>

              {/* Edit / Save / Discard action bar — anchors the whole
                  form into either view or edit mode. Sticky at the top
                  of the scrollable content so the driver can save / bail
                  without scrolling back. */}
              <EditActionBar
                editing={editing}
                saving={saving}
                onEdit={() => setEditing(true)}
                onSave={saveAllEdits}
                onDiscard={discardEdits}
              />

              {/* Account */}
              <SectionHeader label="Account" />
              <Card>
                <FormGrid>
                  <FormCol>
                    <FieldLabel label="First Name" />
                    <TextField value={firstName} onChangeText={setFirstName}
                      autoCapitalize="words" editable={editing} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="Last Name" />
                    <TextField value={lastName} onChangeText={setLastName}
                      autoCapitalize="words" editable={editing} />
                  </FormCol>
                </FormGrid>
                <FieldLabel label="Phone" />
                <TextField value={phone} onChangeText={setPhone}
                  keyboardType="phone-pad" editable={editing} />
                <FieldLabel label="Email" />
                <TextField value={email} onChangeText={setEmail}
                  keyboardType="email-address" autoCapitalize="none" editable={editing} />
              </Card>

              {/* Address */}
              <SectionHeader label="Address" />
              <Card>
                <FieldLabel label="Street" />
                <TextField value={addr.street}
                  onChangeText={(v) => setAddr({ ...addr, street: v })}
                  editable={editing} />
                <FieldLabel label="City" />
                <TextField value={addr.city}
                  onChangeText={(v) => setAddr({ ...addr, city: v })}
                  editable={editing} />
                <FormGrid>
                  <FormCol>
                    <FieldLabel label="State" />
                    <StateField value={addr.state}
                      open={statePickerOpen === 'addr'}
                      setOpen={(v) => setStatePickerOpen(v ? 'addr' : null)}
                      onChange={(s) => setAddr({ ...addr, state: s })}
                      editable={editing}
                    />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="Zip" />
                    <TextField value={addr.zip}
                      onChangeText={(v) => setAddr({ ...addr, zip: v.replace(/[^\d-]/g, "").slice(0, 10) })}
                      keyboardType="number-pad" editable={editing} />
                  </FormCol>
                </FormGrid>
              </Card>

              {/* License — ships in MVP. Compliance fields below also
                  in MVP. Notifications stay gated on the reporting
                  module (Fuel / Maintenance) since those toggles only
                  matter when those modules generate auto-pushes. */}
              <SectionHeader label="License" />
              <Card>
                <FormGrid>
                  <FormCol style={{ flex: 2 }}>
                    <FieldLabel label="License #" />
                    <TextField value={licenseNumber} onChangeText={setLicenseNumber}
                      autoCapitalize="characters" editable={editing} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="State" />
                    <StateField value={licenseState}
                      open={statePickerOpen === 'license'}
                      setOpen={(v) => setStatePickerOpen(v ? 'license' : null)}
                      onChange={(s) => setLicenseState(s)}
                      editable={editing}
                    />
                  </FormCol>
                </FormGrid>
                <FieldLabel label="Expiration" />
                <DateField
                  value={licenseExp}
                  onChange={(iso) => setLicenseExp(iso)}
                  open={pickerOpen === 'licenseExp'}
                  setOpen={(v) => setPickerOpen(v ? 'licenseExp' : null)}
                  editable={editing}
                />
              </Card>

              {/* Compliance */}
              <SectionHeader label="Compliance" />
              <Card>
                <FieldLabel label="Medical Card Expiration" />
                <DateField
                  value={medCardExp}
                  onChange={(iso) => setMedCardExp(iso)}
                  open={pickerOpen === 'medicalCardExp'}
                  setOpen={(v) => setPickerOpen(v ? 'medicalCardExp' : null)}
                  editable={editing}
                />
                <FieldLabel label="Date of Birth" />
                <DateField
                  value={dob}
                  onChange={(iso) => setDob(iso)}
                  open={pickerOpen === 'dob'}
                  setOpen={(v) => setPickerOpen(v ? 'dob' : null)}
                  /* DOB is bounded — no future dates. */
                  maximumDate={new Date()}
                  editable={editing}
                />
              </Card>

              {/* Documents — single flat list */}
              <SectionHeader label="Documents" />
              <Card>
                <TouchableOpacity onPress={startUpload}
                  style={{
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                    paddingVertical: 14,
                    borderRadius: 10,
                    borderWidth: 1.5, borderColor: ACCENT, borderStyle: 'dashed',
                    backgroundColor: C.blueBg,
                    marginBottom: docs.length > 0 ? 12 : 0,
                  }}>
                  <Plus size={16} color={ACCENT} strokeWidth={2.4} />
                  <Text style={[txt(700), { fontSize: 14, color: ACCENT }]}>Upload Document</Text>
                </TouchableOpacity>
                {docs.length === 0 ? (
                  <Text style={[txt(500), { fontSize: 12, color: C.t4, textAlign: 'center', paddingVertical: 12 }]}>
                    No documents uploaded yet.
                  </Text>
                ) : (
                  docs.map((d, idx) => (
                    <DocRow key={d.id} doc={d}
                      isLast={idx === docs.length - 1}
                      onView={() => viewDoc(d)}
                      onDelete={() => deleteDoc(d)} />
                  ))
                )}
              </Card>

              {/* Organization */}
              <SectionHeader label="Organization" />
              <Card>
                <View style={{ paddingVertical: 8 }}>
                  <FieldLabel label="Timezone" />
                  <View style={{
                    paddingVertical: 10, paddingHorizontal: 12,
                    backgroundColor: C.borderSoft,
                    borderRadius: 8,
                    borderWidth: 1, borderColor: C.border,
                  }}>
                    <Text style={[txt(700), { fontSize: 14, color: C.t2 }]}>
                      {describeTz(orgTz)}
                    </Text>
                  </View>
                  <Text style={[txt(500), { fontSize: 11, color: C.t4, marginTop: 6 }]}>
                    Set by your dispatcher. All times in this app display in this timezone.
                  </Text>
                </View>
              </Card>

              {reporting ? (
              <>
              {/* Notifications */}
              <SectionHeader label="Notifications" />
              <Card>
                <NotificationsPrefs />
              </Card>
              </>
              ) : null}

              {/* Sign out */}
              <TouchableOpacity onPress={handleSignOut}
                style={{
                  marginTop: 8,
                  flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                  paddingVertical: 16,
                  backgroundColor: C.redBg,
                  borderRadius: 14,
                  borderWidth: 1, borderColor: C.redBg,
                }}>
                <LogOut size={16} color={C.redInk} strokeWidth={2.2} />
                <Text style={[txt(800), { fontSize: 14, color: C.redInk, letterSpacing: 0.2 }]}>Sign Out</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* In-app viewer — opens when a doc tile's eye icon is tapped.
          Image docs render inline, other types (PDF) load in a WebView.
          Share button dumps the file to cache and hands it to the OS
          share sheet so the driver can send it to their dispatcher,
          email it to themselves, save to Files, etc. */}
      <DriverDocumentViewer doc={viewDocState} onClose={() => setViewDocState(null)} />
    </SafeAreaView>
  );
}

/** In-app viewer for the driver's profile documents (license, medical
 *  card, MVR, other). Mirrors the load-document viewer pattern in
 *  DocumentsView.tsx — image inline, WebView for everything else,
 *  download-to-cache → OS share sheet for the Share button. */
function DriverDocumentViewer({ doc, onClose }: { doc: DriverDocument | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [sharing, setSharing] = useState(false);

  if (!doc || !doc.signedUrl) return null;

  const isImage = (doc.mimeType ?? "").startsWith("image/")
    || /\.(jpg|jpeg|png|webp|heic)$/i.test(doc.fileName);

  async function handleShare() {
    if (!doc || !doc.signedUrl || sharing) return;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Sharing not available", "This device can't share files.");
        return;
      }
      const safeName = (doc.fileName || "document").replace(/[^A-Za-z0-9._-]/g, "_");
      const dest = (FileSystem.cacheDirectory ?? "") + safeName;
      const { uri } = await FileSystem.downloadAsync(doc.signedUrl, dest);
      await Sharing.shareAsync(uri, {
        mimeType: doc.mimeType,
        UTI:      doc.mimeType === "application/pdf" ? "com.adobe.pdf" : undefined,
      });
    } catch (err) {
      Alert.alert("Couldn't share", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSharing(false);
    }
  }

  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        <View style={{ paddingTop: insets.top, flex: 1 }}>
          <View style={{
            flexDirection: "row", alignItems: "center", paddingHorizontal: 14,
            paddingTop: 8, paddingBottom: 12, gap: 12,
          }}>
            <TouchableOpacity onPress={onClose} hitSlop={14}
              style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: "rgba(255,255,255,0.18)",
                alignItems: "center", justifyContent: "center",
              }}>
              <X size={20} color="#ffffff" strokeWidth={2.4} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={[txt(800), { fontSize: 14, color: "#ffffff" }]} numberOfLines={1}>
                {doc.fileName}
              </Text>
              <Text style={[txt(500), { fontSize: 11, color: "rgba(255,255,255,0.55)" }]}>
                {DOC_KIND_LABEL[doc.kind] ?? doc.kind}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => void handleShare()}
              hitSlop={14}
              disabled={sharing}
              style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: "rgba(255,255,255,0.18)",
                alignItems: "center", justifyContent: "center",
                opacity: sharing ? 0.5 : 1,
              }}>
              {sharing
                ? <ActivityIndicator color="#ffffff" />
                : <Share2 size={18} color="#ffffff" strokeWidth={2.4} />}
            </TouchableOpacity>
          </View>

          <View style={{ flex: 1, padding: 0 }}>
            {isImage ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 12 }}>
                <Image source={{ uri: doc.signedUrl }} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
              </View>
            ) : (
              <WebView
                source={{ uri: doc.signedUrl }}
                style={{ flex: 1, backgroundColor: "#000000" }}
                originWhitelist={["*"]}
                startInLoadingState
                renderLoading={() => (
                  <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#000000" }}>
                    <ActivityIndicator color="#ffffff" />
                  </View>
                )}
              />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────

/**
 * Edit / Save / Discard action bar. Sits above the form sections,
 * controls the read-only ↔ edit toggle, and surfaces the all-at-once
 * save flow. Profile is read-only by default; the driver taps Edit
 * to unlock the fields and gets explicit commit (Save) or bail
 * (Discard) buttons in return.
 */
function EditActionBar({
  editing, saving, onEdit, onSave, onDiscard,
}: {
  editing:    boolean;
  saving:     boolean;
  onEdit:     () => void;
  onSave:     () => void;
  onDiscard:  () => void;
}) {
  const { C, ACCENT } = useTheme();
  if (!editing) {
    return (
      <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 4 }}>
        <TouchableOpacity
          onPress={onEdit}
          activeOpacity={0.7}
          style={{
            flexDirection: "row", alignItems: "center", gap: 6,
            paddingHorizontal: 14, paddingVertical: 8,
            borderRadius: 999,
            backgroundColor: C.blueBg,
          }}
        >
          <Pencil size={13} color={ACCENT} strokeWidth={2.4} />
          <Text style={[txt(700), { fontSize: 13, color: ACCENT }]}>Edit Profile</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", gap: 8, marginBottom: 4 }}>
      <TouchableOpacity
        onPress={onDiscard}
        disabled={saving}
        activeOpacity={0.7}
        style={{
          flex: 1,
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
          paddingVertical: 10,
          borderRadius: 999,
          backgroundColor: C.surfaceSunk,
          borderWidth: 1, borderColor: C.border,
          opacity: saving ? 0.5 : 1,
        }}
      >
        <X size={14} color={C.t2} strokeWidth={2.4} />
        <Text style={[txt(700), { fontSize: 13, color: C.t2 }]}>Discard</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onSave}
        disabled={saving}
        activeOpacity={0.7}
        style={{
          flex: 1,
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
          paddingVertical: 10,
          borderRadius: 999,
          backgroundColor: ACCENT,
          opacity: saving ? 0.6 : 1,
        }}
      >
        {saving
          ? <ActivityIndicator color="#fff" />
          : <Check size={14} color="#fff" strokeWidth={2.4} />}
        <Text style={[txt(800), { fontSize: 13, color: "#fff", letterSpacing: 0.2 }]}>
          {saving ? "Saving…" : "Save"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function SectionHeader({ label }: { label: string }) {
  const { C } = useTheme();
  return (
    <Text style={[txt(800), {
      fontSize: 11, letterSpacing: 1.1, color: C.t3,
      marginBottom: 8, marginTop: 16, textTransform: "uppercase",
    }]}>
      {label}
    </Text>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  const { C } = useTheme();
  return (
    <View style={{
      backgroundColor: C.surface,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderWidth: 1, borderColor: C.border,
    }}>
      {children}
    </View>
  );
}

function FieldLabel({ label }: { label: string }) {
  const { C } = useTheme();
  return (
    <Text style={[txt(700), {
      fontSize: 11, color: C.t3, letterSpacing: 0.5,
      textTransform: "uppercase",
      marginTop: 10, marginBottom: 4,
    }]}>
      {label}
    </Text>
  );
}

interface TextFieldProps {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "email-address" | "number-pad" | "phone-pad" | "decimal-pad";
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  maxLength?: number;
  /** When false, the input is read-only — tap does nothing, keyboard
   *  doesn't appear, and the border softens so the screen reads as
   *  view-mode. Defaults to true so older callers keep behaving. */
  editable?: boolean;
}

function TextField({
  value, onChangeText, placeholder, keyboardType, autoCapitalize, maxLength,
  editable = true,
}: TextFieldProps) {
  const { C } = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={C.t4}
      keyboardType={keyboardType ?? "default"}
      autoCapitalize={autoCapitalize ?? "sentences"}
      maxLength={maxLength}
      editable={editable}
      style={[
        txt(600),
        {
          backgroundColor: editable ? C.surface : C.surfaceSunk,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: editable ? C.border : C.borderSoft,
          paddingHorizontal: 12, paddingVertical: 10,
          fontSize: 15, color: C.t1,
          marginBottom: 4,
        },
      ]}
    />
  );
}

// Native date picker. iOS shows in a sheet, Android in a dialog.
function DateField({
  value, onChange, open, setOpen, maximumDate, editable = true,
}: {
  value:        string | undefined;     // ISO YYYY-MM-DD
  onChange:     (iso: string | undefined) => void;
  open:         boolean;
  setOpen:      (v: boolean) => void;
  maximumDate?: Date;
  editable?:    boolean;
}) {
  const { C, ACCENT } = useTheme();
  const display = isoToDisplay(value);

  function onPickerChange(_event: unknown, selected?: Date) {
    // iOS keeps the picker open in inline/spinner mode; Android
    // fires once with the selection and closes itself.
    if (Platform.OS !== 'ios') setOpen(false);
    if (selected) onChange(dateToIso(selected));
  }

  return (
    <>
      <TouchableOpacity
        onPress={() => { if (editable) setOpen(!open); }}
        activeOpacity={editable ? 0.7 : 1}
        style={{
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          backgroundColor: editable ? C.surface : C.surfaceSunk,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: editable ? C.border : C.borderSoft,
          paddingHorizontal: 12, paddingVertical: 12,
          marginBottom: 4,
        }}>
        <Text style={[txt(display ? 700 : 500), { fontSize: 15, color: display ? C.t1 : C.t4 }]}>
          {display || (editable ? "Select date" : "—")}
        </Text>
        {editable && <CalendarIcon size={16} color={C.t3} />}
      </TouchableOpacity>
      {open && Platform.OS === 'ios' && (
        <Modal transparent animationType="slide" visible onRequestClose={() => setOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setOpen(false)}
            style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' }}>
            <TouchableOpacity activeOpacity={1} style={{ backgroundColor: C.surface, paddingTop: 8, paddingBottom: 24 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 }}>
                {value
                  ? <TouchableOpacity onPress={() => { onChange(undefined); setOpen(false); }}>
                      <Text style={[txt(700), { fontSize: 14, color: C.redInk }]}>Clear</Text>
                    </TouchableOpacity>
                  : <View />}
                <TouchableOpacity onPress={() => setOpen(false)}>
                  <Text style={[txt(800), { fontSize: 14, color: ACCENT }]}>Done</Text>
                </TouchableOpacity>
              </View>
              <DateTimePicker
                value={isoToDate(value) ?? new Date()}
                mode="date"
                display="spinner"
                maximumDate={maximumDate}
                onChange={onPickerChange}
              />
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}
      {open && Platform.OS !== 'ios' && (
        <DateTimePicker
          value={isoToDate(value) ?? new Date()}
          mode="date"
          display="default"
          maximumDate={maximumDate}
          onChange={onPickerChange}
        />
      )}
    </>
  );
}

// State picker — modal with the 50 US state abbreviations. Same
// visual chrome as DateField (picker row → modal sheet) so the form
// reads consistently.
function StateField({
  value, onChange, open, setOpen, editable = true,
}: {
  value: string;
  onChange: (next: string) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  editable?: boolean;
}) {
  const { C, ACCENT } = useTheme();
  return (
    <>
      <TouchableOpacity
        onPress={() => { if (editable) setOpen(!open); }}
        activeOpacity={editable ? 0.7 : 1}
        style={{
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          backgroundColor: editable ? C.surface : C.surfaceSunk,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: editable ? C.border : C.borderSoft,
          paddingHorizontal: 12, paddingVertical: 12,
          marginBottom: 4,
        }}>
        <Text style={[txt(value ? 700 : 500), { fontSize: 15, color: value ? C.t1 : C.t4 }]}>
          {value || (editable ? "Select" : "—")}
        </Text>
        {editable && <ChevronDown size={16} color={C.t3} />}
      </TouchableOpacity>
      {open && (
        <Modal transparent animationType="slide" visible onRequestClose={() => setOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setOpen(false)}
            style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" }}>
            <TouchableOpacity activeOpacity={1} style={{ backgroundColor: C.surface, paddingBottom: 24, maxHeight: "70%" }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}>
                {value
                  ? <TouchableOpacity onPress={() => { onChange(""); setOpen(false); }}>
                      <Text style={[txt(700), { fontSize: 14, color: C.redInk }]}>Clear</Text>
                    </TouchableOpacity>
                  : <View />}
                <Text style={[txt(800), { fontSize: 14, color: C.t1 }]}>Select State</Text>
                <TouchableOpacity onPress={() => setOpen(false)}>
                  <Text style={[txt(800), { fontSize: 14, color: ACCENT }]}>Done</Text>
                </TouchableOpacity>
              </View>
              <ScrollView>
                {US_STATES.map(s => {
                  const selected = s === value;
                  return (
                    <TouchableOpacity key={s}
                      onPress={() => { onChange(s); setOpen(false); }}
                      activeOpacity={0.6}
                      style={{
                        paddingHorizontal: 18, paddingVertical: 13,
                        borderBottomWidth: 1, borderBottomColor: C.bg,
                        backgroundColor: selected ? C.blueBg : "transparent",
                      }}>
                      <Text style={[txt(selected ? 800 : 600), { fontSize: 15, color: selected ? ACCENT : C.t1 }]}>
                        {s}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}
    </>
  );
}

function FormGrid({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", gap: 10 }}>{children}</View>;
}

function FormCol({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[{ flex: 1 }, style]}>{children}</View>;
}

function DocRow({
  doc, isLast, onView, onDelete,
}: {
  doc: DriverDocument; isLast: boolean; onView: () => void; onDelete: () => void;
}) {
  const { C, ACCENT } = useTheme();
  const tint = docKindTint(C)[doc.kind];
  const date = new Date(doc.uploadedAt);
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 10,
      paddingVertical: 10,
      borderBottomWidth: isLast ? 0 : 1, borderBottomColor: C.borderSoft,
    }}>
      <View style={{
        width: 32, height: 32, borderRadius: 8,
        backgroundColor: C.bg,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <FileText size={15} color={C.t3} strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: tint.bg }}>
            <Text style={[txt(700), { fontSize: 9, color: tint.fg, textTransform: 'uppercase', letterSpacing: 0.4 }]}>
              {DOC_KIND_LABEL[doc.kind]}
            </Text>
          </View>
          <Text style={[txt(500), { fontSize: 11, color: C.t4 }]}>
            {date.toLocaleDateString()}
          </Text>
        </View>
        <Text style={[txt(600), { fontSize: 13, color: C.t1 }]} numberOfLines={1}>
          {doc.fileName}
        </Text>
      </View>
      <TouchableOpacity onPress={onView} style={{ padding: 6 }}>
        <Eye size={16} color={ACCENT} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onDelete} style={{ padding: 6 }}>
        <Trash2 size={16} color={C.redInk} />
      </TouchableOpacity>
    </View>
  );
}

/**
 * Per-rule opt-out toggles for driver-facing auto notifications. A
 * toggle's state reflects the driver's explicit override; missing
 * override means the rule follows the org default (rendered as ON
 * — drivers see "on by default, tap to silence"). Manual dispatcher
 * nudges bypass these and always send.
 */
function NotificationsPrefs() {
  const { C, ACCENT } = useTheme();
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    railway.getNotificationPrefs()
      .then(({ prefs: p }) => { if (!cancelled) setPrefs(p); })
      .catch(() => { if (!cancelled) setPrefs({}); });
    return () => { cancelled = true; };
  }, []);

  // For UI purposes: "on" = either no override OR override=true.
  // Tapping flips between explicit-off and clear-override (which is
  // back to on by default).
  function isOn(ruleKey: string): boolean {
    if (prefs == null) return true;
    const explicit = prefs[ruleKey];
    if (explicit === false) return false;
    return true;
  }

  async function toggle(ruleKey: NotificationRuleKey) {
    if (prefs == null || busyKey) return;
    const currentlyOn = isOn(ruleKey);
    setBusyKey(ruleKey);
    try {
      // currentlyOn → switch to explicit off.
      // currently off → clear the override so it follows org default again.
      const { prefs: next } = await railway.setNotificationPref(
        ruleKey,
        currentlyOn ? false : null,
      );
      setPrefs(next);
    } catch (err) {
      console.error("[NotificationsPrefs] save failed:", err);
      Alert.alert("Couldn't save", "Try again in a moment.");
    } finally {
      setBusyKey(null);
    }
  }

  if (prefs == null) {
    return (
      <View style={{ paddingVertical: 18, alignItems: "center" }}>
        <ActivityIndicator color={ACCENT} />
      </View>
    );
  }

  return (
    <View style={{ paddingVertical: 6 }}>
      <Text style={[txt(500), { fontSize: 12, color: C.t3, marginBottom: 12 }]}>
        Choose which automatic alerts you'll get. Your dispatcher can still
        send you direct messages — those always come through.
      </Text>
      {NOTIFICATION_RULE_KEYS.map((ruleKey, i) => (
        <View
          key={ruleKey}
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            paddingVertical: 12,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: C.borderSoft,
            gap: 12,
          }}
        >
          <View style={{ flex: 1, justifyContent: "center" }}>
            <Text style={[txt(700), { fontSize: 14, color: C.t1 }]}>
              {NOTIFICATION_RULE_LABEL[ruleKey]}
            </Text>
          </View>
          <PrefSwitch
            value={isOn(ruleKey)}
            disabled={busyKey != null}
            onChange={() => void toggle(ruleKey)}
          />
        </View>
      ))}
    </View>
  );
}

/** Minimal on/off pill. Tapping toggles; disabled dims. */
function PrefSwitch({
  value, disabled, onChange,
}: { value: boolean; disabled: boolean; onChange: () => void }) {
  const { C, ACCENT } = useTheme();
  return (
    <TouchableOpacity
      onPress={onChange}
      disabled={disabled}
      style={{
        width: 50, height: 28, borderRadius: 14,
        backgroundColor: value ? ACCENT : C.borderStrong,
        opacity: disabled ? 0.5 : 1,
        padding: 2,
        justifyContent: "center",
      }}
      activeOpacity={0.7}
    >
      <View style={{
        width: 24, height: 24, borderRadius: 12,
        backgroundColor: "#ffffff",
        alignSelf: value ? "flex-end" : "flex-start",
      }} />
    </TouchableOpacity>
  );
}
