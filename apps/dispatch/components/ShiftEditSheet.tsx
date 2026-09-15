/**
 * Correct a shift's recorded times.
 *
 * Two people reach this and the API decides which is allowed:
 *   · the shift's owner, with `timesheet.self` — fixing the punch you
 *     forgot to make at 7am. This is the common case by far.
 *   · a reviewer, with `timesheet.edit` — anyone's shift.
 *
 * ── Why the times are shown as local wall-clock ───────────────────────
 *
 * Shifts are stored as absolute instants (timestamptz). The person
 * editing is standing in the timezone the work happened in and thinks
 * in "I actually started at 7", so the picker works in device-local
 * time and converts back to an instant on save. Doing this in UTC would
 * show someone a 2pm start for a 7am shift.
 *
 * ── What this sheet refuses to hide ───────────────────────────────────
 *
 * Every save stamps edited_by / edited_at server-side, and the row
 * renders an EDITED badge afterwards. That is deliberate: letting
 * someone adjust the hours they are paid from is only reasonable if
 * the adjustment is visible. The sheet says so in plain words rather
 * than burying it.
 *
 * The overlap constraint can also reject a save (two shifts for the
 * same person can't cover the same minutes). That comes back as a 409
 * and is surfaced as a real explanation, not "save failed".
 */
import React, { useEffect, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ActivityIndicator, Alert,
} from "react-native";
import { X, Clock, Info } from "lucide-react-native";
import type { TimesheetShift } from "@fleetcal/types";
import { txt } from "@/lib/font";
import { railway } from "@/lib/railway";
import { DateTimePickerSheet } from "./DateTimePickerSheet";

interface Props {
  visible: boolean;
  shift:   TimesheetShift | null;
  onClose: () => void;
  onSaved: () => void;
}

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Absolute instant → "YYYY-MM-DDTHH:mm" in device-local time, which is
 *  the shape DateTimePickerSheet parses. */
function toLocalNaive(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
       + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm" in device-local time → absolute instant. `new
 *  Date(naive)` is parsed as LOCAL by JS when there's no Z or offset,
 *  which is what we want here. */
function fromLocalNaive(naive: string): string {
  return new Date(naive).toISOString();
}

function fmtLocal(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function ShiftEditSheet({ visible, shift, onClose, onSaved }: Props) {
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [endedAt,   setEndedAt]   = useState<string | null>(null);
  const [picking,   setPicking]   = useState<"start" | "end" | null>(null);
  const [saving,    setSaving]    = useState(false);

  useEffect(() => {
    if (!visible || !shift) return;
    setStartedAt(shift.startedAt);
    setEndedAt(shift.endedAt ?? null);
    setPicking(null);
  }, [visible, shift]);

  if (!shift) return null;

  const running = !shift.endedAt;
  const dirty =
    startedAt !== shift.startedAt || endedAt !== (shift.endedAt ?? null);

  async function handleSave() {
    if (!shift || !startedAt || saving) return;
    // The DB enforces this too (CHECK ended_at > started_at), but a
    // local check gives a useful message instead of a round trip.
    if (endedAt && new Date(endedAt).getTime() <= new Date(startedAt).getTime()) {
      Alert.alert("Check the times", "Clock-out has to be after clock-in.");
      return;
    }
    setSaving(true);
    try {
      await railway.updateTimesheetShift(shift.id, {
        startedAt,
        ...(shift.endedAt || endedAt ? { endedAt } : {}),
      });
      onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("overlaps_existing_shift")) {
        Alert.alert(
          "Times overlap another shift",
          "Those hours run into a different shift for this person. Fix the other one first, or pick times that don't collide.",
        );
      } else if (msg.includes("forbidden")) {
        Alert.alert("Not allowed", "You can only correct your own shifts.");
      } else {
        Alert.alert("Couldn't save", msg);
      }
    } finally {
      setSaving(false);
    }
  }

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
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            paddingBottom: 28,
          }}
        >
          {/* Header */}
          <View style={{
            flexDirection: "row", alignItems: "center", gap: 10,
            paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12,
            borderBottomWidth: 1, borderBottomColor: "#e8eaed",
          }}>
            <Text style={[txt(800), { fontSize: 17, color: "#202124", flex: 1 }]}>
              Correct times
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <View style={{ padding: 16, gap: 12 }}>
            <TimeRow
              label="Clocked in"
              value={startedAt ? fmtLocal(startedAt) : "—"}
              onPress={() => setPicking("start")}
            />
            <TimeRow
              label="Clocked out"
              value={endedAt ? fmtLocal(endedAt) : (running ? "Still running" : "—")}
              onPress={() => setPicking("end")}
              hint={running ? "Setting a clock-out time ends this shift." : undefined}
            />

            <View style={{
              flexDirection: "row", gap: 8, alignItems: "flex-start",
              backgroundColor: "#f1f3f4", borderRadius: 10, padding: 12,
            }}>
              <Info size={14} color="#5f6368" strokeWidth={2.2} style={{ marginTop: 1 }} />
              <Text style={[txt(500), { fontSize: 12, color: "#5f6368", flex: 1 }]}>
                Corrections are recorded — this shift will show who changed
                it and when.
              </Text>
            </View>

            <TouchableOpacity
              onPress={handleSave}
              disabled={!dirty || saving}
              activeOpacity={0.85}
              style={{
                marginTop: 4, paddingVertical: 14, borderRadius: 12,
                alignItems: "center", justifyContent: "center",
                backgroundColor: !dirty || saving ? "#c6c9cc" : "#1a73e8",
              }}
            >
              {saving
                ? <ActivityIndicator color="#ffffff" />
                : <Text style={[txt(800), { fontSize: 15, color: "#ffffff", letterSpacing: 0.3 }]}>
                    SAVE
                  </Text>}
            </TouchableOpacity>
          </View>

          <DateTimePickerSheet
            visible={picking !== null}
            mode="single"
            title={picking === "end" ? "Clocked out" : "Clocked in"}
            initial={toLocalNaive(
              picking === "end"
                ? (endedAt ?? new Date().toISOString())
                : (startedAt ?? shift.startedAt),
            )}
            onClose={() => setPicking(null)}
            onSave={(naive) => {
              const iso = fromLocalNaive(naive);
              if (picking === "end") setEndedAt(iso);
              else                   setStartedAt(iso);
              setPicking(null);
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function TimeRow({
  label, value, onPress, hint,
}: {
  label: string;
  value: string;
  onPress: () => void;
  hint?: string;
}) {
  return (
    <View>
      <Text style={[txt(700), { fontSize: 11, color: "#5f6368", letterSpacing: 0.5, marginBottom: 6 }]}>
        {label.toUpperCase()}
      </Text>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.75}
        style={{
          flexDirection: "row", alignItems: "center", gap: 10,
          borderWidth: 1, borderColor: "#dadce0", borderRadius: 10,
          paddingHorizontal: 14, paddingVertical: 13,
        }}
      >
        <Clock size={15} color="#5f6368" strokeWidth={2.2} />
        <Text style={[txt(700), { fontSize: 14, color: "#202124", flex: 1 }]}>
          {value}
        </Text>
      </TouchableOpacity>
      {hint ? (
        <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", marginTop: 5 }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
