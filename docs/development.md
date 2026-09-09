# Development

Use Node 24.11.1 and Bun 1.3.8.

```sh
bun install --frozen-lockfile
bun run dev:mobile
bun run dev:worker
bun run typecheck
bun run build
```

Mobile uses Expo Dev Client. The Worker health endpoint is `/health`.
External credentials and live provider checks belong to later verification gates.
