# @alt/ui

The dashboard for the AI Load Testing Platform — a Vite + React + React Router SPA (test creation, live results, flow builder, chat, team/org management).

## Dev commands

```bash
npm run dev      # start the Vite dev server (http://localhost:3006)
npm run build    # tsc -b && vite build
npm run preview  # preview the production build on port 3006
npm run lint     # eslint
```

This service is normally run as part of the full stack via `docker compose up` from the repo root, not standalone — see the root [README's Quick Start](../../README.md#quick-start) and the [Development Guide](../../docs/how-to/development.md) for hot-reload dev mode, the full test suite, and how the dev server proxies `/api`, `/data`, `/viewer`, and `/recordings` to the other services.
