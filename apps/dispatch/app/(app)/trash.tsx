import React from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useOrganization } from "@clerk/clerk-expo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2, RotateCcw, Truck, User, Building2, Hash, Clock } from "lucide-react-native";
import { fetchDeletedLoads, restoreLoad, fetchCustomers, displayBrokerName, type DeletedLoadRow } from "@/lib/api";
import { txt } from "@/lib/font";

function fmtDate(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const ms = Date.now() - t;
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "1 week ago";
  return `${weeks} weeks ago`;
}

export default function TrashScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { organization } = useOrganization();
  const orgId = organization?.id;

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", orgId],
    queryFn:  () => fetchCustomers(orgId!),
    enabled:  !!orgId,
    staleTime: 60_000,
  });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["deleted-loads", orgId],
    queryFn:  () => fetchDeletedLoads(orgId!),
    enabled:  !!orgId,
  });

  const { mutate: doRestore, isPending: restoring } = useMutation({
    mutationFn: (id: string) => restoreLoad(id, orgId!),
    onSuccess: (_d, id) => {
      queryClient.invalidateQueries({ queryKey: ["deleted-loads", orgId] });
      queryClient.invalidateQueries({ queryKey: ["loads", orgId] });
      // Drop any stale ["load", id] cache that may hold a null from the prior
      // soft-delete refetch, so the next screen starts fresh.
      queryClient.removeQueries({ queryKey: ["load", id] });
      router.push({ pathname: "/load/[id]", params: { id } });
    },
    onError: (err) => Alert.alert("Couldn't restore", err instanceof Error ? err.message : "Unknown error"),
  });

  return (
    <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      <View style={{ backgroundColor: "#1a73e8", paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}>
            <ArrowLeft size={18} color="#ffffff" strokeWidth={2.2} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={[txt(800), { fontSize: 16, color: "#ffffff" }]}>Recently Deleted</Text>
            <Text style={[txt(600), { fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 1 }]}>
              Loads removed in the last 30 days
            </Text>
          </View>
        </View>
      </View>

      {isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color="#1a73e8" />
        </View>
      ) : rows.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 30 }}>
          <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: "#f1f3f4", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
            <Trash2 size={22} color="#9aa0a6" strokeWidth={2.2} />
          </View>
          <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>Trash is empty</Text>
          <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
            Loads you delete will appear here for 30 days before being purged.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {rows.map((r) => (
            <View key={r.id} style={{
              backgroundColor: "#ffffff", borderRadius: 14,
              borderWidth: 1, borderColor: "#e8eaed",
              padding: 14, marginBottom: 10,
            }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <Text style={[txt(800), { fontSize: 11, color: "#b91c1c", letterSpacing: 0.4 }]}>
                  DELETED {fmtRelative(r.deletedAt).toUpperCase()}
                </Text>
              </View>
              <Text style={[txt(800), { fontSize: 15, color: "#202124" }]} numberOfLines={2}>
                {r.title}
              </Text>

              <View style={{ marginTop: 8, gap: 4 }}>
                {r.loadNum ? (
                  <RowLine Icon={Hash} text={`Load #${r.loadNum}`} />
                ) : null}
                {r.broker ? (
                  <RowLine Icon={Building2} text={displayBrokerName(r.broker, customers)} />
                ) : null}
                {r.assetName ? (
                  <RowLine Icon={Truck} text={r.assetName} />
                ) : null}
                {r.driverName ? (
                  <RowLine Icon={User} text={r.driverName} />
                ) : null}
                <RowLine Icon={Clock} text={`${fmtDate(r.start)} → ${fmtDate(r.end)}`} />
              </View>

              <TouchableOpacity
                onPress={() => doRestore(r.id)}
                activeOpacity={0.7}
                disabled={restoring}
                style={{
                  marginTop: 12, paddingVertical: 11, borderRadius: 12,
                  backgroundColor: "#e8f0fe",
                  borderWidth: 1, borderColor: "#bfdbfe",
                  flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
                  opacity: restoring ? 0.5 : 1,
                }}
              >
                <RotateCcw size={13} color="#1a73e8" strokeWidth={2.4} />
                <Text style={[txt(800), { fontSize: 12, color: "#1a73e8", letterSpacing: 0.3 }]}>
                  Restore
                </Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function RowLine({ Icon, text }: { Icon: typeof Trash2; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon size={11} color="#5f6368" strokeWidth={2.2} />
      <Text style={[txt(600), { fontSize: 12, color: "#5f6368" }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}
