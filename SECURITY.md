# Security

Account Switcher is a trusted, unsandboxed Paseo plugin. It runs as the daemon's
user and can read that user's provider credentials. Install only source you
trust, and keep access to the daemon restricted to trusted clients.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** action in this repository's Security tab
when private reporting is enabled. If it is unavailable, ask the maintainer for a
private reporting channel before sending details. Do not post credentials or an
exploit against a real account in a public issue.

A useful report includes the affected version, provider, operating system,
reproduction steps using synthetic accounts, and the expected versus actual
behavior. Redact access and refresh tokens, one-time codes, authorization URL
queries, account identifiers, and private filesystem paths from logs.

The current development version receives security fixes. There is no guaranteed
response time or long-term support commitment for older versions.

## Credential handling

- The official provider CLI performs sign-in and token refresh.
- Managed profiles isolate authorization data; shared settings and conversation
  history are intentional. Profiles are not an operating-system security boundary.
- Access and refresh tokens are not returned through plugin RPC. Temporary sign-in
  links and device codes are returned to the initiating UI and kept in memory.
- Registry and usage-cache files are private to the daemon user. Usage data is
  keyed by the confirmed identity and is not transferred between identities.
- A missing or unavailable assigned profile fails closed instead of falling back
  to another account.

See [the README](README.md) for supported behavior and known limitations.
