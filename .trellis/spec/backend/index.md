# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

These guidelines describe Doujie's current TypeScript daemon, SQLite, Feishu, and Codex control-plane conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Complete |
| [Database Guidelines](./database-guidelines.md) | SQLite queries and migrations | Complete |
| [Error Handling](./error-handling.md) | Error types and boundary handling | Complete |
| [Quality Guidelines](./quality-guidelines.md) | Code standards and verification | Complete |
| [Logging Guidelines](./logging-guidelines.md) | Console format, levels, and privacy | Complete |

---

## Pre-Development Checklist

1. Read `AGENTS.md` for runtime and safety invariants.
2. Read directory and quality guidelines for every backend change.
3. Also read database, error, or logging guidance when that boundary is touched.
4. Read the shared cross-layer guide for event/config/API/schema changes.

---

**Language**: All documentation should be written in **English**.
