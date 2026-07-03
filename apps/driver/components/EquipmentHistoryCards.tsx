/**
 * EquipmentHistoryCards — the reusable body of the Truck History surface.
 *
 * Renders the four history sections for one piece of equipment plus the
 * fullscreen swipeable photo viewer:
 *   (a) Known damage          — knownDamage cards w/ OOS/priority pill,
 *                               "from inspection" tag, swipeable photos
 *   (b) Recent inspection defects — last 30 days, pre/post badge, failed
 *                               item labels + photos
 *   (c) Recent drivers        — recentEvents (who had it, when, load #)
 *   (d) Last cleanliness photo — "how the last driver left it" reference
 *
 * Extracted so BOTH the load-detail Truck History screen and the new
 * inspection Step 1 (select asset + review history) render one identical
 * implementation. The photo viewer is owned here — the section cards call
 * an internal opener, so callers just drop <EquipmentHistoryCards data />.
 *
 * `order` lets Step 1 lead with cleanliness + known damage (what the
 * driver needs before starting), while the load-detail screen keeps its
 * original recent-drivers-first ordering.
 */
import React, { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Image, Modal, FlatList, Dimensions,
} from "react-native";
import { User, Wrench, ClipboardCheck, Sparkles, X } from "lucide-react-native";
import { type EquipmentHistory, type EquipmentPhoto } from "@/lib/railway";
import { useTheme } from "@/lib/ThemeProvider";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium" :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold" :
                     "PlusJakartaSans_800ExtraBold",
});

const { width: SCREEN_W } = Dimensions.get("window");

type SectionKey = "drivers" | "damage" | "defects" | "cleanliness";

interface Props {
  data: EquipmentHistory;
  /** Section render order. Defaults to the load-detail ordering
   *  (drivers → damage → defects → cleanliness). Step 1 leads with the
   *  cleanliness reference + known damage. */
  order?: SectionKey[];
}

const DEFAULT_ORDER: SectionKey[] = ["drivers", "damage", "defects", "cleanliness"];

export default function EquipmentHistoryCards({ data, order = DEFAULT_ORDER }: Props) {
  // Fullscreen photo viewer — holds the array + starting index to swipe.
  const [viewer, setViewer] = useState<{ photos: EquipmentPhoto[]; index: number } | null>(null);
  const open = (photos: EquipmentPhoto[], index: number) => setViewer({ photos, index });

  return (
    <>
      {order.map((key) => {
        switch (key) {
          case "drivers":     return <RecentDriversSection key={key} data={data} />;
          case "damage":      return <KnownDamageSection key={key} data={data} onOpenPhotos={open} />;
          case "defects":     return <DefectsSection key={key} data={data} onOpenPhotos={open} />;
          case "cleanliness": return <CleanlinessSection key={key} data={data} onOpenPhotos={open} />;
          default:            return null;
        }
      })}

      <PhotoViewer viewer={viewer} onClose={() => setViewer(null)} />
    </>
  );
}

// ─── Fullscreen swipeable photo viewer ────────────────────────────────

function PhotoViewer({ viewer, onClose }: { viewer: { photos: EquipmentPhoto[]; index: number } | null; onClose: () => void }) {
  return (
    <Modal visible={viewer !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.94)" }}>
        <TouchableOpacity onPress={onClose} style={{ position: "absolute", top: 50, right: 20, zIndex: 10, width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" }}>
          <X size={22} color="#fff" />
        </TouchableOpacity>
        {viewer && (
          <FlatList
            data={viewer.photos}
            keyExtractor={(p) => p.id}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={viewer.index}
            getItemLayout={(_, i) => ({ length: SCREEN_W, offset: SCREEN_W * i, index: i })}
            renderItem={({ item }) => (
              <View style={{ width: SCREEN_W, height: "100%", alignItems: "center", justifyContent: "center" }}>
                {item.signedUrl ? (
                  <Image source={{ uri: item.signedUrl }} style={{ width: SCREEN_W, height: "80%" }} resizeMode="contain" />
                ) : (
                  <Text style={[txt(500), { color: "#fff" }]}>Photo unavailable</Text>
                )}
              </View>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────

function RecentDriversSection({ data }: { data: EquipmentHistory }) {
  const { C } = useTheme();
  return (
    <SectionCard icon={<User size={16} color={C.t2} />} title="Recent drivers">
      {data.recentEvents.length === 0 ? (
        <EmptyLine text="No recent driver activity." />
      ) : (
        data.recentEvents.map((e) => (
          <View key={e.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}>
            <View style={{ flex: 1 }}>
              <Text style={[txt(700), { fontSize: 14, color: C.t1 }]}>{e.driverName ?? "Unassigned"}</Text>
              <Text style={[txt(500), { fontSize: 12, color: C.t3, marginTop: 2 }]}>
                {fmtDate(e.start)}{e.end && e.end !== e.start ? ` – ${fmtDate(e.end)}` : ""}
                {e.loadNum ? ` · Load ${e.loadNum}` : ""}
              </Text>
            </View>
            <StatusPill label={e.status} />
          </View>
        ))
      )}
    </SectionCard>
  );
}

function KnownDamageSection({ data, onOpenPhotos }: { data: EquipmentHistory; onOpenPhotos: (p: EquipmentPhoto[], i: number) => void }) {
  const { C } = useTheme();
  return (
    <SectionCard icon={<Wrench size={16} color={C.t2} />} title="Known damage">
      {data.knownDamage.length === 0 ? (
        <EmptyLine text="No open damage on record." />
      ) : (
        data.knownDamage.map((d) => (
          <View key={`${d.source}-${d.id}`} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
              <Text style={[txt(700), { fontSize: 14, color: C.t1, flex: 1, minWidth: 120 }]}>
                {d.title ?? "Damage"}
              </Text>
              {d.outOfService && <Pill label="Out of service" tone="red" />}
              {d.priority && <Pill label={d.priority} tone="amber" />}
              {d.fromInspection && <Pill label="From inspection" tone="blue" />}
            </View>
            {d.description && (
              <Text style={[txt(500), { fontSize: 13, color: C.t2, lineHeight: 18 }]}>{d.description}</Text>
            )}
            <Text style={[txt(500), { fontSize: 11, color: C.t4, marginTop: 4 }]}>{fmtDate(d.reportedAt)}</Text>
            <PhotoStrip photos={d.photos} onOpenPhotos={onOpenPhotos} />
          </View>
        ))
      )}
    </SectionCard>
  );
}

function DefectsSection({ data, onOpenPhotos }: { data: EquipmentHistory; onOpenPhotos: (p: EquipmentPhoto[], i: number) => void }) {
  const { C } = useTheme();
  return (
    <SectionCard icon={<ClipboardCheck size={16} color={C.t2} />} title="Recent inspection defects" subtitle="Last 30 days">
      {data.recentInspectionDefects.length === 0 ? (
        <EmptyLine text="No defects reported in the last 30 days." />
      ) : (
        data.recentInspectionDefects.map((d) => (
          <View key={d.id} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <Pill label={d.kind === "post_trip" ? "Post-trip" : "Pre-trip"} tone={d.kind === "post_trip" ? "purple" : "blue"} />
              <Text style={[txt(500), { fontSize: 12, color: C.t3, flex: 1 }]}>{fmtDate(d.date)}</Text>
              <Text style={[txt(500), { fontSize: 12, color: C.t4 }]}>{d.signedBy}</Text>
            </View>
            {d.failedItems.map((it) => (
              <Text key={it.id} style={[txt(600), { fontSize: 13, color: C.redInk, marginTop: 2 }]}>
                • {it.label}{it.notes ? ` — ${it.notes}` : ""}
              </Text>
            ))}
            <PhotoStrip photos={d.photos} onOpenPhotos={onOpenPhotos} />
          </View>
        ))
      )}
    </SectionCard>
  );
}

function CleanlinessSection({ data, onOpenPhotos }: { data: EquipmentHistory; onOpenPhotos: (p: EquipmentPhoto[], i: number) => void }) {
  const { C } = useTheme();
  const c = data.lastCleanlinessPhoto;
  return (
    <SectionCard
      icon={<Sparkles size={16} color={C.t2} />}
      title="Last cleanliness photo"
      subtitle="How it was left"
    >
      {!c ? (
        <EmptyLine text="No cleanliness photo on record." />
      ) : (
        <View>
          {c.signedUrl ? (
            <TouchableOpacity
              onPress={() => onOpenPhotos([{ id: "cleanliness", uploadedAt: c.uploadedAt, signedUrl: c.signedUrl }], 0)}
              activeOpacity={0.9}
            >
              <Image source={{ uri: c.signedUrl }} style={{ width: "100%", height: 200, borderRadius: 10 }} resizeMode="cover" />
            </TouchableOpacity>
          ) : (
            <EmptyLine text="Photo unavailable." />
          )}
          <Text style={[txt(500), { fontSize: 12, color: C.t3, marginTop: 6 }]}>
            {fmtDate(c.date)} · {c.signedBy}
          </Text>
        </View>
      )}
    </SectionCard>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────

function SectionCard({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode }) {
  const { C } = useTheme();
  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: C.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
        {icon}
        <Text style={[txt(700), { fontSize: 15, color: C.t1, flex: 1 }]}>{title}</Text>
        {subtitle && <Text style={[txt(500), { fontSize: 11, color: C.t4 }]}>{subtitle}</Text>}
      </View>
      {children}
    </View>
  );
}

function PhotoStrip({ photos, onOpenPhotos }: { photos: EquipmentPhoto[]; onOpenPhotos: (p: EquipmentPhoto[], i: number) => void }) {
  const withUrls = photos.filter((p) => p.signedUrl);
  if (withUrls.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }} contentContainerStyle={{ gap: 8 }}>
      {withUrls.map((p, i) => (
        <TouchableOpacity key={p.id} onPress={() => onOpenPhotos(withUrls, i)} activeOpacity={0.85}>
          <Image source={{ uri: p.signedUrl }} style={{ width: 84, height: 84, borderRadius: 8 }} resizeMode="cover" />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function Pill({ label, tone }: { label: string; tone: "red" | "amber" | "blue" | "purple" | "green" }) {
  const { C } = useTheme();
  const map = {
    red:    { bg: C.redBg,    fg: C.redInk },
    amber:  { bg: C.amberBg,  fg: C.amberInk },
    blue:   { bg: C.blueBg,   fg: C.blueInk },
    purple: { bg: C.purpleBg, fg: C.purpleInk },
    green:  { bg: C.greenBg,  fg: C.greenInk },
  }[tone];
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: map.bg }}>
      <Text style={[txt(700), { fontSize: 10, color: map.fg, textTransform: "capitalize", letterSpacing: 0.3 }]}>{label}</Text>
    </View>
  );
}

function StatusPill({ label }: { label: string }) {
  const { C } = useTheme();
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: C.surface2 }}>
      <Text style={[txt(700), { fontSize: 10, color: C.t3, textTransform: "capitalize" }]}>{label.replace(/_/g, " ")}</Text>
    </View>
  );
}

function EmptyLine({ text }: { text: string }) {
  const { C } = useTheme();
  return <Text style={[txt(500), { fontSize: 13, color: C.t4 }]}>{text}</Text>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
