# SSR Playground

React SSR app demonstrating server-side rendering with client hydration, KV storage, and dynamic markdown blog posts.

## Structure

```
src/
  App.tsx            # React component receiving server-side props
  main.ssr.tsx       # SSR entry — renderToString, KV visits, blog loading
  main.client.tsx    # Client hydration entry — hydrateRoot
routes/api/
  hello.ts           # Simple GET endpoint
blog/
  hello-world.md     # Sample blog post
  getting-started.md # Sample blog post
```

## Features

- **SSR entry point** — `defineRender()` in `main.ssr.tsx` renders React on the server with `renderToString()`
- **Client hydration** — `main.client.tsx` calls `hydrateRoot()` consuming server state from `window.__STATE__`
- **Server state transfer** — props serialized to `<script>window.__STATE__=...</script>` in the HTML
- **KV integration** — stores and increments visit count via `c.env.KV`
- **Dynamic blog routes** — matches `/blog/:slug` and loads corresponding `.md` file via `import(...?raw)`
- **Asset injection** — uses `assetTags.css`, `assetTags.preloads`, and `assetTags.body` for Vite asset tags
- **API routes** — coexists with SSR (e.g. `/api/hello`)
