<script lang="ts">
  let { initial = 0 }: { initial?: number } = $props();
  let count = $state(0);
  $effect(() => { count = initial; });
</script>

<div>
  <span data-testid="count">Count: {count}</span>
  <button onclick={() => count++}>Increment</button>
</div>
