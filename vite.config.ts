import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { mergeConfig, defineConfig } from "vite";
import { sharedViteConfig } from "./vite.shared";

export default mergeConfig(sharedViteConfig, defineConfig({
  plugins: [react(), tailwindcss()]
}));
