# Security Policy

## Reporting a Vulnerability

Sumbox processes personal WhatsApp data and uses local credentials for
PostgreSQL and RabbitMQ. If you discover a security vulnerability, please
report it privately.

**Do not open a public GitHub issue.** Instead, email the maintainer directly
at **eyaldelarea@gmail.com** — or reach out via the [GitHub security
advisories](https://github.com/EyalDelarea/Sumbox/security/advisories/new)
tab.

You should receive a response within 48 hours. If you don't, follow up.

## Scope

- Original Sumbox source code (the contents of this repository).
- Third-party dependencies are the responsibility of their respective
  maintainers; report issues with those through their own channels.

## Out of scope

- The `.env` file (secret rotation is the user's responsibility).
- Weak local DB passwords that are documented as defaults (see
  `src/db/migrations/1748649600024_create_app_roles.ts` and the README
  rotation note).

## Safe harbor

We will not pursue legal action against anyone who:
1. Reports a vulnerability through the private channel above.
2. Does not access or exfiltrate other users' data.
3. Does not intentionally degrade service availability.
4. Stops testing once the issue is confirmed and does not disclose it
   publicly before a fix is available.
