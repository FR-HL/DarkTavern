import palette from "./src/shared/palette.js";
import colors from 'tailwindcss/colors';

export default {
  content: ["./src/**/*.{html,js,vue}"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",

      ... colors,
      ... palette,
    },
  },
  plugins: [],
};
