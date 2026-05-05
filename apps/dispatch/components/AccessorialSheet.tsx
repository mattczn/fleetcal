import React, { useEffect, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, TextInput, ScrollView,
  KeyboardAvoidingView, Platform, Switch, Alert,
} from "react-native";
import { X, Trash2, DollarSign } from "lucide-react-native";
import { txt } from "@/lib/font";
import type { Accessorial, AccessorialCategory } from "@/lib/types";

const CATEGORIES: { id: AccessorialCategory; label: string }[] = [
  { id: "detention",    label: "Detention" },
  { id: "lumper",       label: "Lumper" },
  { id: "layover",      label: "Layover" },
  { id: "scale_ticket", label: "Scale Ticket" },
  { id: "other",        label: "Other" },
];

const STATUSES: { id: Accessorial["status"] | ""; label: string }[] = [
  { id: "",          label: "—" },
  { id: "requested", label: "Requested" },
  { id: "approved",  label: "Approved" },
  { id: "denied",    label: "Denied" },
];

const ACC_COLOR  = "#1a73e8";
const PAY_COLOR  = "#1e8e3e";

interface Props {
  visible:  boolean;
  /** Existing accessorial when editing; `null` for the add flow. */
  initial:  Accessorial | null;
  /** Drivers eligible to receive the pay-to-driver portion (load driver + relay partner). */
  payOpts:  string[];
  onClose:  () => void;
  onSave:   (acc: Accessorial) => void;
  onDelete?: () => void;
}

/**
 * Local genId — keeps the sheet self-contained (we can't rely on `crypto.randomUUID`
 * being available on all RN runtimes, and Hermes' implementation isn't worth pulling
 * in just for this).
 */
function genId(): string {
  return `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function AccessorialSheet({ visible, initial, payOpts, onClose, onSave, onDelete }: Props) {
  const [category,    setCategory]    = useState<AccessorialCategory>("detention");
  const [description, setDescription] = useState("");
  const [amountStr,   setAmountStr]   = useState("");
  const [status,      setStatus]      = useState<Accessorial["status"] | "">("");
  const [billable,    setBillable]    = useState(true);
  const [payToDriver, setPayToDriver] = useState(false);
  const [payDriverName, setPayDriverName] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!visible) return;
    if (initial) {
      setCategory(initial.category);
      setDescription(initial.description ?? "");
      setAmountStr(initial.amount ? String(initial.amount) : "");
      setStatus(initial.status ?? "");
      setBillable(initial.billable);
      setPayToDriver(!!initial.payToDriver);
      setPayDriverName(initial.payDriverName);
    } else {
      setCategory("detention");
      setDescription("");
      setAmountStr("");
      setStatus("");
      setBillable(true);
      setPayToDriver(false);
      setPayDriverName(payOpts[0]);
    }
  }, [visible, initial, payOpts]);

  function handleSave() {
    const amount = parseFloat(amountStr) || 0;
    onSave({
      id:            initial?.id ?? genId(),
      category,
      description:   description.trim() || undefined,
      amount,
      billable,
      status:        status || undefined,
      payToDriver:   payToDriver || undefined,
      payDriverName: payToDriver ? payDriverName : undefined,
    });
  }

  function handleDelete() {
    if (!onDelete) return;
    Alert.alert(
      "Remove accessorial?",
      "This won't take effect until you save the load.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: onDelete },
      ],
    );
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)" }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1, justifyContent: "flex-end" }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: "#ffffff",
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              paddingBottom: 28, paddingTop: 8,
              maxHeight: "92%",
            }}
          >
            {/* Header */}
            <View style={{
              flexDirection: "row", alignItems: "center",
              paddingHorizontal: 18, paddingVertical: 14,
              borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
            }}>
              <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
                {initial ? "Edit Accessorial" : "Add Accessorial"}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={10}>
                <X size={20} color="#5f6368" strokeWidth={2.2} />
              </TouchableOpacity>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: 18, paddingBottom: 12 }}
            >
              {/* Category */}
              <Text style={[txt(800), styles.fieldLabel]}>Category</Text>
              <View style={styles.chipRow}>
                {CATEGORIES.map((c) => {
                  const active = c.id === category;
                  return (
                    <TouchableOpacity
                      key={c.id}
                      onPress={() => setCategory(c.id)}
                      activeOpacity={0.8}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 8,
                        borderRadius: 999,
                        backgroundColor: active ? ACC_COLOR : "#f1f3f4",
                      }}
                    >
                      <Text style={[txt(800), {
                        fontSize: 12, letterSpacing: 0.2,
                        color: active ? "#ffffff" : "#3c4043",
                      }]}>
                        {c.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Description */}
              <Text style={[txt(800), styles.fieldLabel, { marginTop: 16 }]}>Description</Text>
              <View style={styles.inputBox}>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="Optional details (e.g. 2 hr detention at JBS)"
                  placeholderTextColor="#9aa0a6"
                  autoCapitalize="sentences"
                  style={[txt(600), { flex: 1, fontSize: 14, color: "#202124", padding: 0 }]}
                />
              </View>

              {/* Amount */}
              <Text style={[txt(800), styles.fieldLabel, { marginTop: 16 }]}>Amount</Text>
              <View style={[styles.inputBox, { flexDirection: "row", alignItems: "center", gap: 6 }]}>
                <DollarSign size={15} color="#5f6368" strokeWidth={2.4} />
                <TextInput
                  value={amountStr}
                  onChangeText={(t) => setAmountStr(t.replace(/[^0-9.]/g, ""))}
                  placeholder="0.00"
                  placeholderTextColor="#9aa0a6"
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  style={[txt(700), { flex: 1, fontSize: 16, color: "#202124", padding: 0 }]}
                />
              </View>

              {/* Status */}
              <Text style={[txt(800), styles.fieldLabel, { marginTop: 16 }]}>Status</Text>
              <View style={styles.chipRow}>
                {STATUSES.map((s) => {
                  const active = s.id === status;
                  return (
                    <TouchableOpacity
                      key={s.id || "none"}
                      onPress={() => setStatus(s.id)}
                      activeOpacity={0.8}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 8,
                        borderRadius: 999,
                        backgroundColor: active ? ACC_COLOR : "#f1f3f4",
                      }}
                    >
                      <Text style={[txt(800), {
                        fontSize: 12, letterSpacing: 0.2,
                        color: active ? "#ffffff" : "#3c4043",
                      }]}>
                        {s.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Billable */}
              <ToggleRow
                label="Billable to broker"
                description="Counts toward the broker invoice total."
                value={billable}
                color={ACC_COLOR}
                onChange={setBillable}
              />

              {/* Pay Driver */}
              <ToggleRow
                label="Pay to driver"
                description="Flows into payroll as an adjustment."
                value={payToDriver}
                color={PAY_COLOR}
                onChange={(v) => {
                  setPayToDriver(v);
                  if (v && !payDriverName && payOpts.length > 0) setPayDriverName(payOpts[0]);
                }}
              />

              {payToDriver && payOpts.length > 1 ? (
                <>
                  <Text style={[txt(800), styles.fieldLabel, { marginTop: 12 }]}>Pay which driver</Text>
                  <View style={styles.chipRow}>
                    {payOpts.map((name) => {
                      const active = payDriverName === name;
                      return (
                        <TouchableOpacity
                          key={name}
                          onPress={() => setPayDriverName(name)}
                          activeOpacity={0.8}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 8,
                            borderRadius: 999,
                            backgroundColor: active ? PAY_COLOR : "#f1f3f4",
                          }}
                        >
                          <Text style={[txt(800), {
                            fontSize: 12, letterSpacing: 0.2,
                            color: active ? "#ffffff" : "#3c4043",
                          }]}>
                            {name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              ) : null}
            </ScrollView>

            {/* Footer actions */}
            <View style={{
              flexDirection: "row", alignItems: "center", gap: 10,
              paddingHorizontal: 18, paddingTop: 12,
              borderTopWidth: 1, borderTopColor: "#f1f3f4",
            }}>
              {initial && onDelete ? (
                <TouchableOpacity
                  onPress={handleDelete}
                  hitSlop={6}
                  style={{
                    width: 44, height: 44, borderRadius: 14,
                    backgroundColor: "#fce8e6",
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Trash2 size={16} color="#b91c1c" strokeWidth={2.4} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={onClose}
                activeOpacity={0.7}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 14,
                  backgroundColor: "#f1f3f4",
                  alignItems: "center",
                }}
              >
                <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                activeOpacity={0.85}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 14,
                  backgroundColor: ACC_COLOR,
                  alignItems: "center",
                }}
              >
                <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                  {initial ? "Save changes" : "Add accessorial"}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function ToggleRow({
  label, description, value, color, onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  color: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 12,
      marginTop: 16,
      paddingVertical: 10, paddingHorizontal: 12,
      backgroundColor: "#f8f9fa", borderRadius: 12,
    }}>
      <View style={{ flex: 1 }}>
        <Text style={[txt(800), { fontSize: 13, color: "#202124" }]}>{label}</Text>
        <Text style={[txt(500), { fontSize: 11, color: "#5f6368", marginTop: 2 }]}>
          {description}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: color, false: "#dadce0" }}
        thumbColor="#ffffff"
      />
    </View>
  );
}

const styles = {
  fieldLabel: {
    fontSize: 11, letterSpacing: 0.6, color: "#5f6368",
    textTransform: "uppercase" as const, marginBottom: 8,
  },
  inputBox: {
    paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: "#f1f3f4", borderRadius: 12,
  },
  chipRow: {
    flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8,
  },
};
