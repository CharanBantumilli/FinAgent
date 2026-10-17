# Security Policy

FinAGENT is a local-first research tool and is **not hardened for public
internet exposure** (e.g. `/api/admin` is unauthenticated by design for local
use). Do not deploy it publicly without adding authentication.

## Reporting a vulnerability

Please report privately through GitHub's
[Report a vulnerability](../../security/advisories/new) form rather than a
public issue. We aim to acknowledge reports within 7 days.

## Scope notes

- No financial advice: quotes may be delayed or simulated (labelled in the UI).
- Secrets belong in `.env`, which is git-ignored.
