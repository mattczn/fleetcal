import React from "react";
import { Tabs } from "expo-router";
import { Truck, User, Calendar, ClipboardCheck } from "lucide-react-native";
import { useNotificationDeepLink } from "@/lib/useNotificationDeepLink";

export default function TabsLayout() {
  useNotificationDeepLink();
  return (
    <Tabs
      // Loads is the driver's primary workspace — make it the default
      // tab on cold open.
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#ffffff",
          borderTopColor:  "#e8eaed",
          height:          82,
          paddingTop:      8,
        },
        tabBarActiveTintColor:   "#1a73e8",
        tabBarInactiveTintColor: "#9aa0a6",
        tabBarLabelStyle: {
          fontFamily: "PlusJakartaSans_700Bold",
          fontSize:   11,
          letterSpacing: 0.2,
        },
      }}
    >
      <Tabs.Screen
        name="schedule"
        options={{
          title: "Schedule",
          tabBarIcon: ({ color, focused }) => (
            <Calendar size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: "Loads",
          // Loads is the primary tab — slightly heavier icon so it
          // visually anchors the bar.
          tabBarIcon: ({ color, focused }) => (
            <Truck size={26} color={color} strokeWidth={focused ? 2.8 : 2.4} />
          ),
          tabBarLabelStyle: {
            fontFamily: "PlusJakartaSans_800ExtraBold",
            fontSize:   11.5,
            letterSpacing: 0.2,
          },
        }}
      />
      <Tabs.Screen
        name="report"
        options={{
          title: "Report",
          tabBarIcon: ({ color, focused }) => (
            <ClipboardCheck size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, focused }) => (
            <User size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
          ),
        }}
      />
    </Tabs>
  );
}
