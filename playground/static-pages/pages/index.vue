<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div>
    <h1 data-testid="home-title">{{ title }}</h1>
    <p>This is the static pages playground.</p>
  </div>
</template>
