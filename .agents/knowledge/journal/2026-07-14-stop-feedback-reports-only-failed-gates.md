# Stop feedback reports only failed gates

Date: 2026-07-14

## Decision

A lifecycle Stop attempt may run `run-checks` and `verify` before the attempt's final evidence is persisted. During that internal `verify`, Hook readiness can temporarily appear unproved even though the Hook is currently executing.

Stop failure feedback therefore includes `verify` output only when `verify` itself fails. A successful `verify` must not leak transient readiness guidance into an unrelated check failure. Failed checks include their declared command and a bounded five-line output tail so the Agent can continue without asking the user to decode an exit code.

This changes diagnostics only. A failed check still blocks Stop, cannot be waived as a check failure, and the same Agent session may retry after fixing it.
