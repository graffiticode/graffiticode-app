/** @type {import('tailwindcss').Config} */
import colors from 'tailwindcss/colors';
import tailwindForms from '@tailwindcss/forms';
import tailwindAspectRatio from '@tailwindcss/aspect-ratio';
import tailwindTypography from '@tailwindcss/typography';
import twElements from "tw-elements/dist/plugin.cjs";

export default {
  content: [
    "./node_modules/tw-elements/dist/js/**/*.js",
    "./src/**/*.{html,js}",
    "./src/pages/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sky: colors.sky,
        teal: colors.teal,
      },
    },
  },
  plugins: [
    tailwindForms,
    tailwindAspectRatio,
    tailwindTypography,
    twElements,
  ],
  darkMode: "class"
};
