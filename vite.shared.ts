import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const sharedViteConfig = {
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src")
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("recharts") || id.includes("d3-")) {
            return "vendor-charts";
          }
          return undefined;
        }
      }
    }
  }
} satisfies UserConfig;
