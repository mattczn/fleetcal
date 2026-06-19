import React from "react";
import { View, Text } from "react-native";
import { Inbox, type LucideIcon } from "lucide-react-native";
import { useTheme } from "@/lib/ThemeProvider";

type Props = {
  title:     string;
  subtitle?: string;
  Icon?:     LucideIcon;
};

export function EmptyState({ title, subtitle, Icon = Inbox }: Props) {
  const { C, SHADOW, ACCENT } = useTheme();
  return (
    <View className="flex-1 items-center justify-center py-16 px-8">
      <View
        style={{
          width:           72,
          height:          72,
          borderRadius:    36,
          backgroundColor: C.blueBg,
          alignItems:      "center",
          justifyContent:  "center",
          marginBottom:    18,
        }}
      >
        <Icon size={32} color={ACCENT} strokeWidth={2} />
      </View>
      <Text
        style={{
          fontFamily: "PlusJakartaSans_700Bold",
          fontSize:   18,
          color:      C.t1,
          textAlign:  "center",
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          style={{
            fontFamily: "PlusJakartaSans_500Medium",
            fontSize:   14,
            color:      C.t3,
            textAlign:  "center",
            marginTop:  8,
            lineHeight: 20,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
