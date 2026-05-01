import React from "react";
import { Modal, View, Text, TouchableOpacity, Pressable } from "react-native";
import { Calendar, type DateData } from "react-native-calendars";
import { X } from "lucide-react-native";
import { txt } from "@/lib/font";

interface Props {
  visible:    boolean;
  selected:   string;        // YYYY-MM-DD
  onClose:    () => void;
  onSelect:   (dateKey: string) => void;
}

export function DatePickerModal({ visible, selected, onClose, onSelect }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", paddingHorizontal: 16 }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderRadius: 18,
            overflow: "hidden",
          }}
        >
          <View style={{
            flexDirection: "row", alignItems: "center",
            paddingHorizontal: 18, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
          }}>
            <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
              Pick a date
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <Calendar
            current={selected}
            markedDates={{ [selected]: { selected: true, selectedColor: "#1a73e8" } }}
            onDayPress={(d: DateData) => { onSelect(d.dateString); onClose(); }}
            theme={{
              todayTextColor:    "#1a73e8",
              arrowColor:        "#1a73e8",
              selectedDayBackgroundColor: "#1a73e8",
              selectedDayTextColor: "#ffffff",
              textDayFontFamily:        "PlusJakartaSans_600SemiBold",
              textDayHeaderFontFamily:  "PlusJakartaSans_700Bold",
              textMonthFontFamily:      "PlusJakartaSans_800ExtraBold",
              textMonthFontSize: 16,
              textDayFontSize:   14,
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
