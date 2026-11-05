<script setup lang="ts">
import { Link } from '@void/vue';
</script>

<template>
  <div>
    <h1>Scroll restoration</h1>
    <p>Scroll down, follow a link, then use the browser Back button.</p>
    <section v-for="row in 80" :key="row" :data-testid="`scroll-row-${row}`" style="height: 120px">
      <h2 style="margin: 0">Row {{ row }}</h2>
      <a href="/users">Go to Users</a>
      <Link href="/users">Visit Users</Link>
    </section>
  </div>
</template>
