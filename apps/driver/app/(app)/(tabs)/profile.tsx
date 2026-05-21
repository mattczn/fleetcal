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
  KeyboardAvoidingView, Platform, RefreshControl, Modal, Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  LogOut, User, FileText, Trash2, ExternalLink, Plus, Calendar as CalendarIcon, ChevronDown,
} from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import { supabase } from "@/lib/supabase";
import { railway, type DriverProfileUpdate, type DriverMeResponse } from "@/lib/railway";
import type { DriverDocument, DriverDocumentKind } from "@fleetcal/types";
import {
  NOTIFICATION_RULE_KEYS,
  NOTIFICATION_RULE_LABEL,
  NOTIFICATION_RULE_BLURB,
  type NotificationRuleKey,
} from "@fleetcal/types";
import { useOrgTz, describeTz } from "@/lib/orgTz";

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

const DOC_KIND_TINT: Record<DriverDocumentKind, { bg: string; fg: string }> = {
  license:      { bg: "#e8f0fe", fg: "#1a73e8" },
  medical_card: { bg: "#fce8e8", fg: "#c5221f" },
  mvr:          { bg: "#fef3c7", fg: "#92400e" },
  other:        { bg: "#f1f3f4", fg: "#5f6368" },
};

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
  const [me,         setMe]         = useState<DriverMeResponse | null>(null);
  const [docs,       setDocs]       = useState<DriverDocument[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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

  /**
   * Save a partial patch to /me. On failure, rolls local form state
   * back from the last known-good `me` so the field doesn't keep
   * showing the rejected value (which made drivers walk away thinking
   * they'd saved when they hadn't).
   *
   * Caller passes `revert` describing how to reset the relevant local
   * state from `me` — keeps this function generic across the ~10
   * field-level blur handlers that call it.
   */
  async function saveFields(
    patch: DriverProfileUpdate,
    opts: { refresh?: boolean; revert?: (last: DriverMeResponse) => void } = {},
  ) {
    try {
      await railway.updateMe(patch);
      // Refresh after name changes so the header reflects the
      // computed full name (server combines first + last).
      if (opts.refresh) await loadAll();
    } catch (err) {
      const msg = (err as Error).message ?? "Save failed";
      Alert.alert(
        "Save failed",
        `${msg}\n\nThe field has been reverted.`,
        [{ text: "OK" }],
      );
      // Roll the form back to the last-known server value so the
      // driver isn't staring at a value the server already rejected.
      if (opts.revert && me) opts.revert(me);
    }
  }

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

  async function viewDoc(d: DriverDocument) {
    if (!d.signedUrl) {
      Alert.alert("Unavailable", "Refresh and try again.");
      return;
    }
    await Linking.openURL(d.signedUrl);
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
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a73e8" }} edges={["top"]}>
      {/* Blue header */}
      <View style={{ backgroundColor: "#1a73e8", paddingTop: 8, paddingBottom: 28, alignItems: "center" }}>
        <View style={{
          width: 84, height: 84, borderRadius: 26,
          backgroundColor: "rgba(255,255,255,0.18)",
          alignItems: "center", justifyContent: "center",
          marginBottom: 12,
        }}>
          {initials !== "?" ? (
            <Text style={[txt(800), { fontSize: 30, color: "#fff", letterSpacing: -0.5 }]}>{initials}</Text>
          ) : (
            <User size={36} color="#fff" strokeWidth={2.2} />
          )}
        </View>
        <Text style={[txt(800), { fontSize: 22, color: "#fff", letterSpacing: -0.3 }]}>{me?.name ?? "—"}</Text>
        <Text style={[txt(500), { fontSize: 13, color: "rgba(255,255,255,0.65)", marginTop: 2 }]}>
          {me?.phone ?? "—"}
        </Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: "#f8f9fa" }}
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
              <Text style={[txt(700), { fontSize: 15, color: "#b91c1c", marginBottom: 8, textAlign: "center" }]}>
                Could not load your profile
              </Text>
              <Text style={[txt(500), { fontSize: 13, color: "#6b7280", textAlign: "center", marginBottom: 16 }]}>
                {loadError}
              </Text>
              <TouchableOpacity
                onPress={() => { setLoading(true); void loadAll(); }}
                style={{ backgroundColor: "#1a73e8", paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 }}
              >
                <Text style={[txt(700), { color: "#fff", fontSize: 13 }]}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* Account */}
              <SectionHeader label="Account" />
              <Card>
                <FormGrid>
                  <FormCol>
                    <FieldLabel label="First Name" />
                    <TextField value={firstName} onChangeText={setFirstName}
                      autoCapitalize="words"
                      onBlur={() => saveFields(
                        { firstName: firstName.trim() || null },
                        { refresh: true, revert: (last) => setFirstName(last.firstName ?? "") },
                      )} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="Last Name" />
                    <TextField value={lastName} onChangeText={setLastName}
                      autoCapitalize="words"
                      onBlur={() => saveFields(
                        { lastName: lastName.trim() || null },
                        { refresh: true, revert: (last) => setLastName(last.lastName ?? "") },
                      )} />
                  </FormCol>
                </FormGrid>
                <FieldLabel label="Phone" />
                <TextField value={phone} onChangeText={setPhone} keyboardType="phone-pad"
                  onBlur={() => saveFields(
                    { phone: phone.trim() || null },
                    { revert: (last) => setPhone(last.phone ?? "") },
                  )} />
                <FieldLabel label="Email" />
                <TextField value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none"
                  onBlur={() => saveFields(
                    { email: email.trim() || null },
                    { revert: (last) => setEmail(last.email ?? "") },
                  )} />
              </Card>

              {/* Address */}
              <SectionHeader label="Address" />
              <Card>
                <FieldLabel label="Street" />
                <TextField value={addr.street} onChangeText={(v) => setAddr({ ...addr, street: v })}
                  onBlur={() => saveFields(
                    { address: joinAddress(addr) },
                    { revert: (last) => setAddr(parseAddress(last.address)) },
                  )} />
                <FieldLabel label="City" />
                <TextField value={addr.city} onChangeText={(v) => setAddr({ ...addr, city: v })}
                  onBlur={() => saveFields(
                    { address: joinAddress(addr) },
                    { revert: (last) => setAddr(parseAddress(last.address)) },
                  )} />
                <FormGrid>
                  <FormCol>
                    <FieldLabel label="State" />
                    <StateField value={addr.state}
                      open={statePickerOpen === 'addr'}
                      setOpen={(v) => setStatePickerOpen(v ? 'addr' : null)}
                      onChange={(s) => {
                        const next = { ...addr, state: s };
                        setAddr(next);
                        void saveFields(
                          { address: joinAddress(next) },
                          { revert: (last) => setAddr(parseAddress(last.address)) },
                        );
                      }}
                    />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="Zip" />
                    <TextField value={addr.zip} onChangeText={(v) => setAddr({ ...addr, zip: v.replace(/[^\d-]/g, "").slice(0, 10) })}
                      keyboardType="number-pad"
                      onBlur={() => saveFields(
                        { address: joinAddress(addr) },
                        { revert: (last) => setAddr(parseAddress(last.address)) },
                      )} />
                  </FormCol>
                </FormGrid>
              </Card>

              {/* License */}
              <SectionHeader label="License" />
              <Card>
                <FormGrid>
                  <FormCol style={{ flex: 2 }}>
                    <FieldLabel label="License #" />
                    <TextField value={licenseNumber} onChangeText={setLicenseNumber}
                      autoCapitalize="characters"
                      onBlur={() => saveFields(
                        { licenseNumber: licenseNumber.trim() || null },
                        { revert: (last) => setLicenseNumber(last.licenseNumber ?? "") },
                      )} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="State" />
                    <StateField value={licenseState}
                      open={statePickerOpen === 'license'}
                      setOpen={(v) => setStatePickerOpen(v ? 'license' : null)}
                      onChange={(s) => {
                        setLicenseState(s);
                        void saveFields(
                          { licenseState: s || null },
                          { revert: (last) => setLicenseState(last.licenseState ?? "") },
                        );
                      }}
                    />
                  </FormCol>
                </FormGrid>
                <FieldLabel label="Expiration" />
                <DateField
                  value={licenseExp}
                  onChange={(iso) => {
                    setLicenseExp(iso);
                    void saveFields(
                      { licenseExp: iso ?? null },
                      { revert: (last) => setLicenseExp(last.licenseExp) },
                    );
                  }}
                  open={pickerOpen === 'licenseExp'}
                  setOpen={(v) => setPickerOpen(v ? 'licenseExp' : null)}
                />
              </Card>

              {/* Compliance */}
              <SectionHeader label="Compliance" />
              <Card>
                <FieldLabel label="Medical Card Expiration" />
                <DateField
                  value={medCardExp}
                  onChange={(iso) => {
                    setMedCardExp(iso);
                    void saveFields(
                      { medicalCardExp: iso ?? null },
                      { revert: (last) => setMedCardExp(last.medicalCardExp) },
                    );
                  }}
                  open={pickerOpen === 'medicalCardExp'}
                  setOpen={(v) => setPickerOpen(v ? 'medicalCardExp' : null)}
                />
                <FieldLabel label="Date of Birth" />
                <DateField
                  value={dob}
                  onChange={(iso) => {
                    setDob(iso);
                    void saveFields(
                      { dob: iso ?? null },
                      { revert: (last) => setDob(last.dob) },
                    );
                  }}
                  open={pickerOpen === 'dob'}
                  setOpen={(v) => setPickerOpen(v ? 'dob' : null)}
                  /* DOB is bounded — no future dates. */
                  maximumDate={new Date()}
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
                    borderWidth: 1.5, borderColor: '#1a73e8', borderStyle: 'dashed',
                    backgroundColor: '#e8f0fe',
                    marginBottom: docs.length > 0 ? 12 : 0,
                  }}>
                  <Plus size={16} color="#1a73e8" strokeWidth={2.4} />
                  <Text style={[txt(700), { fontSize: 14, color: '#1a73e8' }]}>Upload Document</Text>
                </TouchableOpacity>
                {docs.length === 0 ? (
                  <Text style={[txt(500), { fontSize: 12, color: '#9aa0a6', textAlign: 'center', paddingVertical: 12 }]}>
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
                    backgroundColor: "#f1f3f4",
                    borderRadius: 8,
                    borderWidth: 1, borderColor: "#e8eaed",
                  }}>
                    <Text style={[txt(700), { fontSize: 14, color: "#3c4043" }]}>
                      {describeTz(orgTz)}
                    </Text>
                  </View>
                  <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", marginTop: 6 }]}>
                    Set by your dispatcher. All times in this app display in this timezone.
                  </Text>
                </View>
              </Card>

              {/* Notifications */}
              <SectionHeader label="Notifications" />
              <Card>
                <NotificationsPrefs />
              </Card>

              {/* Sign out */}
              <TouchableOpacity onPress={handleSignOut}
                style={{
                  marginTop: 8,
                  flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                  paddingVertical: 16,
                  backgroundColor: "#fef2f2",
                  borderRadius: 14,
                  borderWidth: 1, borderColor: "#fecaca",
                }}>
                <LogOut size={16} color="#b91c1c" strokeWidth={2.2} />
                <Text style={[txt(800), { fontSize: 14, color: "#b91c1c", letterSpacing: 0.2 }]}>Sign Out</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <Text style={[txt(800), {
      fontSize: 11, letterSpacing: 1.1, color: "#5f6368",
      marginBottom: 8, marginTop: 16, textTransform: "uppercase",
    }]}>
      {label}
    </Text>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View style={{
      backgroundColor: "#fff",
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderWidth: 1, borderColor: "#e8eaed",
    }}>
      {children}
    </View>
  );
}

function FieldLabel({ label }: { label: string }) {
  return (
    <Text style={[txt(700), {
      fontSize: 11, color: "#5f6368", letterSpacing: 0.5,
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
  onBlur?: () => void;
  placeholder?: string;
  keyboardType?: "default" | "email-address" | "number-pad" | "phone-pad" | "decimal-pad";
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  maxLength?: number;
}

function TextField({
  value, onChangeText, onBlur, placeholder, keyboardType, autoCapitalize, maxLength,
}: TextFieldProps) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      placeholder={placeholder}
      placeholderTextColor="#9aa0a6"
      keyboardType={keyboardType ?? "default"}
      autoCapitalize={autoCapitalize ?? "sentences"}
      maxLength={maxLength}
      style={[
        txt(600),
        {
          backgroundColor: "#fff",
          borderRadius: 10,
          borderWidth: 1, borderColor: "#e8eaed",
          paddingHorizontal: 12, paddingVertical: 10,
          fontSize: 15, color: "#202124",
          marginBottom: 4,
        },
      ]}
    />
  );
}

// Native date picker. iOS shows in a sheet, Android in a dialog.
function DateField({
  value, onChange, open, setOpen, maximumDate,
}: {
  value:        string | undefined;     // ISO YYYY-MM-DD
  onChange:     (iso: string | undefined) => void;
  open:         boolean;
  setOpen:      (v: boolean) => void;
  maximumDate?: Date;
}) {
  const display = isoToDisplay(value);

  function onPickerChange(_event: unknown, selected?: Date) {
    // iOS keeps the picker open in inline/spinner mode; Android
    // fires once with the selection and closes itself.
    if (Platform.OS !== 'ios') setOpen(false);
    if (selected) onChange(dateToIso(selected));
  }

  return (
    <>
      <TouchableOpacity onPress={() => setOpen(!open)}
        activeOpacity={0.7}
        style={{
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          backgroundColor: "#fff",
          borderRadius: 10,
          borderWidth: 1, borderColor: "#e8eaed",
          paddingHorizontal: 12, paddingVertical: 12,
          marginBottom: 4,
        }}>
        <Text style={[txt(display ? 700 : 500), { fontSize: 15, color: display ? "#202124" : "#9aa0a6" }]}>
          {display || "Select date"}
        </Text>
        <CalendarIcon size={16} color="#5f6368" />
      </TouchableOpacity>
      {open && Platform.OS === 'ios' && (
        <Modal transparent animationType="slide" visible onRequestClose={() => setOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setOpen(false)}
            style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' }}>
            <TouchableOpacity activeOpacity={1} style={{ backgroundColor: '#fff', paddingTop: 8, paddingBottom: 24 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 }}>
                {value
                  ? <TouchableOpacity onPress={() => { onChange(undefined); setOpen(false); }}>
                      <Text style={[txt(700), { fontSize: 14, color: '#b91c1c' }]}>Clear</Text>
                    </TouchableOpacity>
                  : <View />}
                <TouchableOpacity onPress={() => setOpen(false)}>
                  <Text style={[txt(800), { fontSize: 14, color: '#1a73e8' }]}>Done</Text>
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
  value, onChange, open, setOpen,
}: {
  value: string;
  onChange: (next: string) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  return (
    <>
      <TouchableOpacity onPress={() => setOpen(!open)}
        activeOpacity={0.7}
        style={{
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          backgroundColor: "#fff",
          borderRadius: 10,
          borderWidth: 1, borderColor: "#e8eaed",
          paddingHorizontal: 12, paddingVertical: 12,
          marginBottom: 4,
        }}>
        <Text style={[txt(value ? 700 : 500), { fontSize: 15, color: value ? "#202124" : "#9aa0a6" }]}>
          {value || "Select"}
        </Text>
        <ChevronDown size={16} color="#5f6368" />
      </TouchableOpacity>
      {open && (
        <Modal transparent animationType="slide" visible onRequestClose={() => setOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setOpen(false)}
            style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" }}>
            <TouchableOpacity activeOpacity={1} style={{ backgroundColor: "#fff", paddingBottom: 24, maxHeight: "70%" }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#f1f3f4" }}>
                {value
                  ? <TouchableOpacity onPress={() => { onChange(""); setOpen(false); }}>
                      <Text style={[txt(700), { fontSize: 14, color: "#b91c1c" }]}>Clear</Text>
                    </TouchableOpacity>
                  : <View />}
                <Text style={[txt(800), { fontSize: 14, color: "#202124" }]}>Select State</Text>
                <TouchableOpacity onPress={() => setOpen(false)}>
                  <Text style={[txt(800), { fontSize: 14, color: "#1a73e8" }]}>Done</Text>
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
                        borderBottomWidth: 1, borderBottomColor: "#f8f9fa",
                        backgroundColor: selected ? "#e8f0fe" : "transparent",
                      }}>
                      <Text style={[txt(selected ? 800 : 600), { fontSize: 15, color: selected ? "#1a73e8" : "#202124" }]}>
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
  const tint = DOC_KIND_TINT[doc.kind];
  const date = new Date(doc.uploadedAt);
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 10,
      paddingVertical: 10,
      borderBottomWidth: isLast ? 0 : 1, borderBottomColor: '#f1f3f4',
    }}>
      <View style={{
        width: 32, height: 32, borderRadius: 8,
        backgroundColor: '#f8f9fa',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <FileText size={15} color="#5f6368" strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: tint.bg }}>
            <Text style={[txt(700), { fontSize: 9, color: tint.fg, textTransform: 'uppercase', letterSpacing: 0.4 }]}>
              {DOC_KIND_LABEL[doc.kind]}
            </Text>
          </View>
          <Text style={[txt(500), { fontSize: 11, color: '#9aa0a6' }]}>
            {date.toLocaleDateString()}
          </Text>
        </View>
        <Text style={[txt(600), { fontSize: 13, color: '#202124' }]} numberOfLines={1}>
          {doc.fileName}
        </Text>
      </View>
      <TouchableOpacity onPress={onView} style={{ padding: 6 }}>
        <ExternalLink size={16} color="#1a73e8" />
      </TouchableOpacity>
      <TouchableOpacity onPress={onDelete} style={{ padding: 6 }}>
        <Trash2 size={16} color="#b91c1c" />
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
        <ActivityIndicator color="#1a73e8" />
      </View>
    );
  }

  return (
    <View style={{ paddingVertical: 6 }}>
      <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginBottom: 12 }]}>
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
            borderTopColor: "#f1f3f4",
            gap: 12,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={[txt(700), { fontSize: 14, color: "#202124", marginBottom: 2 }]}>
              {NOTIFICATION_RULE_LABEL[ruleKey]}
            </Text>
            <Text style={[txt(500), { fontSize: 12, color: "#5f6368" }]}>
              {NOTIFICATION_RULE_BLURB[ruleKey]}
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
  return (
    <TouchableOpacity
      onPress={onChange}
      disabled={disabled}
      style={{
        width: 50, height: 28, borderRadius: 14,
        backgroundColor: value ? "#1a73e8" : "#dadce0",
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
