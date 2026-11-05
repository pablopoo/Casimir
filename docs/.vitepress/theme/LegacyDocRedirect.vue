<script setup lang="ts">
import { useRouter, withBase } from 'vitepress';
import { nextTick, onMounted, watch } from 'vue';

const props = defineProps<{ page: string; links: Record<string, string> }>();
const router = useRouter();
function redirect() {
  if (router.route.data.relativePath !== props.page) {
    return;
  }
  const anchor = router.route.hash.slice(1);
  if (!Object.hasOwn(props.links, anchor)) {
    return;
  }
  const target = props.links[anchor];
  const [pathname, hash] = target.split('#');
  void router.go(`${withBase(pathname)}${router.route.query}#${hash}`, { replace: true });
}

watch(() => [router.route.data.relativePath, router.route.hash], redirect, { flush: 'post' });
// Let the index finish hydrating before replacing it with the destination page.
onMounted(() => nextTick(redirect));
</script>

<template>
  <span hidden />
</template>
