# @void/isr

Incremental revalidation helpers for [Void](https://void.cloud) runtimes and deployment adapters. Applications use `void/isr` to revalidate pages.

For runtime authors, this package provides three entry points:

- `@void/isr`: versioned cache keys and edge-cache URLs
- `@void/isr/core`: codecs, cache policy, TTL selection, and response helpers
- `@void/isr/runtime`: the direct Cloudflare KV and Cache API runtime

Cache writes and purges must use the same key helpers. Incompatible format changes require a new cache-key version.

## Documentation

See [Revalidation](https://void.cloud/guide/edge/revalidation) for application usage and [Platform Development](https://void.cloud/guide/platform-development) for building a runtime or adapter.

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.
