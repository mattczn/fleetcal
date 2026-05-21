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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Truck, ArrowLeft } from "lucide-react-native";
import { supabase } from "@/lib/supabase";

// Canonical legal URLs hosted on the marketing site. Linked from this
// screen so the SMS opt-in disclosure points at the real Privacy /
// Terms / Support pages — required for Twilio A2P 10DLC sign-off and
// Apple App Store review.
const PRIVACY_URL = "https://www.curzontrucking.com/app/privacy-policy";
const TERMS_URL   = "https://www.curzontrucking.com/app/terms-conditions";
const SUPPORT_URL = "https://www.curzontrucking.com/app/support";

type Step = "phone" | "otp";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

export default function LoginScreen() {
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
      // driver retry without backing out + re-entering the phone. If
      // the code expired Supabase returns a specific message; in that
      // case bounce back to the phone step so they can request a new
      // code. Either way the user has a clear path forward instead of
      // being stuck on a dismissed alert with a 6-digit field already
      // showing their bad code.
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

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a2332" }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={{ flex: 1, paddingHorizontal: 26, justifyContent: "center" }}>
          {/* Brand */}
          <View
            style={{
              width: 56, height: 56, borderRadius: 16,
              backgroundColor: "#1a73e8",
              alignItems: "center", justifyContent: "center",
              marginBottom: 22,
              shadowColor: "#1a73e8",
              shadowOpacity: 0.4,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 6 },
            }}
          >
            <Truck size={28} color="#ffffff" strokeWidth={2.4} />
          </View>

          <Text style={[txt(800), { fontSize: 32, color: "#ffffff", letterSpacing: -0.5 }]}>
            Curzon
          </Text>
          <Text style={[txt(800), { fontSize: 32, color: "#1a73e8", letterSpacing: -0.5, marginTop: -4 }]}>
            Trucking
          </Text>
          <Text
            style={[
              txt(500),
              { fontSize: 14, color: "rgba(255,255,255,0.55)", marginTop: 8, lineHeight: 20 },
            ]}
          >
            Driver portal — sign in with your phone number to see today&apos;s loads.
          </Text>

          <View style={{ height: 36 }} />

          {step === "phone" ? (
            <>
              <Text
                style={[
                  txt(700),
                  { fontSize: 12, color: "rgba(255,255,255,0.7)", letterSpacing: 0.6, marginBottom: 8 },
                ]}
              >
                MOBILE NUMBER
              </Text>
              <TextInput
                style={[
                  txt(600),
                  {
                    backgroundColor: "rgba(255,255,255,0.08)",
                    color: "#ffffff",
                    borderRadius: 14,
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    fontSize: 16,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.14)",
                    marginBottom: 16,
                  },
                ]}
                placeholder="(801) 555-0001"
                placeholderTextColor="#5f6368"
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                value={phone}
                onChangeText={setPhone}
                autoFocus
                maxLength={14}
              />

              <TouchableOpacity
                activeOpacity={0.85}
                onPress={handleSendOtp}
                disabled={loading}
                style={{
                  backgroundColor: "#1a73e8",
                  borderRadius: 14,
                  paddingVertical: 16,
                  alignItems: "center",
                  shadowColor: "#1a73e8",
                  shadowOpacity: 0.35,
                  shadowRadius: 14,
                  shadowOffset: { width: 0, height: 6 },
                }}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={[txt(800), { color: "#ffffff", fontSize: 15, letterSpacing: 0.2 }]}>
                    Send Code
                  </Text>
                )}
              </TouchableOpacity>

              {/* SMS consent disclosure — required by Twilio A2P 10DLC.
                  Must be visible at the point of phone-number entry so
                  the campaign reviewer can confirm consent isn't buried
                  in the terms. */}
              <View style={{ marginTop: 18 }}>
                <Text
                  style={[
                    txt(500),
                    { fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 16, textAlign: "center" },
                  ]}
                >
                  By tapping Send Code, you agree to receive SMS verification
                  codes and operational notifications from Curzon Trucking at
                  the number above. Msg &amp; data rates may apply. Msg
                  frequency varies. Reply STOP to opt out, HELP for help.
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: 14,
                    marginTop: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <TouchableOpacity onPress={() => void Linking.openURL(PRIVACY_URL)}>
                    <Text style={[txt(600), { fontSize: 11, color: "rgba(255,255,255,0.75)", textDecorationLine: "underline" }]}>
                      Privacy
                    </Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>·</Text>
                  <TouchableOpacity onPress={() => void Linking.openURL(TERMS_URL)}>
                    <Text style={[txt(600), { fontSize: 11, color: "rgba(255,255,255,0.75)", textDecorationLine: "underline" }]}>
                      Terms
                    </Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>·</Text>
                  <TouchableOpacity onPress={() => void Linking.openURL(SUPPORT_URL)}>
                    <Text style={[txt(600), { fontSize: 11, color: "rgba(255,255,255,0.75)", textDecorationLine: "underline" }]}>
                      Support
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          ) : (
            <>
              <Text
                style={[
                  txt(700),
                  { fontSize: 12, color: "rgba(255,255,255,0.7)", letterSpacing: 0.6, marginBottom: 4 },
                ]}
              >
                VERIFICATION CODE
              </Text>
              <Text style={[txt(500), { fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 14 }]}>
                Sent to {phone}
              </Text>

              <TextInput
                style={[
                  txt(800),
                  {
                    backgroundColor: "rgba(255,255,255,0.08)",
                    color: "#ffffff",
                    borderRadius: 14,
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    fontSize: 26,
                    letterSpacing: 8,
                    textAlign: "center",
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.14)",
                    marginBottom: 16,
                  },
                ]}
                placeholder="000000"
                placeholderTextColor="#3c4043"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                value={otp}
                onChangeText={setOtp}
                maxLength={6}
                autoFocus
              />

              <TouchableOpacity
                activeOpacity={0.85}
                onPress={handleVerifyOtp}
                disabled={loading}
                style={{
                  backgroundColor: "#1a73e8",
                  borderRadius: 14,
                  paddingVertical: 16,
                  alignItems: "center",
                  marginBottom: 12,
                  shadowColor: "#1a73e8",
                  shadowOpacity: 0.35,
                  shadowRadius: 14,
                  shadowOffset: { width: 0, height: 6 },
                }}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={[txt(800), { color: "#ffffff", fontSize: 15, letterSpacing: 0.2 }]}>
                    Verify & Sign In
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setStep("phone")}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8 }}
              >
                <ArrowLeft size={14} color="rgba(255,255,255,0.55)" strokeWidth={2.2} />
                <Text style={[txt(600), { color: "rgba(255,255,255,0.55)", fontSize: 13 }]}>
                  Use a different number
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
