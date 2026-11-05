<script setup lang="ts">
type Props = {
  post: { slug: string; title: string; body: string };
};

defineProps<Props>();
</script>

<template>
  <div>
    <h1>{{ post.title }}</h1>
    <p>{{ post.body }}</p>
    <a href="/blog">&larr; Back to Blog</a>
  </div>
</template>
