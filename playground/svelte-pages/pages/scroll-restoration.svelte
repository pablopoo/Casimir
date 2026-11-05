<script lang="ts">
  import { Link } from "@void/svelte";
  const rows = Array.from({ length: 80 }, (_, index) => index + 1);
</script>

<div>
  <h1>Scroll restoration</h1>
  <p>Scroll down, follow a link, then use the browser Back button.</p>
  {#each rows as row (row)}
    <section data-testid={`scroll-row-${row}`} style="height: 120px">
      <h2 style="margin: 0">Row {row}</h2>
      <a href="/users">Go to Users</a>
      <Link href="/users">Visit Users</Link>
    </section>
  {/each}
</div>
