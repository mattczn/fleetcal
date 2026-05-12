/**
 * Driver Profile — read + edit own HR / compliance fields, plus
 * upload + manage license / medical card / MVR / other documents.
 *
 * Fields save per-blur (no big "Save" button) to match the DriversModal
 * pattern on the dispatch side. Documents upload one at a time and the
 * list refreshes after each operation.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Phone, BadgeCheck, Building2, Info, LogOut, User, Mail, MapPin,
  IdCard, Heart, Calendar as CalendarIcon, FileText, Camera, Trash2, ExternalLink,
} from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "@/lib/supabase";
import { railway, type DriverProfileUpdate, type DriverMeResponse } from "@/lib/railway";
import type { DriverDocument, DriverDocumentKind } from "@fleetcal/types";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const DOC_KINDS: { key: DriverDocumentKind; label: string }[] = [
  { key: 'license',      label: 'License'        },
  { key: 'medical_card', label: 'Medical Card'   },
  { key: 'mvr',          label: 'MVR'            },
  { key: 'other',        label: 'Other'          },
];

// ── Address ↔ structured helpers ────────────────────────────────────────
//
// We store the address as a single text field in the DB but capture it
// in 4 structured inputs (street, city, state, zip) for usability.
// On save: join "Street, City, ST Zip". On load: best-effort parse via
// regex — if it doesn't match, dump the whole thing in `street` and
// leave city/state/zip blank so the driver can re-enter cleanly.

interface AddressParts { street: string; city: string; state: string; zip: string; }

function parseAddress(s: string | undefined): AddressParts {
  const empty = { street: "", city: "", state: "", zip: "" };
  if (!s) return empty;
  // "Street, City, ST Zip"  (zip optional, state 2-letter)
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

// ── Date helpers (MM/DD/YYYY ↔ ISO YYYY-MM-DD) ──────────────────────────

function isoToDisplay(iso?: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function displayToIso(display: string): string | null {
  const t = display.trim();
  if (!t) return null;
  // Accept "MM/DD/YYYY", "M/D/YYYY", or already-ISO.
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return t;
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

// ── Screen ──────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const [me,         setMe]         = useState<DriverMeResponse | null>(null);
  const [docs,       setDocs]       = useState<DriverDocument[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Editable form state — seeded from `me` after fetch.
  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [phone,     setPhone]     = useState("");
  const [email,     setEmail]     = useState("");
  const [addr,      setAddr]      = useState<AddressParts>({ street: "", city: "", state: "", zip: "" });
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseState,  setLicenseState]  = useState("");
  const [licenseExp,    setLicenseExp]    = useState("");
  const [medCardExp,    setMedCardExp]    = useState("");
  const [dob,           setDob]           = useState("");

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
      setLicenseExp(isoToDisplay(meRes.licenseExp));
      setMedCardExp(isoToDisplay(meRes.medicalCardExp));
      setDob(isoToDisplay(meRes.dob));
    } catch (err) {
      console.warn("[profile] load:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  // Save one or more fields. Used in onBlur handlers so the form
  // commits as the driver moves between inputs — no big save button.
  async function saveFields(patch: DriverProfileUpdate) {
    try {
      await railway.updateMe(patch);
    } catch (err) {
      Alert.alert("Save failed", (err as Error).message);
    }
  }

  function saveDateField(key: 'licenseExp' | 'medicalCardExp' | 'dob', display: string) {
    if (display.trim() === "") return saveFields({ [key]: null } as DriverProfileUpdate);
    const iso = displayToIso(display);
    if (!iso) {
      Alert.alert("Invalid date", "Use MM/DD/YYYY format.");
      return;
    }
    return saveFields({ [key]: iso } as DriverProfileUpdate);
  }

  async function uploadDoc(kind: DriverDocumentKind) {
    Alert.alert(
      "Add Document",
      undefined,
      [
        { text: "Take Photo", onPress: () => void startUpload(kind, "camera") },
        { text: "Choose from Library", onPress: () => void startUpload(kind, "library") },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  async function startUpload(kind: DriverDocumentKind, source: "camera" | "library") {
    try {
      const perm = source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Enable access in Settings.");
        return;
      }
      const res = source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 0.85 })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.85,
            allowsMultipleSelection: false,
          });
      if (res.canceled) return;
      const a = res.assets[0];
      if (!a) return;
      const form = new FormData();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form.append("file", { uri: a.uri, name: a.fileName ?? `doc-${Date.now()}.jpg`, type: a.mimeType ?? "image/jpeg" } as any);
      form.append("kind", kind);
      await railway.uploadMyDocument(form);
      await loadAll();
    } catch (err) {
      Alert.alert("Upload failed", (err as Error).message);
    }
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
          ) : (
            <>
              {/* Account */}
              <SectionHeader label="Account" />
              <Card>
                <ReadOnlyRow Icon={BadgeCheck} label="Driver ID" value={me ? `#${me.driverId}` : "—"} />
                <FieldDivider />
                <FormGrid>
                  <FormCol>
                    <FieldLabel label="First Name" />
                    <TextField value={firstName} onChangeText={setFirstName}
                      onBlur={() => saveFields({ firstName: firstName.trim() || null })} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="Last Name" />
                    <TextField value={lastName} onChangeText={setLastName}
                      onBlur={() => saveFields({ lastName: lastName.trim() || null })} />
                  </FormCol>
                </FormGrid>
                <FieldLabel label="Phone" />
                <TextField value={phone} onChangeText={setPhone} keyboardType="phone-pad"
                  onBlur={() => saveFields({ phone: phone.trim() || null })} />
                <FieldLabel label="Email" />
                <TextField value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none"
                  onBlur={() => saveFields({ email: email.trim() || null })} />
              </Card>

              {/* Address */}
              <SectionHeader label="Address" />
              <Card>
                <FieldLabel label="Street" />
                <TextField value={addr.street} onChangeText={(v) => setAddr({ ...addr, street: v })}
                  onBlur={() => saveFields({ address: joinAddress(addr) })} />
                <FieldLabel label="City" />
                <TextField value={addr.city} onChangeText={(v) => setAddr({ ...addr, city: v })}
                  onBlur={() => saveFields({ address: joinAddress(addr) })} />
                <FormGrid>
                  <FormCol>
                    <FieldLabel label="State" />
                    <TextField value={addr.state} onChangeText={(v) => setAddr({ ...addr, state: v.toUpperCase().slice(0, 2) })}
                      autoCapitalize="characters"
                      maxLength={2}
                      onBlur={() => saveFields({ address: joinAddress(addr) })} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="Zip" />
                    <TextField value={addr.zip} onChangeText={(v) => setAddr({ ...addr, zip: v.replace(/[^\d-]/g, "").slice(0, 10) })}
                      keyboardType="number-pad"
                      onBlur={() => saveFields({ address: joinAddress(addr) })} />
                  </FormCol>
                </FormGrid>
              </Card>

              {/* License */}
              <SectionHeader label="License" />
              <Card>
                <FormGrid>
                  <FormCol style={{ flex: 2 }}>
                    <FieldLabel label="License #" />
                    <TextField value={licenseNumber} onChangeText={setLicenseNumber} autoCapitalize="characters"
                      onBlur={() => saveFields({ licenseNumber: licenseNumber.trim() || null })} />
                  </FormCol>
                  <FormCol>
                    <FieldLabel label="State" />
                    <TextField value={licenseState} onChangeText={(v) => setLicenseState(v.toUpperCase().slice(0, 2))}
                      autoCapitalize="characters"
                      maxLength={2}
                      onBlur={() => saveFields({ licenseState: licenseState.trim() || null })} />
                  </FormCol>
                </FormGrid>
                <FieldLabel label="Expiration (MM/DD/YYYY)" />
                <TextField value={licenseExp} onChangeText={setLicenseExp} keyboardType="number-pad"
                  placeholder="MM/DD/YYYY"
                  onBlur={() => saveDateField('licenseExp', licenseExp)} />
              </Card>

              {/* Medical + DOB */}
              <SectionHeader label="Compliance" />
              <Card>
                <FieldLabel label="Medical Card Expiration (MM/DD/YYYY)" />
                <TextField value={medCardExp} onChangeText={setMedCardExp} keyboardType="number-pad"
                  placeholder="MM/DD/YYYY"
                  onBlur={() => saveDateField('medicalCardExp', medCardExp)} />
                <FieldLabel label="Date of Birth (MM/DD/YYYY)" />
                <TextField value={dob} onChangeText={setDob} keyboardType="number-pad"
                  placeholder="MM/DD/YYYY"
                  onBlur={() => saveDateField('dob', dob)} />
              </Card>

              {/* Documents */}
              <SectionHeader label="Documents" />
              <Card>
                {DOC_KINDS.map((k, idx) => {
                  const docsForKind = docs.filter(d => d.kind === k.key);
                  return (
                    <View key={k.key} style={{ paddingVertical: 12,
                      borderTopWidth: idx === 0 ? 0 : 1,
                      borderTopColor: "#e8eaed" }}>
                      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
                        <Text style={[txt(700), { flex: 1, fontSize: 13, color: "#202124" }]}>{k.label}</Text>
                        <TouchableOpacity onPress={() => uploadDoc(k.key)}
                          style={{
                            flexDirection: "row", alignItems: "center", gap: 4,
                            paddingHorizontal: 10, paddingVertical: 6,
                            borderRadius: 8,
                            backgroundColor: "#e8f0fe",
                          }}>
                          <Camera size={12} color="#1a73e8" />
                          <Text style={[txt(700), { fontSize: 11, color: "#1a73e8" }]}>Upload</Text>
                        </TouchableOpacity>
                      </View>
                      {docsForKind.length === 0 ? (
                        <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6" }]}>None uploaded.</Text>
                      ) : (
                        docsForKind.map(d => <DocRow key={d.id} doc={d} onDelete={() => deleteDoc(d)} />)
                      )}
                    </View>
                  );
                })}
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
      paddingVertical: 6,
      borderWidth: 1, borderColor: "#e8eaed",
    }}>
      {children}
    </View>
  );
}

function FieldDivider() {
  return <View style={{ height: 1, backgroundColor: "#f1f3f4", marginVertical: 6 }} />;
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

function FormGrid({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", gap: 10 }}>{children}</View>;
}

function FormCol({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[{ flex: 1 }, style]}>{children}</View>;
}

function ReadOnlyRow({
  Icon, label, value,
}: { Icon: typeof Phone; label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12 }}>
      <View style={{
        width: 28, height: 28, borderRadius: 8,
        backgroundColor: "#e8f0fe",
        alignItems: "center", justifyContent: "center",
        marginRight: 10,
      }}>
        <Icon size={14} color="#1a73e8" strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[txt(600), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4 }]}>{label.toUpperCase()}</Text>
        <Text style={[txt(700), { fontSize: 14, color: "#202124", marginTop: 1 }]}>{value}</Text>
      </View>
    </View>
  );
}

function DocRow({ doc, onDelete }: { doc: DriverDocument; onDelete: () => void }) {
  const date = new Date(doc.uploadedAt);
  const dateLabel = date.toLocaleDateString();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8 }}>
      <View style={{
        width: 28, height: 28, borderRadius: 8,
        backgroundColor: "#f8f9fa",
        alignItems: "center", justifyContent: "center",
        marginRight: 10,
      }}>
        <FileText size={14} color="#5f6368" strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[txt(600), { fontSize: 13, color: "#202124" }]} numberOfLines={1}>{doc.fileName}</Text>
        <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", marginTop: 1 }]}>
          {dateLabel}{doc.expiresOn ? ` · exp ${isoToDisplay(doc.expiresOn)}` : ""}
        </Text>
      </View>
      {doc.signedUrl && (
        <TouchableOpacity onPress={() => {
          // Open the signed URL in the system browser. Async import to
          // keep the screen lean.
          void (async () => {
            const { Linking } = await import("react-native");
            await Linking.openURL(doc.signedUrl!);
          })();
        }} style={{ padding: 6 }}>
          <ExternalLink size={16} color="#1a73e8" />
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={onDelete} style={{ padding: 6 }}>
        <Trash2 size={16} color="#b91c1c" />
      </TouchableOpacity>
    </View>
  );
}
