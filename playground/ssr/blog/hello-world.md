# Hello World

Welcome to the Void blog. This is a sample post rendered from a markdown file at build time.

## How it works

The `prerender` function in `src/main.ssr.tsx` scans the `blog/` directory and returns paths for each `.md` file. During the production build, each blog path is rendered through the SSR entry and written to `dist/client/blog/<slug>/index.html`.

At runtime, these prerendered HTML files are served as static assets — no filesystem access needed.
