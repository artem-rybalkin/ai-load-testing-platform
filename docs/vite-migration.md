# UI Migration: Next.js → Vite + React Router

## Why Next.js was chosen initially

Next.js was the default choice for the UI because it:
- Is the standard full-stack React framework with built-in routing, SSR, and code splitting
- Has excellent TypeScript and Tailwind support
- Comes with optimised font loading (`next/font/google`) and image handling
- Was already familiar from the project scaffolding

## The problem

When running the stack with Docker Desktop on **Windows**, the UI consistently produced `ERR_CONNECTION_RESET` errors in the browser for large JavaScript chunks on the first page load after startup.

### Root cause

Docker Desktop on Windows bridges the host Windows filesystem and the Linux container through a virtualisation layer (WSL2 or Hyper-V). This bridge adds approximately **500–600 ms latency per filesystem I/O operation** — roughly 100× slower than native Linux I/O.

Next.js (both webpack and Turbopack) uses **lazy compilation**: chunks are compiled the first time the browser requests them. For large vendor bundles like `react-dom` (~2–3 MB), this first compilation window was long enough that the browser's HTTP connection timed out, producing ERR_CONNECTION_RESET.

Next.js logged this directly:

```
⚠ Slow filesystem detected. The benchmark took 574ms.
  If /app/services/ui/.next/dev is a network drive, consider moving it to a local folder.
```

### What was tried before switching

| Attempt | Result |
|---------|--------|
| Turbopack (default in Next.js 16) | HTML loaded in 5.9s but vendor chunk requests timed out |
| webpack (`next dev --webpack`) | HTML request itself timed out (webpack compiles everything on first request, took 30+ s) |
| Named Docker volume for `.next` cache | Cache persisted between restarts but first-load window was still too long |
| Pre-warmup script (wget to trigger compilation before browser opens) | Compiled SSR routes but not client-side chunks (wget doesn't execute JavaScript) |
| Moving project to WSL2 native filesystem | Eliminates the problem entirely (I/O drops to ~5 ms) |

## The decision to migrate to Vite

All in-Next.js workarounds only addressed symptoms. The underlying issue was that Next.js always does some work lazily — on the first browser request — regardless of bundler.

**Vite takes a fundamentally different approach**: it pre-bundles vendor dependencies (react, react-dom, react-router-dom, recharts) at **server startup** using esbuild (a native Rust/Go binary). By the time the browser makes its first request, every vendor chunk is already optimised and sitting in Vite's in-memory cache. No compilation happens during request handling.

The app also had zero SSR requirements: every page was already marked `'use client'` and data was fetched from separate backend services. Next.js's SSR machinery added complexity with no benefit.

## Migration summary

| Item | Before | After |
|------|--------|-------|
| Framework | Next.js 16 (Turbopack) | Vite 6 + React Router v7 |
| Routing | File-based App Router (`app/`) | Declarative in `src/App.tsx` |
| Navigation | `next/link`, `next/navigation` | `react-router-dom` (`Link`, `useNavigate`, etc.) |
| Dynamic imports | `next/dynamic` | `React.lazy` + `<Suspense>` |
| Fonts | `next/font/google` | `@fontsource-variable/geist` |
| Env vars | `process.env.NEXT_PUBLIC_*` | `import.meta.env.VITE_*` |
| Dev entry | `app/layout.tsx` | `src/App.tsx` + `index.html` |
| Tailwind | `@tailwindcss/postcss` (PostCSS) | `@tailwindcss/vite` (native plugin) |
| Dev cache volume | `ui_next_cache` named volume | `ui_node_modules` named volume |

### Files added
- `services/ui/index.html` — Vite entry HTML
- `services/ui/vite.config.ts` — Vite config
- `services/ui/src/main.tsx` — app entry point
- `services/ui/src/App.tsx` — root router + layout

### Files removed
- `services/ui/next.config.ts`
- `services/ui/app/layout.tsx`
- `services/ui/postcss.config.mjs`
- `services/ui/next-env.d.ts`

## Result

- **Startup time**: 1.5–2.5 s (Vite pre-bundles deps with esbuild)
- **First browser load**: instant (all vendor chunks already in memory)
- **ERR_CONNECTION_RESET**: eliminated
- **HMR**: file changes detected via polling (`server.watch.usePolling: true`) with ~1 s latency on Docker Desktop Windows

## Additional issue encountered during migration

During debugging, `ERR_CONNECTION_RESET` persisted even after Vite started successfully. `netstat -ano | findstr :3006` revealed:

```
TCP    0.0.0.0:3006    LISTENING   4668   ← Docker port proxy
TCP    [::1]:3006      LISTENING   21444  ← zombie Node.js process
```

A leftover Node.js process (an old `npm run dev` that was never killed) was listening on the IPv6 loopback (`[::1]:3006`). Chrome prefers IPv6 for localhost, so browser connections were hitting the zombie process instead of Docker. The zombie returned an immediate connection reset.

**Fix**: `Stop-Process -Id 21444 -Force` (Windows PowerShell). This does not recur after a system reboot. To avoid it during development: always stop local Node.js servers (`Ctrl+C`) before starting the Docker stack.

## Recommendation for Windows users

If running without WSL2, the remaining Docker Desktop filesystem latency is acceptable (Vite startup ~2s, subsequent HMR ~1s). For the best experience, clone and run the project from inside WSL2's native filesystem — see the Windows note in [README.md](../README.md).
