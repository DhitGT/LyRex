export default defineNuxtConfig({
  compatibilityDate: "2026-11-19",
  devServer: { port: 3031 },
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
