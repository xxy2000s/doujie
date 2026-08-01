# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

These guidelines describe the small framework-free, read-only UI under `src/web/`.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Embedded asset and server layout | Complete |
| [Component Guidelines](./component-guidelines.md) | Native DOM/rendering and styling patterns | Complete |
| [Hook Guidelines](./hook-guidelines.md) | Framework-free browser logic and fetching | Complete |
| [State Management](./state-management.md) | DOM, server, and durable state | Complete |
| [Quality Guidelines](./quality-guidelines.md) | Read-only, accessibility, and verification | Complete |
| [Type Safety](./type-safety.md) | Server types and runtime validation | Complete |

---

## Pre-Development Checklist

1. Read directory, component, type-safety, and quality guidance.
2. Read browser-logic/state guidance when changing `APP_JS` behavior.
3. Read backend database/error guidance when changing a web API route.
4. Preserve localhost-only, read-only behavior unless the task explicitly changes the architecture.

---

**Language**: All documentation should be written in **English**.
