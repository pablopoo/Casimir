# @void/platform

Packaged runtime for [Void Platform](https://void.cloud/guide/self-hosted-platform), a shared deployment environment for your team or customers in your Cloudflare account. The Void CLI uses this package to install and maintain the platform.

Your users can build and deploy apps without setting up separate Cloudflare accounts. Administrators control access, set resource limits, and inspect deployments and usage.

## Getting Started

Install the `void` CLI and start the guided platform setup:

```sh
npm install -D void
npx void platform install
```

Once the platform is installed, developers connect and deploy:

```sh
npx void connect api.example.com
npx void deploy
```

The platform is open source. Use it as provided, contribute improvements, or fork it to integrate your systems and customize deployment workflows.

## Documentation

- [Installation and prerequisites](https://void.cloud/guide/self-hosted-platform)
- [Administration](https://void.cloud/guide/platform-administration)
- [Maintenance and recovery](https://void.cloud/guide/platform/installation/maintenance)
- [Platform development](https://void.cloud/guide/platform-development)

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.
