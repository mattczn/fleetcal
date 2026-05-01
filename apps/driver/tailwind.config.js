/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand — mirrors dispatch-next web app's Google Calendar–inspired palette
        brand: {
          navy:   "#1a2332",
          blue:   "#1a73e8",
          blueDk: "#1765cc",
          blueLt: "#e8f0fe",
          orange: "#f97316",
          red:    "#ea4335",
        },
        gc: {
          surface:     "#ffffff",
          bg:          "#f8f9fa",
          border:      "#dadce0",
          borderLight: "#e8eaed",
          text1:       "#202124",
          text2:       "#3c4043",
          text3:       "#5f6368",
        },
        status: {
          scheduledBg:  "#f1f3f4",  scheduledFg:  "#5f6368",
          dispatchedBg: "#e8f0fe",  dispatchedFg: "#1558d6",
          enRouteBg:    "#fef3c7",  enRouteFg:    "#92400e",
          pickedUpBg:   "#f3e8fd",  pickedUpFg:   "#6b21a8",
          deliveredBg:  "#e6f4ea",  deliveredFg:  "#15803d",
          cancelledBg:  "#fce8e6",  cancelledFg:  "#b91c1c",
          tonuBg:       "#fef3c7",  tonuFg:       "#92400e",
          problemBg:    "#fef0e6",  problemFg:    "#b85c00",
        },
      },
      fontFamily: {
        sans:     ["PlusJakartaSans_500Medium",   "system-ui", "sans-serif"],
        medium:   ["PlusJakartaSans_600SemiBold", "system-ui", "sans-serif"],
        semibold: ["PlusJakartaSans_700Bold",     "system-ui", "sans-serif"],
        bold:     ["PlusJakartaSans_800ExtraBold","system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
