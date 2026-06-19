import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Truck, User, Calendar, ClipboardCheck, type LucideIcon } from "lucide-react-native";
import { useNotificationDeepLink } from "@/lib/useNotificationDeepLink";
import { Glass } from "@/components/Glass";
import { f } from "@/lib/theme";
import { useTheme } from "@/lib/ThemeProvider";

const TAB_META: Record<string, { label: string; Icon: LucideIcon; big?: boolean }> = {
  index:    { label: "Loads",    Icon: Truck, big: true },
  schedule: { label: "Schedule", Icon: Calendar },
  report:   { label: "Report",   Icon: ClipboardCheck },
  profile:  { label: "Profile",  Icon: User },
};

/**
 * Floating glass tab bar (design: a frosted pill inset from the screen
 * edges). It reserves its own footprint via the outer tray so the three
 * non-redesigned tabs never get their bottom content clipped — the tray
 * matches the app background so it reads as a seamless dock under Loads.
 */
function FloatingTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { C, ACCENT } = useTheme();
  return (
    <View style={{ backgroundColor: C.bg, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 10), paddingHorizontal: 14 }}>
      <Glass
        deep
        radii={{ borderRadius: 24 }}
        style={{ height: 62, flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingHorizontal: 8 }}
      >
        {state.routes.map((route, i) => {
          const meta = TAB_META[route.name];
          if (!meta) return null;
          const focused = state.index === i;
          const color = focused ? ACCENT : C.t3;
          const { Icon } = meta;
          const onPress = () => {
            const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };
          return (
            <TouchableOpacity
              key={route.key}
              accessibilityRole="button"
              accessibilityState={focused ? { selected: true } : {}}
              onPress={onPress}
              activeOpacity={0.8}
              style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 3, paddingVertical: 6 }}
            >
              <Icon size={meta.big ? 24 : 22} color={color} strokeWidth={focused ? 2.7 : 2.1} />
              <Text style={[f(700), { fontSize: 10, color, letterSpacing: 0.1 }]}>{meta.label}</Text>
            </TouchableOpacity>
          );
        })}
      </Glass>
    </View>
  );
}

export default function TabsLayout() {
  useNotificationDeepLink();
  return (
    <Tabs
      // Loads is the driver's primary workspace — default tab on cold open.
      initialRouteName="index"
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      {/* Order = bar order: Loads first (design), then Schedule / Report / Profile. */}
      <Tabs.Screen name="index" options={{ title: "Loads" }} />
      <Tabs.Screen name="schedule" options={{ title: "Schedule" }} />
      <Tabs.Screen name="report" options={{ title: "Report" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}
