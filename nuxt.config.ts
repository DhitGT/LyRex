export default defineNuxtConfig({
  compatibilityDate: "2026-11-19",
  devServer: { port: 3031 },
  nitro: { prerender: { routes: ["/", "/studio"] } },
  vite: { worker: { format: "es" } },
  modules: ["@nuxt/ui"],
  icon: {
    provider: "none",
    serverBundle: false,
    clientBundle: { scan: true },
  },
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
