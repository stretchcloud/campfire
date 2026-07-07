# Security Policy

## Supported Versions

Campfire is pre-1.0. Only the latest released version on npm
([`the-campfire`](https://www.npmjs.com/package/the-campfire)) receives
security fixes.

## Reporting a Vulnerability

Please **do not open a public issue** for security problems.

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/stretchcloud/campfire/security/advisories/new)
("Report a vulnerability"). Include reproduction steps and the version you
tested. You should receive an initial response within a few days; please
allow a reasonable window for a fix before public disclosure.

## Scope notes for self-hosters

Campfire is a self-hosted control plane that spawns agent CLIs on the host
machine. When exposing it beyond localhost:

- Enable password auth (`CAMPFIRE_PASSWORD` or Settings → Security) and put
  it behind TLS (reverse proxy).
- Invite links are bearer credentials that bypass password auth by design;
  they expire after 24 hours — share them accordingly.
- Auto-injected MCP servers are restricted by a default-deny policy
  (`web/server/mcp-policy.ts`); user-added servers are scanned and logged
  but not blocked.
