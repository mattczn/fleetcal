/**
 * Thin pill that appears when the device drops off the network. Stays
 * visible until connectivity resumes. Sits above all screens via the
 * root layout, just under the status bar.
 */
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";
import { WifiOff } from "lucide-react-native";
import { txt } from "@/lib/font";

export default function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sub = NetInfo.addEventListener(state => {
      setOnline(state.isConnected !== false);
    });
    return () => sub();
  }, []);

  if (online) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: insets.top + 4,
        left: 12, right: 12,
        zIndex: 1000,
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
        paddingVertical: 6, paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: "rgba(180, 83, 9, 0.95)",
      }}
    >
      <WifiOff size={12} color="#fff" strokeWidth={2.4} />
      <Text style={[txt(700), { fontSize: 11, color: "#fff", letterSpacing: 0.3 }]}>
        Offline · showing cached loads
      </Text>
    </View>
  );
}
