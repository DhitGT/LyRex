export default defineNuxtConfig({
  compatibilityDate: "2026-11-19",
  devServer: { port: 3031 },
  runtimeConfig: {
    public: { vercelUploads: process.env.VERCEL === "1" },
  },
  nitro: {
    serverAssets: [
      {
        baseName: "extraction-sandbox-engine",
        dir: "./engine",
        pattern: "*",
      },
      {
        baseName: "extraction-sandbox-server",
        dir: "./server/utils",
        pattern: "wav-waveform.ts",
      },
      {
        baseName: "extraction-sandbox-shared",
        dir: "./shared/utils",
        pattern: "*.ts",
      },
    ],
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
