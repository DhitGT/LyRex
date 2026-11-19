export default defineNuxtConfig({
  compatibilityDate: "2026-11-19",
  devServer: { port: 3031 },
  runtimeConfig: {
    public: { vercelUploads: process.env.VERCEL === "1" },
  },
  nitro: {
    serverAssets: process.env.VERCEL === "1" ? [
      { baseName: "extraction-sandbox", dir: ".", pattern: "{engine/*.{ts,json},server/utils/wav-waveform.ts,shared/utils/{waveform,pitch,lyrics}.ts}" },
    ] : [],
    vercel: { functions: { maxDuration: 300 } },
  },
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
  ui: {
    fonts: false,
    colorMode: false,
  },
  app: {
    head: {
      htmlAttrs: { lang: "id" },
      title: "LyRex",
    },
  },
});
