import React from "react";
import { View, ActivityIndicator } from "react-native";
import { Tabs } from "expo-router";
import { Home, CalendarDays, Map as MapIcon, Wrench, Clock } from "lucide-react-native";
import { usePermissions } from "@/lib/usePermissions";

/**
 * Role-aware tab bar.
 *
 *   admin       Home · Calendar · Map · Maintenance · Timesheet
 *   dispatcher  Home · Calendar · Map
 *   maintenance Maintenance · Calendar · Timesheet
 *
 * Two gates, deliberately different in kind:
 *
 *   • Maintenance for a DISPATCHER is hidden app-side only — the
 *     capability stays granted, so Bruno and Jorge keep the Equipment →
 *     Maintenance tab on web. There is no `maintenance.access` check
 *     here for that reason; revoking the capability is the heavier
 *     move and belongs in the Role Permissions matrix, not in a tab
 *     layout. If a dispatcher ever needs the tab on the phone, flip
 *     SHOW_MAINTENANCE_TAB below rather than touching permissions.
 *
 *   • Home and Map for a MAINTENANCE user are hidden because the role
 *     genuinely lacks what they show (Home is load search + the trucks
 *     map; Map is live Motive positions). Those follow the capability.
 *
 * A hidden tab is `href: null` — the route stays registered so a deep
 * link or a stale navigation state resolves instead of throwing, it
 * just has no button. Screen ORDER is declaration order, so the tab a
 * role should land on is declared first for that role.
 *
 * Rendering is held until usePermissions resolves. Painting the wrong
 * tab set and then correcting it would remount every screen, and for
 * the maintenance role the pre-resolution state is the permissive one
 * (see the comment in lib/usePermissions.ts) — a flash of Home and Map
 * is exactly the flash we don't want.
 */

/** Dispatchers don't get the Maintenance tab in the phone app. Their
 *  web access is untouched. Flip to true to give it back. */
const SHOW_MAINTENANCE_TAB_FOR_DISPATCHER = false;

const SCREEN_OPTIONS = {
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
    fontFamily:    "PlusJakartaSans_700Bold",
    fontSize:      11,
    letterSpacing: 0.2,
  },
} as const;

export default function TabsLayout() {
  const { role, can, isLoading } = usePermissions();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#ffffff" }}>
        <ActivityIndicator color="#1a73e8" />
      </View>
    );
  }

  const isMaintenanceRole = role === "maintenance";

  const showHome = !isMaintenanceRole;
  const showMap  = !isMaintenanceRole;
  const showMaintenance =
    can("maintenance.access") &&
    (role !== "dispatcher" || SHOW_MAINTENANCE_TAB_FOR_DISPATCHER);
  // Anyone who can punch a clock gets the tab. Dispatchers don't have
  // timesheet.self, so Bruno and Jorge never see it; admins do, both to
  // review everyone's hours and because an admin who works the shop
  // should be able to clock in like anyone else.
  const showTimesheet = can("timesheet.self");

  const homeTab = (
    <Tabs.Screen
      key="index"
      name="index"
      options={{
        title: "Home",
        href: showHome ? undefined : null,
        tabBarIcon: ({ color, focused }) => (
          <Home size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
        ),
      }}
    />
  );

  const calendarTab = (
    <Tabs.Screen
      key="calendar"
      name="calendar"
      options={{
        title: "Calendar",
        tabBarIcon: ({ color, focused }) => (
          <CalendarDays size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
        ),
      }}
    />
  );

  const mapTab = (
    <Tabs.Screen
      key="map"
      name="map"
      options={{
        title: "Map",
        href: showMap ? undefined : null,
        tabBarIcon: ({ color, focused }) => (
          <MapIcon size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
        ),
      }}
    />
  );

  const maintenanceTab = (
    <Tabs.Screen
      key="maintenance"
      name="maintenance"
      options={{
        title: "Maintenance",
        href: showMaintenance ? undefined : null,
        tabBarIcon: ({ color, focused }) => (
          <Wrench size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
        ),
      }}
    />
  );

  const timesheetTab = (
    <Tabs.Screen
      key="timesheet"
      name="timesheet"
      options={{
        title: "Timesheet",
        href: showTimesheet ? undefined : null,
        tabBarIcon: ({ color, focused }) => (
          <Clock size={22} color={color} strokeWidth={focused ? 2.4 : 2} />
        ),
      }}
    />
  );

  // Maintenance lands on its own tab; everyone else lands on Home.
  const tabs = isMaintenanceRole
    ? [maintenanceTab, calendarTab, timesheetTab, homeTab, mapTab]
    : [homeTab, calendarTab, mapTab, maintenanceTab, timesheetTab];

  return <Tabs screenOptions={SCREEN_OPTIONS}>{tabs}</Tabs>;
}
