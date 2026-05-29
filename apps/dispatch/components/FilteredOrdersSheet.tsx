/**
 * Filtered work-order list sheet.
 *
 * Three quick-link buttons on the maintenance tab funnel into here:
 *
 *   1. View Backlog     → no asset/trailer filter, status defaults to open
 *   2. Filter           → same shell, user touches the filter chips
 *   3. By Asset         → asset picker pre-runs; sheet opens with assetId set
 *
 * The chips at the top stay live — brother can change status / priority /
 * equipment without closing the sheet, and the list reflows immediately.
 * Items the screen has already fetched are passed in as a prop so we
 * don't re-query.
 */
import React, { useMemo, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ScrollView, FlatList,
} from "react-native";
import { X, Truck, Container, Filter as FilterIcon } from "lucide-react-native";
import type {
  MaintenanceActionItem, MaintenanceActionStatus, MaintenancePriority,
  Asset, Trailer,
} from "@fleetcal/types";
import { txt } from "@/lib/font";
import {
  StatusPill, PRIORITY_COLORS, fmtCost, fmtScheduledDate,
} from "@/lib/maintenanceUI";
import { AssetPickerSheet } from "./AssetPickerSheet";
import { TrailerPickerSheet } from "./TrailerPickerSheet";

// All three filters default to "show me the brother-actionable stuff":
// Open work orders, any priority, any equipment. Each is independently
// overridable by tapping its chip.
export interface OrdersFilter {
  status?:    MaintenanceActionStatus | null; // null = "All"
  priority?:  MaintenancePriority    | null;
  assetId?:   number | null;
  trailerId?: number | null;
}

interface Props {
  visible:   boolean;
  title:     string;
  /** Initial filter — caller picks the entry point ("Backlog" → status:open,
   *  "By Asset" → status:open, assetId:X). User can then loosen filters
   *  inside the sheet. */
  initialFilter: OrdersFilter;
  items:    MaintenanceActionItem[];
  assets:   Asset[];
  trailers: Trailer[];
  orgId:    string;
  onClose:  () => void;
  onOpenItem: (item: MaintenanceActionItem) => void;
}

const STATUS_OPTIONS: (MaintenanceActionStatus | null)[] = [null, "open", "in_progress", "done"];
const PRIORITY_OPTIONS: (MaintenancePriority | null)[] = [null, "urgent", "high", "normal", "low"];

function nextOf<T>(opts: T[], current: T): T {
  const i = opts.findIndex((o) => o === current);
  return opts[(i + 1) % opts.length];
}

export function FilteredOrdersSheet({
  visible, title, initialFilter, items, assets, trailers, orgId, onClose, onOpenItem,
}: Props) {
  const [filter, setFilter] = useState<OrdersFilter>(initialFilter);
  const [truckPickerOpen,   setTruckPickerOpen]   = useState(false);
  const [trailerPickerOpen, setTrailerPickerOpen] = useState(false);

  // Reset filter every time the sheet is reopened so the entry point's
  // intent ("Backlog" vs "By Asset") survives a close+reopen.
  React.useEffect(() => {
    if (visible) setFilter(initialFilter);
  }, [visible, initialFilter]);

  // Filtered + sorted list
  const filtered = useMemo(() => {
    const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    const passes = (it: MaintenanceActionItem) => {
      if (filter.status   != null && it.status    !== filter.status)   return false;
      if (filter.priority != null && it.priority  !== filter.priority) return false;
      if (filter.assetId   != null && it.assetId   !== filter.assetId)   return false;
      if (filter.trailerId != null && it.trailerId !== filter.trailerId) return false;
      return true;
    };
    return items
      .filter(passes)
      .sort((a, b) => {
        const p = priorityRank[a.priority] - priorityRank[b.priority];
        if (p !== 0) return p;
        return (a.scheduledDate ?? "zzzz").localeCompare(b.scheduledDate ?? "zzzz");
      });
  }, [items, filter]);

  const selectedAsset   = filter.assetId   ? assets.find((a) => a.id === filter.assetId)     : null;
  const selectedTrailer = filter.trailerId ? trailers.find((t) => t.id === filter.trailerId) : null;

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
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            height: "92%",
            paddingTop: 8,
          }}
        >
          {/* Header */}
          <View style={{
            flexDirection: "row", alignItems: "center",
            paddingHorizontal: 18, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
          }}>
            <FilterIcon size={16} color="#1a73e8" strokeWidth={2.4} />
            <Text style={[txt(800), { fontSize: 17, color: "#202124", flex: 1, marginLeft: 8 }]} numberOfLines={1}>
              {title}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          {/* Filter chips — horizontal scroll */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}
            style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: "#f1f3f4" }}
          >
            <Chip
              label={`Status: ${labelStatus(filter.status)}`}
              active={filter.status != null}
              onPress={() => setFilter((f) => ({ ...f, status: nextOf(STATUS_OPTIONS, f.status ?? null) }))}
            />
            <Chip
              label={`Priority: ${labelPriority(filter.priority)}`}
              active={filter.priority != null}
              onPress={() => setFilter((f) => ({ ...f, priority: nextOf(PRIORITY_OPTIONS, f.priority ?? null) }))}
            />
            <Chip
              label={selectedAsset ? selectedAsset.name : "Truck: Any"}
              active={!!selectedAsset}
              onPress={() => setTruckPickerOpen(true)}
              onClear={selectedAsset ? () => setFilter((f) => ({ ...f, assetId: null })) : undefined}
              icon={<Truck size={12} color={selectedAsset ? "#1967d2" : "#5f6368"} strokeWidth={2.2} />}
            />
            <Chip
              label={selectedTrailer
                ? (selectedTrailer.trailerNumber ? `Trailer ${selectedTrailer.trailerNumber}` : selectedTrailer.name)
                : "Trailer: Any"}
              active={!!selectedTrailer}
              onPress={() => setTrailerPickerOpen(true)}
              onClear={selectedTrailer ? () => setFilter((f) => ({ ...f, trailerId: null })) : undefined}
              icon={<Container size={12} color={selectedTrailer ? "#1967d2" : "#5f6368"} strokeWidth={2.2} />}
            />
          </ScrollView>

          {/* Count */}
          <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 6 }}>
            <Text style={[txt(700), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4 }]}>
              {filtered.length} {filtered.length === 1 ? "WORK ORDER" : "WORK ORDERS"}
            </Text>
          </View>

          {/* List */}
          <FlatList
            data={filtered}
            keyExtractor={(it) => it.id}
            contentContainerStyle={{ paddingBottom: 32 }}
            ListEmptyComponent={
              <View style={{ paddingVertical: 50, alignItems: "center", paddingHorizontal: 32 }}>
                <Text style={[txt(700), { fontSize: 14, color: "#5f6368", textAlign: "center" }]}>
                  No work orders match.
                </Text>
                <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
                  Try clearing a filter chip above.
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <CompactRow
                item={item}
                assets={assets}
                trailers={trailers}
                onPress={() => onOpenItem(item)}
              />
            )}
          />
        </Pressable>
      </Pressable>

      <AssetPickerSheet
        visible={truckPickerOpen}
        title="Filter by truck"
        assets={assets}
        onClose={() => setTruckPickerOpen(false)}
        onSelect={(a) => { setFilter((f) => ({ ...f, assetId: a.id })); setTruckPickerOpen(false); }}
      />
      <TrailerPickerSheet
        visible={trailerPickerOpen}
        orgId={orgId}
        currentId={filter.trailerId ?? undefined}
        onClose={() => setTrailerPickerOpen(false)}
        onSelect={(id) => { setFilter((f) => ({ ...f, trailerId: id ?? null })); setTrailerPickerOpen(false); }}
      />
    </Modal>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function labelStatus(s: MaintenanceActionStatus | null | undefined): string {
  if (!s) return "All";
  if (s === "in_progress") return "In progress";
  return s[0].toUpperCase() + s.slice(1);
}

function labelPriority(p: MaintenancePriority | null | undefined): string {
  if (!p) return "All";
  return p[0].toUpperCase() + p.slice(1);
}

function Chip({
  label, active, onPress, onClear, icon,
}: {
  label:    string;
  active:   boolean;
  onPress:  () => void;
  onClear?: () => void;
  icon?:    React.ReactNode;
}) {
  // Min-height + bigger vertical padding so the chip can absorb a bumped
  // system text scale without clipping. Cap text scale to 1.2× too —
  // these are filter controls, not body content, so extreme scaling
  // would blow up the layout anyway.
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 6,
      paddingLeft: icon ? 10 : 14, paddingRight: onClear ? 6 : 14, paddingVertical: 10,
      minHeight: 38,
      borderRadius: 999,
      backgroundColor: active ? "#e8f0fe" : "#f1f3f4",
      borderWidth: 1, borderColor: active ? "#a5c2f4" : "transparent",
    }}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        {icon}
        <Text
          allowFontScaling
          maxFontSizeMultiplier={1.2}
          numberOfLines={1}
          style={[txt(700), {
            fontSize: 13, lineHeight: 16,
            color: active ? "#1967d2" : "#3c4043",
          }]}
        >
          {label}
        </Text>
      </TouchableOpacity>
      {onClear ? (
        <TouchableOpacity onPress={onClear} hitSlop={6} style={{ paddingHorizontal: 2 }}>
          <X size={12} color={active ? "#1967d2" : "#5f6368"} strokeWidth={2.4} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function CompactRow({
  item, assets, trailers, onPress,
}: {
  item: MaintenanceActionItem;
  assets: Asset[]; trailers: Trailer[];
  onPress: () => void;
}) {
  const priority = PRIORITY_COLORS[item.priority];
  const asset    = item.assetId   ? assets.find((a) => a.id === item.assetId)     : null;
  const trailer  = item.trailerId ? trailers.find((t) => t.id === item.trailerId) : null;
  const equipmentLabel = asset
    ? asset.name
    : trailer
      ? (trailer.trailerNumber ? `Trailer ${trailer.trailerNumber}` : trailer.name)
      : "—";
  const Icon = trailer ? Container : Truck;
  const cost = fmtCost(item.actualCost);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        flexDirection: "row",
        backgroundColor: "#ffffff",
        marginHorizontal: 14, marginBottom: 8,
        borderRadius: 10,
        borderWidth: 1, borderColor: "#eef0f2",
        overflow: "hidden",
      }}
    >
      <View style={{ width: 4, backgroundColor: priority.stripe }} />
      <View style={{ flex: 1, padding: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[txt(800), { fontSize: 14, color: "#202124", flex: 1 }]} numberOfLines={1}>
            {item.title}
          </Text>
          <StatusPill status={item.status} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
          <Icon size={12} color="#5f6368" strokeWidth={2.2} />
          <Text style={[txt(600), { fontSize: 12, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
            {equipmentLabel}
          </Text>
          {item.scheduledDate ? (
            <Text style={[txt(700), { fontSize: 11, color: "#5f6368" }]}>
              {fmtScheduledDate(item.scheduledDate)}
            </Text>
          ) : null}
        </View>
        {(item.vendor || cost) ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 3 }}>
            {item.vendor ? (
              <Text style={[txt(600), { fontSize: 11, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
                {item.vendor}
              </Text>
            ) : <View style={{ flex: 1 }} />}
            {cost ? (
              <Text style={[txt(800), { fontSize: 11, color: "#15803d" }]}>
                {cost}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}
