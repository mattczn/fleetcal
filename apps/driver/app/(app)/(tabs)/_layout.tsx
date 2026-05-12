import React from "react";
import { Tabs } from "expo-router";
import { Truck, User, Calendar, Fuel, Wrench } from "lucide-react-native";
import { useNotificationDeepLink } from "@/lib/useNotificationDeepLink";

export default function TabsLayout() {
  useNotificationDeepLink();
  return (
    <Tabs
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
          tabBarIcon: ({ color, focused }) => (
            <Truck size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
          ),
        }}
      />
      <Tabs.Screen
        name="fuel"
        options={{
          title: "Fuel",
          tabBarIcon: ({ color, focused }) => (
            <Fuel size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
          ),
        }}
      />
      <Tabs.Screen
        name="maintenance"
        options={{
          title: "Maintenance",
          tabBarIcon: ({ color, focused }) => (
            <Wrench size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
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
