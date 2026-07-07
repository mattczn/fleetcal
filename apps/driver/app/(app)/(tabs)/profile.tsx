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
import { useQuery } from "@tanstack/react-query";
import { useModules } from "@/lib/useModules";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import { supabase } from "@/lib/supabase";
import { railway, type DriverMeResponse } from "@/lib/railway";
import type { DriverDocument, DriverDocumentKind } from "@fleetcal/types";
import { useOrgTz, describeTz } from "@/lib/orgTz";
import { useTheme } from "@/lib/ThemeProvider";

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

  // ── Per-section edit mode ─────────────────────────────────────────
  // Each section (Account / Address / License / Compliance) has its
  // own independent editing state. Tapping Edit on a section unlocks
  // ONLY that section's fields — Save patches only those fields,
  // Discard rolls back only those fields. Multiple sections can be
  // in edit mode at once if the driver wants to update several
  // sections in parallel; Save commits each on its own.
  type Section = "account" | "address" | "license" | "compliance";
  const [accountEdit,    setAccountEdit]    = useState(false);
  const [addressEdit,    setAddressEdit]    = useState(false);
  const [licenseEdit,    setLicenseEdit]    = useState(false);
  const [complianceEdit, setComplianceEdit] = useState(false);
  // Tracks which section's save is currently in flight (null = none).
  // Mutually exclusive — saves are serialized so the spinner / disable
  // states don't race.
  const [savingSection, setSavingSection] = useState<Section | null>(null);

  function exitEdit(s: Section) {
    if (s === "account")    setAccountEdit(false);
    if (s === "address")    setAddressEdit(false);
    if (s === "license")    setLicenseEdit(false);
    if (s === "compliance") setComplianceEdit(false);
  }

  /** Reset a single section's local form state from the last server
   *  snapshot. Used by Discard and after a successful Save reload. */
  function resetSection(s: Section, src: DriverMeResponse) {
    if (s === "account") {
      setFirstName(src.firstName ?? "");
      setLastName(src.lastName ?? "");
      setPhone(src.phone ?? "");
      setEmail(src.email ?? "");
    } else if (s === "address") {
      setAddr(parseAddress(src.address));
    } else if (s === "license") {
      setLicenseNumber(src.licenseNumber ?? "");
      setLicenseState(src.licenseState ?? "");
      setLicenseExp(src.licenseExp);
    } else {
      setMedCardExp(src.medicalCardExp);
      setDob(src.dob);
    }
  }

  function discardSection(s: Section) {
    if (me) resetSection(s, me);
    // Only close the popup pickers that belong to this section so
    // edits in flight on a different section aren't disturbed.
    if (s === "address") {
      if (statePickerOpen === "addr") setStatePickerOpen(null);
    } else if (s === "license") {
      if (statePickerOpen === "license") setStatePickerOpen(null);
      if (pickerOpen === "licenseExp")   setPickerOpen(null);
    } else if (s === "compliance") {
      if (pickerOpen === "medicalCardExp" || pickerOpen === "dob") setPickerOpen(null);
    }
    exitEdit(s);
  }

  async function saveSection(s: Section) {
    if (savingSection) return;
    setSavingSection(s);
    try {
      const patch =
        s === "account" ? {
          firstName: firstName.trim() || null,
          lastName:  lastName.trim()  || null,
          phone:     phone.trim()     || null,
          email:     email.trim()     || null,
        } :
        s === "address" ? {
          address: joinAddress(addr),
        } :
        s === "license" ? {
          licenseNumber: licenseNumber.trim() || null,
          licenseState:  licenseState || null,
          licenseExp:    licenseExp ?? null,
        } : {
          medicalCardExp: medCardExp ?? null,
          dob:            dob ?? null,
        };
      await railway.updateMe(patch);
      await loadAll();
      exitEdit(s);
    } catch (err) {
      Alert.alert("Save failed", (err as Error).message ?? "Something went wrong.");
    } finally {
      setSavingSection(null);
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
        <Text style={[txt(800), { fontSize: 22, color: C.t1, letterSpacing: -0.3 }]}>{me?.name ?? "—"}</Text>
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
              {/* Inspection score — Curzon-only; renders nothing otherwise */}
              <ScorecardCard />

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

              {/* Account */}
              <SectionHeader label="Account"
                editing={accountEdit}
                saving={savingSection === "account"}
                onEdit={() => setAccountEdit(true)}
                onSave={() => saveSection("account")}
                onDiscard={() => discardSection("account")} />
              <Card>
                <FormGrid>
                  <FormCol>
                    <FieldLabel label="First Name" />
                    <TextField value={firstName} onChangeText={setFirstName}
                      autoCapitalize="words" editable={accountEdit} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="Last Name" />
                    <TextField value={lastName} onChangeText={setLastName}
                      autoCapitalize="words" editable={accountEdit} />
                  </FormCol>
                </FormGrid>
                <FieldLabel label="Phone" />
                <TextField value={phone} onChangeText={setPhone}
                  keyboardType="phone-pad" editable={accountEdit} />
                <FieldLabel label="Email" />
                <TextField value={email} onChangeText={setEmail}
                  keyboardType="email-address" autoCapitalize="none" editable={accountEdit} />
              </Card>

              {/* Address */}
              <SectionHeader label="Address"
                editing={addressEdit}
                saving={savingSection === "address"}
                onEdit={() => setAddressEdit(true)}
                onSave={() => saveSection("address")}
                onDiscard={() => discardSection("address")} />
              <Card>
                <FieldLabel label="Street" />
                <TextField value={addr.street}
                  onChangeText={(v) => setAddr({ ...addr, street: v })}
                  editable={addressEdit} />
                <FieldLabel label="City" />
                <TextField value={addr.city}
                  onChangeText={(v) => setAddr({ ...addr, city: v })}
                  editable={addressEdit} />
                <FormGrid>
                  <FormCol>
                    <FieldLabel label="State" />
                    <StateField value={addr.state}
                      open={statePickerOpen === 'addr'}
                      setOpen={(v) => setStatePickerOpen(v ? 'addr' : null)}
                      onChange={(s) => setAddr({ ...addr, state: s })}
                      editable={addressEdit}
                    />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="Zip" />
                    <TextField value={addr.zip}
                      onChangeText={(v) => setAddr({ ...addr, zip: v.replace(/[^\d-]/g, "").slice(0, 10) })}
                      keyboardType="number-pad" editable={addressEdit} />
                  </FormCol>
                </FormGrid>
              </Card>

              {/* License + Compliance + Documents all in MVP. */}
              <SectionHeader label="License"
                editing={licenseEdit}
                saving={savingSection === "license"}
                onEdit={() => setLicenseEdit(true)}
                onSave={() => saveSection("license")}
                onDiscard={() => discardSection("license")} />
              <Card>
                <FormGrid>
                  <FormCol style={{ flex: 2 }}>
                    <FieldLabel label="License #" />
                    <TextField value={licenseNumber} onChangeText={setLicenseNumber}
                      autoCapitalize="characters" editable={licenseEdit} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="State" />
                    <StateField value={licenseState}
                      open={statePickerOpen === 'license'}
                      setOpen={(v) => setStatePickerOpen(v ? 'license' : null)}
                      onChange={(s) => setLicenseState(s)}
                      editable={licenseEdit}
                    />
                  </FormCol>
                </FormGrid>
                <FieldLabel label="Expiration" />
                <DateField
                  value={licenseExp}
                  onChange={(iso) => setLicenseExp(iso)}
                  open={pickerOpen === 'licenseExp'}
                  setOpen={(v) => setPickerOpen(v ? 'licenseExp' : null)}
                  editable={licenseEdit}
                />
              </Card>

              {/* Compliance */}
              <SectionHeader label="Compliance"
                editing={complianceEdit}
                saving={savingSection === "compliance"}
                onEdit={() => setComplianceEdit(true)}
                onSave={() => saveSection("compliance")}
                onDiscard={() => discardSection("compliance")} />
              <Card>
                <FieldLabel label="Medical Card Expiration" />
                <DateField
                  value={medCardExp}
                  onChange={(iso) => setMedCardExp(iso)}
                  open={pickerOpen === 'medicalCardExp'}
                  setOpen={(v) => setPickerOpen(v ? 'medicalCardExp' : null)}
                  editable={complianceEdit}
                />
                <FieldLabel label="Date of Birth" />
                <DateField
                  value={dob}
                  onChange={(iso) => setDob(iso)}
                  open={pickerOpen === 'dob'}
                  setOpen={(v) => setPickerOpen(v ? 'dob' : null)}
                  /* DOB is bounded — no future dates. */
                  maximumDate={new Date()}
                  editable={complianceEdit}
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

              {/* Notifications section removed 2026-06-22 — per-rule
                  driver overrides weren't actually wired up end-to-end
                  for the auto-pushes that landed on the phone; the
                  toggles were UI-only. Until the rules get connected
                  to the cron, drivers don't see them. */}

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

/** Section label with an optional inline Edit / Save / Discard action
 *  group on the right. When `editing` / `onEdit` / etc. are omitted the
 *  header renders as a plain label (used for Appearance, Organization,
 *  Documents). When passed, the right side shows either a pencil Edit
 *  pill (read-only) or a Save + Discard pair (editing). All editable
 *  sections share the SAME edit state — tapping Edit on any section
 *  unlocks every editable field at once. */
function SectionHeader({
  label, editing, saving, onEdit, onSave, onDiscard,
}: {
  label:    string;
  editing?: boolean;
  saving?:  boolean;
  onEdit?:    () => void;
  onSave?:    () => void;
  onDiscard?: () => void;
}) {
  const { C, ACCENT } = useTheme();
  const hasActions = !!onEdit && !!onSave && !!onDiscard;
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", justifyContent: "space-between",
      marginBottom: 8, marginTop: 16, minHeight: 26,
    }}>
      <Text style={[txt(800), {
        fontSize: 11, letterSpacing: 1.1, color: C.t3,
        textTransform: "uppercase",
      }]}>
        {label}
      </Text>
      {hasActions ? (
        editing ? (
          <View style={{ flexDirection: "row", gap: 6 }}>
            <TouchableOpacity
              onPress={onDiscard}
              disabled={saving}
              activeOpacity={0.7}
              style={{
                flexDirection: "row", alignItems: "center", gap: 4,
                paddingHorizontal: 10, paddingVertical: 5,
                borderRadius: 999,
                backgroundColor: C.surfaceSunk,
                borderWidth: 1, borderColor: C.border,
                opacity: saving ? 0.5 : 1,
              }}
            >
              <X size={11} color={C.t2} strokeWidth={2.4} />
              <Text style={[txt(700), { fontSize: 11, color: C.t2 }]}>Discard</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onSave}
              disabled={saving}
              activeOpacity={0.7}
              style={{
                flexDirection: "row", alignItems: "center", gap: 4,
                paddingHorizontal: 10, paddingVertical: 5,
                borderRadius: 999,
                backgroundColor: ACCENT,
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving
                ? <ActivityIndicator color="#fff" size="small" />
                : <Check size={11} color="#fff" strokeWidth={2.4} />}
              <Text style={[txt(800), { fontSize: 11, color: "#fff", letterSpacing: 0.2 }]}>
                {saving ? "Saving" : "Save"}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            onPress={onEdit}
            activeOpacity={0.7}
            style={{
              flexDirection: "row", alignItems: "center", gap: 4,
              paddingHorizontal: 10, paddingVertical: 5,
              borderRadius: 999,
              backgroundColor: C.blueBg,
            }}
          >
            <Pencil size={11} color={ACCENT} strokeWidth={2.4} />
            <Text style={[txt(700), { fontSize: 11, color: ACCENT }]}>Edit</Text>
          </TouchableOpacity>
        )
      ) : null}
    </View>
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

/** Inspection score — the driver's own read-only scorecard, so they can
 *  monitor it and see how to improve. Curzon-only: gated on the Truck
 *  History module and the endpoint's `enabled` flag, so it renders nothing
 *  for orgs without it. Score = share of driving days with ≥1 inspection;
 *  cleanliness is intentionally not part of it. */
function ScorecardCard() {
  const { C } = useTheme();
  const { truckHistory } = useModules();
  const { data, isLoading } = useQuery({
    queryKey: ["driver-scorecard"],
    queryFn:  () => railway.getScorecard(),
    enabled:  truckHistory,
    staleTime: 5 * 60 * 1000,
  });

  if (!truckHistory) return null;
  if (data && !data.enabled) return null;

  const score     = data?.score ?? 0;
  const activeDays     = data?.activeDays ?? 0;
  const inspectionDays = data?.inspectionDays ?? 0;
  const completionPct  = data?.completionPct ?? 0;
  const noData = activeDays === 0 && inspectionDays === 0;

  const monthLabel = new Date(`${data?.to ?? new Date().toISOString().slice(0, 10)}T00:00:00`)
    .toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const tone = score >= 85
    ? { fg: C.greenInk, bar: C.green }
    : score >= 60
      ? { fg: C.amberInk, bar: C.amber }
      : { fg: C.redInk, bar: C.red };

  return (
    <>
      <SectionHeader label="Inspection score" />
      <Card>
        {isLoading && !data ? (
          <View style={{ paddingVertical: 20, alignItems: "center" }}>
            <ActivityIndicator />
          </View>
        ) : noData ? (
          <View style={{ paddingVertical: 12 }}>
            <Text style={[txt(500), { fontSize: 12, color: C.t3 }]}>{monthLabel}</Text>
            <Text style={[txt(600), { fontSize: 13.5, color: C.t2, marginTop: 6, lineHeight: 19 }]}>
              No driving days recorded yet this month. Your inspection score appears here once
              you&rsquo;re back on the road.
            </Text>
          </View>
        ) : (
          <View style={{ paddingVertical: 6 }}>
            {/* Score */}
            <Text style={[txt(500), { fontSize: 12, color: C.t3 }]}>{monthLabel}</Text>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, marginTop: 2 }}>
              <Text style={[txt(800), { fontSize: 40, color: tone.fg, letterSpacing: -1 }]}>{score}</Text>
              <Text style={[txt(700), { fontSize: 16, color: C.t3, marginBottom: 7 }]}>/100</Text>
            </View>

            {/* Completion bar */}
            <View style={{ height: 8, borderRadius: 999, backgroundColor: C.surfaceSunk, marginTop: 14, overflow: "hidden" }}>
              <View style={{ width: `${completionPct}%`, height: "100%", borderRadius: 999, backgroundColor: tone.bar }} />
            </View>
            <Text style={[txt(500), { fontSize: 12.5, color: C.t2, marginTop: 8 }]}>
              Inspections on {inspectionDays} of {activeDays} driving days ({completionPct}%)
            </Text>

            {/* How to improve */}
            <View style={{ marginTop: 12, padding: 12, borderRadius: 10, backgroundColor: C.surfaceSunk }}>
              <Text style={[txt(700), { fontSize: 12.5, color: C.t1, marginBottom: 3 }]}>
                {score >= 85 ? "Keep it up" : "How to improve"}
              </Text>
              <Text style={[txt(500), { fontSize: 12.5, color: C.t2, lineHeight: 18 }]}>
                Complete both your pre-trip and post-trip inspections every day you drive, and report any maintenance issues in the app.
              </Text>
            </View>
          </View>
        )}
      </Card>
    </>
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

