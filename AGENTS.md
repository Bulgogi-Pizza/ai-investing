# Common agent instructions — SOT

Read this file, docs/planning/requirements.md, and the feature's documentation before changes. These rules apply equally to Codex, Claude, Gemini and humans.

- Keep planning, implementation, operations and tests organized by feature. Update feature documentation with code changes. Requirements SOT: docs/planning/requirements.md; architecture SOT: docs/architecture/system.md; delivery status SOT: docs/implementation/status.md.
- No community. Real orders are allowed only in the owner-only algorithm live mode, after every safeguard in docs/planning/next-phase-design.md section 4 passes in one pre-trade check. No other feature (recommendations, rebalancing, AI explanations) places orders, and tests never place real orders. Never present demo quotes, events or recommendations as live facts. Every financial suggestion must show provenance, horizon, assumptions and uncertainty.
- Only administrator-created active accounts may authenticate. Authorization is enforced on the server for every private endpoint. Never expose provider credentials to browser code.
- Public repository: never commit secrets, local environment files, customer data, logs, credentials or account identifiers. Use .env.example placeholders and cloud secret management. No token printing.
- Use reusable accessible components, responsive layouts, explicit loading/error/empty states, Korean language and KST dates.
- Changes require feature tests, applicable full checks, rendered browser inspection for UI and documentation updates. Record evidence honestly; blocked deployment is not complete deployment.
- Delegate bounded work when possible; supervisor continues independent work and critically reviews outputs. Prefer GPT Terra and Claude Sonnet where available; record unavailable models, never claim their use.
- Do not edit another agent's assigned files without coordination. No unreviewed security shortcuts, invented provider API schemas, implicit demo production access or personal-data browser persistence.
- Every finished task ends with a handoff in the same change: update docs/planning/next-steps.md with what was done, the next tasks (owner user/agent, priority, blocker) and the checks another agent must run before continuing (environment, pending verifications, known traps). Read it first when you start. A task without an updated handoff is not complete.
- Add future global instructions here, feature instructions under docs/agents/, and update the index. CLAUDE.md and GEMINI.md point here; do not duplicate policy.

## Deployment identity boundary

Use only the personal cloud identity explicitly designated by the user. Never use a default CLI identity or company project/billing implicitly. Pass account and project explicitly; keep actual private account identifiers and deployment notes in ignored `.local/deployment-account.md`. If that local file is absent, resolve identity with the user before creating resources. This is a user constraint, not a general approval gate for ordinary implementation.
