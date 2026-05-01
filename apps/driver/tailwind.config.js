/** @type {import('tailwindcss').Config} */
const { colors, typography } = require("@fleetcal/tokens");

module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand:  colors.brand,
        gc:     colors.gc,
        status: colors.status,
      },
      fontFamily: {
        sans:     typography.fontFamily.sans,
        medium:   typography.fontFamily.medium,
        semibold: typography.fontFamily.semibold,
        bold:     typography.fontFamily.bold,
      },
    },
  },
  plugins: [],
};
