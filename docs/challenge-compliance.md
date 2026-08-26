# Challenge compliance (Gate 1)

## Scope boundary

This is a standalone repository for the 2026 OpenAI WebMCP Challenge. Gate 0 contains no employer, client, private-project, proprietary, credential, or production-infrastructure material.

## Gate 0 evidence

- Next.js/React/TypeScript scaffold is configured with strict TypeScript.
- WebMCP direction was verified against current official Chrome documentation.
- The design documents the four synthetic services and flagship `Agent Gateway = DEGRADED` incident.
- The tool catalog explicitly excludes `approve_change` and equivalent agent approval capabilities.
- The pure domain authority, approval model, deterministic reset, audit foundation, and lifecycle are implemented and tested without external interfaces or effects.
- The typed four-service fixture and deterministic Vitest suite are present; neither contacts real infrastructure nor implements a WebMCP interface.
- `.gitignore` excludes environment files, dependencies, build output, Vercel metadata, and PEM files.

## Deferred work

WebMCP registration, human approval UI, dashboard, persistence, real execution effects, and infrastructure integration are deliberately deferred beyond Gate 1.
