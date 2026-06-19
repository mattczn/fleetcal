import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Linking,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ArrowLeft } from "lucide-react-native";
import { supabase } from "@/lib/supabase";
import { f, RADIUS } from "@/lib/theme";
import { useTheme } from "@/lib/ThemeProvider";

// Canonical legal URLs hosted on the marketing site. Linked from the
// SMS opt-in disclosure — required for Twilio A2P 10DLC sign-off and
// Apple App Store review.
const PRIVACY_URL = "https://www.fleetcal.app/privacy-policy";
const TERMS_URL   = "https://www.fleetcal.app/terms-conditions";
const SUPPORT_URL = "https://www.fleetcal.app/support";

type Step = "phone" | "otp";

/** Format raw input as a US phone number: "(801) 555-0001". Caps at 10
 *  digits; partial input formats progressively as the driver types. */
function formatUSPhone(input: string): string {
  const d = input.replace(/\D/g, "").slice(0, 10);
  if (d.length === 0) return "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function LoginScreen() {
  const { C, ACCENT, SHADOW, isDark } = useTheme();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSendOtp() {
    const cleaned = phone.replace(/\D/g, "");
    if (cleaned.length < 10) {
      Alert.alert("Invalid number", "Please enter a valid 10-digit phone number.");
      return;
    }
    setLoading(true);
    const formatted = `+1${cleaned.slice(-10)}`;
    const { error } = await supabase.auth.signInWithOtp({ phone: formatted });
    setLoading(false);
    if (error) { Alert.alert("Error", error.message); return; }
    setStep("otp");
  }

  async function handleVerifyOtp() {
    if (otp.length !== 6) {
      Alert.alert("Invalid code", "Enter the 6-digit code from your SMS.");
      return;
    }
    setLoading(true);
    const cleaned = phone.replace(/\D/g, "");
    const formatted = `+1${cleaned.slice(-10)}`;
    const { error } = await supabase.auth.verifyOtp({
      phone: formatted, token: otp, type: "sms",
    });
    setLoading(false);
    if (error) {
      // Wrong code / expired / network → clear the input and let the
      // driver retry without backing out + re-entering the phone.
      const msg = error.message ?? "";
      const expired = /expir|token has expired/i.test(msg);
      Alert.alert(
        expired ? "Code expired" : "Verification failed",
        expired
          ? "That code is no longer valid. We'll send you a new one."
          : (msg || "The code didn't match. Try again, or request a new code."),
        expired
          ? [{ text: "OK", onPress: () => { setOtp(""); setStep("phone"); } }]
          : [{ text: "Try again", onPress: () => setOtp("") },
             { text: "Use a different number", onPress: () => { setOtp(""); setStep("phone"); } }],
      );
    }
  }

  const inputStyle = {
    backgroundColor: C.surface,
    color: C.t1,
    borderRadius: RADIUS.btn,
    paddingHorizontal: 16,
    paddingVertical: 15,
    fontSize: 17,
    borderWidth: 1,
    borderColor: C.border,
  } as const;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={["top", "bottom"]}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={{ flex: 1, paddingHorizontal: 24, justifyContent: "center" }}>
          {/* Brand */}
          <View style={{ borderRadius: 20, marginBottom: 22, alignSelf: "flex-start", ...SHADOW.card }}>
            <Image
              source={require("../../assets/icon.png")}
              style={{ width: 72, height: 72, borderRadius: 20 }}
            />
          </View>

          {step === "phone" ? (
            <>
              <Text style={[f(800), { fontSize: 28, color: C.t1, letterSpacing: -0.6 }]}>
                Sign in to FleetCal
              </Text>
              <Text style={[f(500), { fontSize: 15, color: C.t3, marginTop: 8, lineHeight: 21 }]}>
                Enter your mobile number and we&apos;ll text you a verification code.
              </Text>

              <Text style={[f(700), { fontSize: 11.5, color: C.t3, letterSpacing: 0.6, marginTop: 30, marginBottom: 8 }]}>
                MOBILE NUMBER
              </Text>
              <TextInput
                style={[f(700), inputStyle]}
                placeholder="(801) 555-0001"
                placeholderTextColor={C.t4}
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                value={phone}
                onChangeText={(t) => setPhone(formatUSPhone(t))}
                autoFocus
                maxLength={14}
              />

              <TouchableOpacity
                activeOpacity={0.9}
                onPress={handleSendOtp}
                disabled={loading}
                style={{
                  backgroundColor: ACCENT,
                  borderRadius: RADIUS.btn,
                  height: 54,
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: 16,
                  ...SHADOW.card,
                }}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={[f(800), { color: "#ffffff", fontSize: 16, letterSpacing: 0.2 }]}>
                    Send Code
                  </Text>
                )}
              </TouchableOpacity>

              {/* SMS consent disclosure — required by Twilio A2P 10DLC.
                  Must stay visible at the point of phone-number entry. */}
              <View style={{ marginTop: 22 }}>
                <Text style={[f(500), { fontSize: 11.5, color: C.t4, lineHeight: 17, textAlign: "center" }]}>
                  By tapping Send Code, you agree to receive SMS verification codes and
                  operational notifications from FleetCal. Msg &amp; data rates may apply.
                  Reply STOP to opt out, HELP for help.
                </Text>
                <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 14, marginTop: 12 }}>
                  <TouchableOpacity onPress={() => void Linking.openURL(PRIVACY_URL)}>
                    <Text style={[f(700), { fontSize: 12, color: C.blueInk }]}>Privacy</Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 12, color: C.t4 }}>·</Text>
                  <TouchableOpacity onPress={() => void Linking.openURL(TERMS_URL)}>
                    <Text style={[f(700), { fontSize: 12, color: C.blueInk }]}>Terms</Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 12, color: C.t4 }}>·</Text>
                  <TouchableOpacity onPress={() => void Linking.openURL(SUPPORT_URL)}>
                    <Text style={[f(700), { fontSize: 12, color: C.blueInk }]}>Support</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          ) : (
            <>
              <Text style={[f(800), { fontSize: 28, color: C.t1, letterSpacing: -0.6 }]}>
                Enter your code
              </Text>
              <Text style={[f(500), { fontSize: 15, color: C.t3, marginTop: 8, lineHeight: 21 }]}>
                We texted a 6-digit code to {phone}.
              </Text>

              <Text style={[f(700), { fontSize: 11.5, color: C.t3, letterSpacing: 0.6, marginTop: 30, marginBottom: 8 }]}>
                VERIFICATION CODE
              </Text>
              <TextInput
                style={[f(800), inputStyle, { fontSize: 26, letterSpacing: 10, textAlign: "center" }]}
                placeholder="000000"
                placeholderTextColor={C.t4}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                value={otp}
                onChangeText={setOtp}
                maxLength={6}
                autoFocus
              />

              <TouchableOpacity
                activeOpacity={0.9}
                onPress={handleVerifyOtp}
                disabled={loading}
                style={{
                  backgroundColor: ACCENT,
                  borderRadius: RADIUS.btn,
                  height: 54,
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: 16,
                  ...SHADOW.card,
                }}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={[f(800), { color: "#ffffff", fontSize: 16, letterSpacing: 0.2 }]}>
                    Verify &amp; Sign In
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => { setOtp(""); setStep("phone"); }}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 14, marginTop: 4 }}
              >
                <ArrowLeft size={15} color={C.t3} strokeWidth={2.2} />
                <Text style={[f(700), { color: C.t3, fontSize: 14 }]}>Use a different number</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
