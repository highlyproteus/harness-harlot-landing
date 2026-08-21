import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://harnessharlot.com",
  output: "static",
  build: {
    format: "directory",
  },
});
