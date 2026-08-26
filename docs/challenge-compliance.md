# Challenge compliance (Gate 0)

## Scope boundary

This is a standalone repository for the 2026 OpenAI WebMCP Challenge. Gate 0 contains no employer, client, private-project, proprietary, credential, or production-infrastructure material.

## Gate 0 evidence

- Next.js/React/TypeScript scaffold is configured with strict TypeScript.
- WebMCP direction was verified against current official Chrome documentation.
- The design documents the four synthetic services and flagship `Agent Gateway = DEGRADED` incident.
- The tool catalog explicitly excludes `approve_change` and equivalent agent approval capabilities.
- Human approval, rollback, deterministic reset, and audit boundaries are documented but not implemented.
- `.gitignore` excludes environment files, dependencies, build output, Vercel metadata, and PEM files.

## Deferred work

All simulator behavior, WebMCP registration, human approval, change execution, audit persistence, rollback, and scenario tests are deliberately deferred beyond Gate 0.
