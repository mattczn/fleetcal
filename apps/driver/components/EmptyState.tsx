import React from "react";
import { View, Text } from "react-native";
import { Inbox, type LucideIcon } from "lucide-react-native";

type Props = {
  title:     string;
  subtitle?: string;
  Icon?:     LucideIcon;
};

export function EmptyState({ title, subtitle, Icon = Inbox }: Props) {
  return (
    <View className="flex-1 items-center justify-center py-16 px-8">
      <View
        style={{
          width:           72,
          height:          72,
          borderRadius:    36,
          backgroundColor: "#e8f0fe",
          alignItems:      "center",
          justifyContent:  "center",
          marginBottom:    18,
        }}
      >
        <Icon size={32} color="#1a73e8" strokeWidth={2} />
      </View>
      <Text
        style={{
          fontFamily: "PlusJakartaSans_700Bold",
          fontSize:   18,
          color:      "#202124",
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
            color:      "#5f6368",
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
