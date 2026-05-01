import React, { useEffect, useMemo, useState } from "react";
import { Modal, View, Text, TouchableOpacity, Pressable, ActivityIndicator, Platform } from "react-native";
import { Calendar, type DateData } from "react-native-calendars";
import { X, Clock } from "lucide-react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { txt } from "@/lib/font";

interface BaseProps {
  visible: boolean;
  saving?: boolean;
  onClose: () => void;
}

interface SingleProps extends BaseProps {
  /** Single-value mode — just pick one date/time. */
  mode?: "single";
  title:   string;
  initial: string;
  onSave:  (iso: string) => void;
}

interface RangeProps extends BaseProps {
  mode: "range";
  title?: string;
  initialStart: string;
  initialEnd:   string;
  onSave: (range: { start: string; end: string }) => void;
}

type Props = SingleProps | RangeProps;

function pad(n: number): string { return String(n).padStart(2, "0"); }
function parse(iso: string): { date: string; hour: number; minute: number } {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return { date: m[1], hour: parseInt(m[2], 10), minute: parseInt(m[3], 10) };
  const t = new Date();
  return {
    date:   `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`,
    hour:   t.getHours(),
    minute: 0,
  };
}
function buildIso(date: string, hour: number, minute: number): string {
  return `${date}T${pad(hour)}:${pad(minute)}`;
}
function snap15(m: number): number {
  return Math.max(0, Math.min(45, Math.round(m / 15) * 15));
}
/** Adds the given number of minutes to a {date, hour, minute} triple. */
function addMinutes(
  d: { date: string; hour: number; minute: number },
  delta: number,
): { date: string; hour: number; minute: number } {
  const [y, mo, day] = d.date.split("-").map(Number);
  const t = new Date(y, mo - 1, day, d.hour, d.minute);
  t.setMinutes(t.getMinutes() + delta);
  return {
    date:   `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`,
    hour:   t.getHours(),
    minute: t.getMinutes(),
  };
}

export function DateTimePickerSheet(props: Props) {
  const isRange = props.mode === "range";

  // Range-mode toggle: which side the user is editing right now.
  const [active, setActive] = useState<"start" | "end">("start");

  // Two parallel parsed states. In single mode, only the "start" set is used.
  const [sDate, setSDate]     = useState("");
  const [sHour, setSHour]     = useState(9);
  const [sMin,  setSMin]      = useState(0);
  const [eDate, setEDate]     = useState("");
  const [eHour, setEHour]     = useState(17);
  const [eMin,  setEMin]      = useState(0);

  // Initial sync when the sheet opens.
  useEffect(() => {
    if (!props.visible) return;
    if (isRange) {
      const ps = parse(props.initialStart);
      const startTriple = { date: ps.date, hour: ps.hour, minute: snap15(ps.minute) };
      // If end is missing/empty, default to start + 1h so the user lands on a
      // sensible value when they advance to the End step.
      const endTriple = props.initialEnd
        ? (() => { const pe = parse(props.initialEnd); return { date: pe.date, hour: pe.hour, minute: snap15(pe.minute) }; })()
        : addMinutes(startTriple, 60);
      setSDate(startTriple.date); setSHour(startTriple.hour); setSMin(startTriple.minute);
      setEDate(endTriple.date);   setEHour(endTriple.hour);   setEMin(endTriple.minute);
      setActive("start");
    } else {
      const p = parse(props.initial);
      setSDate(p.date); setSHour(p.hour); setSMin(snap15(p.minute));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible, isRange, isRange ? props.initialStart : props.initial, isRange ? props.initialEnd : ""]);

  // Active values feed the calendar + wheels.
  const date  = active === "start" ? sDate : eDate;
  const hour  = active === "start" ? sHour : eHour;
  const min   = active === "start" ? sMin  : eMin;
  const setDate = (v: string) => active === "start" ? setSDate(v) : setEDate(v);
  const setHour = (v: number) => active === "start" ? setSHour(v) : setEHour(v);
  const setMin  = (v: number) => active === "start" ? setSMin(v)  : setEMin(v);

  function handleSave() {
    if (props.mode === "range") {
      props.onSave({
        start: buildIso(sDate, sHour, sMin),
        end:   buildIso(eDate, eHour, eMin),
      });
    } else {
      props.onSave(buildIso(sDate, sHour, sMin));
    }
  }
  /** Range mode: advance from Start → End. If End is unset/before Start, snap it to Start + 1h. */
  function handleNext() {
    const startTriple = { date: sDate, hour: sHour, minute: sMin };
    const endTriple   = { date: eDate, hour: eHour, minute: eMin };
    const startMs = new Date(buildIso(startTriple.date, startTriple.hour, startTriple.minute).replace("T", " ")).getTime();
    const endMs   = eDate
      ? new Date(buildIso(endTriple.date, endTriple.hour, endTriple.minute).replace("T", " ")).getTime()
      : NaN;
    if (!Number.isFinite(endMs) || endMs <= startMs) {
      const auto = addMinutes(startTriple, 60);
      setEDate(auto.date); setEHour(auto.hour); setEMin(auto.minute);
    }
    setActive("end");
  }

  const headerLabel = useMemo(() => {
    if (isRange) return props.title ?? "Schedule";
    return `Edit ${props.title}`;
  }, [isRange, props]);

  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <Pressable
        onPress={props.onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            paddingBottom: 28, paddingTop: 8,
            maxHeight: "95%",
          }}
        >
          <View style={{
            flexDirection: "row", alignItems: "center",
            paddingHorizontal: 18, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
          }}>
            <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
              {headerLabel}
            </Text>
            <TouchableOpacity onPress={props.onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          {/* Range mode: Start/End toggle */}
          {isRange ? (
            <View style={{ flexDirection: "row", paddingHorizontal: 18, paddingTop: 10, gap: 8 }}>
              {(["start", "end"] as const).map((side) => {
                const isActive = active === side;
                const label = side === "start" ? "Start" : "End";
                const dateStr = side === "start" ? sDate : eDate;
                const h24    = side === "start" ? sHour : eHour;
                const m      = side === "start" ? sMin  : eMin;
                const ampm   = h24 >= 12 ? "PM" : "AM";
                const h12    = (h24 % 12) || 12;
                return (
                  <TouchableOpacity
                    key={side}
                    onPress={() => setActive(side)}
                    activeOpacity={0.8}
                    style={{
                      flex: 1, paddingVertical: 10, paddingHorizontal: 12,
                      borderRadius: 12,
                      backgroundColor: isActive ? "#e8f0fe" : "#f1f3f4",
                      borderWidth: 1, borderColor: isActive ? "#1a73e8" : "transparent",
                    }}
                  >
                    <Text style={[txt(800), { fontSize: 11, color: isActive ? "#1a73e8" : "#5f6368", letterSpacing: 0.5 }]}>
                      {label.toUpperCase()}
                    </Text>
                    <Text style={[txt(700), { fontSize: 13, color: dateStr ? "#202124" : "#9aa0a6", marginTop: 2 }]} numberOfLines={1}>
                      {dateStr ? `${dateStr} · ${pad(h12)}:${pad(m)} ${ampm}` : "Not set"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}

          <Calendar
            current={date}
            markedDates={{ [date]: { selected: true, selectedColor: "#1a73e8" } }}
            onDayPress={(d: DateData) => setDate(d.dateString)}
            theme={{
              todayTextColor: "#1a73e8",
              arrowColor:     "#1a73e8",
              selectedDayBackgroundColor: "#1a73e8",
              selectedDayTextColor: "#ffffff",
              textDayFontFamily:       "PlusJakartaSans_600SemiBold",
              textDayHeaderFontFamily: "PlusJakartaSans_700Bold",
              textMonthFontFamily:     "PlusJakartaSans_800ExtraBold",
              textMonthFontSize: 16,
              textDayFontSize:   14,
            }}
          />

          {/* Native time spinner — iOS wheel, Android clock dialog. */}
          <View style={{ paddingHorizontal: 18, paddingTop: 6, paddingBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <Clock size={14} color="#5f6368" strokeWidth={2.2} />
              <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.5 }]}>
                TIME
              </Text>
            </View>
            <View style={{ alignItems: "center", justifyContent: "center" }}>
              <DateTimePicker
                value={(() => {
                  const d = new Date();
                  d.setHours(hour, min, 0, 0);
                  return d;
                })()}
                mode="time"
                display={Platform.OS === "ios" ? "spinner" : "clock"}
                minuteInterval={15}
                onChange={(_, picked) => {
                  if (!picked) return;
                  setHour(picked.getHours());
                  setMin(picked.getMinutes());
                }}
                style={{ width: 220 }}
              />
            </View>
          </View>

          <View style={{
            flexDirection: "row", gap: 10,
            paddingHorizontal: 18, paddingTop: 4,
          }}>
            <TouchableOpacity
              onPress={() => isRange && active === "end" ? setActive("start") : props.onClose()}
              activeOpacity={0.7}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 14,
                backgroundColor: "#f1f3f4",
                alignItems: "center",
              }}
            >
              <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>
                {isRange && active === "end" ? "Back" : "Cancel"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={isRange && active === "start" ? handleNext : handleSave}
              activeOpacity={props.saving ? 1 : 0.85}
              disabled={props.saving}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 14,
                backgroundColor: props.saving ? "#bfdbfe" : "#1a73e8",
                alignItems: "center",
              }}
            >
              {props.saving ? <ActivityIndicator color="#ffffff" /> : (
                <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                  {isRange && active === "start" ? "Next" : "Save"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
