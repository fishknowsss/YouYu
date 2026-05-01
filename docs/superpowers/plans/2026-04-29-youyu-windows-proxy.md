# YouYu Windows Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable Electron desktop shell for YouYu with tested settings, config generation, safe lifecycle ordering, static UI, and Windows packaging hooks.

**Architecture:** The Electron main process owns process control, settings, config generation, system proxy operations, and IPC. The renderer is a small React app with Home, Node Select, and Settings pages. Platform-sensitive behavior is isolated behind `systemProxy` so macOS development uses a mock while Windows can use a real adapter later.

**Tech Stack:** Electron, Vite, TypeScript, React, Vitest, electron-builder.

---

### Task 1: Project Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `electron.vite.config.ts`
- Create: `index.html`

- [ ] Create Electron/Vite/TypeScript config with scripts for `dev`, `test`, `typecheck`, `build`, and `dist:win`.
- [ ] Install dependencies.
- [ ] Verify `npm run typecheck` reaches source-level validation.

### Task 2: Tested Core Modules

**Files:**
- Test: `tests/main/config.test.ts`
- Test: `tests/main/settings.test.ts`
- Test: `tests/main/lifecycle.test.ts`
- Create: `src/main/mihomo/config.ts`
- Create: `src/main/storage/settings.ts`
- Create: `src/main/lifecycle.ts`

- [ ] Write failing tests for config generation, settings persistence, and lifecycle ordering.
- [ ] Implement minimal modules until tests pass.

### Task 3: Main Process and IPC

**Files:**
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/shared/ipc.ts`
- Create: `src/main/mihomo/api.ts`
- Create: `src/main/mihomo/process.ts`
- Create: `src/main/platform/systemProxy.ts`

- [ ] Wire Electron window creation.
- [ ] Expose typed IPC methods through preload.
- [ ] Keep macOS development on mock process/proxy behavior.

### Task 4: Renderer UI

**Files:**
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/styles.css`
- Create: `src/renderer/components/AppShell.tsx`
- Create: `src/renderer/components/PowerButton.tsx`
- Create: `src/renderer/components/StatusPanel.tsx`
- Create: `src/renderer/components/NodeList.tsx`
- Create: `src/renderer/pages/Home.tsx`
- Create: `src/renderer/pages/NodeSelect.tsx`
- Create: `src/renderer/pages/Settings.tsx`

- [ ] Build concise Chinese UI without implementation notes.
- [ ] Ensure buttons use short labels.
- [ ] Keep settings secondary and quiet.

### Task 5: Packaging

**Files:**
- Create: `electron-builder.yml`
- Create: `.github/workflows/build-windows.yml`
- Create: `scripts/smoke-test.ts`
- Create: `resources/mihomo/win-x64/.gitkeep`

- [ ] Configure NSIS Windows output.
- [ ] Add GitHub Actions Windows build.
- [ ] Add smoke test that checks app files and bundled mihomo placeholder.

