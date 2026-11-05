<script>
  let { data } = $props();
</script>

<h1>Smoke Test</h1>
<p>D1 user: <span data-testid="d1-user">{data.d1User?.name ?? "none"}</span></p>
<p>KV value: <span data-testid="kv-value">{data.kvValue ?? "none"}</span></p>
