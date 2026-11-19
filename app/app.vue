<script setup lang="ts">
import favicon from '~/assets/images/favicon.ico?url&no-inline'

const faviconHref = import.meta.client && favicon.startsWith(`${window.location.origin}/`)
  ? favicon.slice(window.location.origin.length)
  : favicon
useHead({
  link: [{ key: 'lyrex-favicon', rel: 'icon', type: 'image/x-icon', href: faviconHref }]
})
</script>

<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>

