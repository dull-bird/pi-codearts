# Security policy

This is an unofficial, in-process Pi / OMP extension. Installing it gives it the same operating-system permissions as its host. Review source before installing; use only accounts and environments you are authorized to access.

## Credential boundaries

- Independent browser OAuth is the default. Refresh tokens are rotated through each host's native credential store and refresh coordination (Pi auth.json; OMP SQLite AuthStorage). Credentials are never stored in this repository or model cache.
- No silent fallback to a CodeArts client's login. Read-only import and non-refreshable temporary authorization require explicit opt-in; neither is represented as durable OAuth.
- Pi and OMP must authorize independently. Do not copy refresh tokens or authentication databases between hosts: independent rotation of the same token can invalidate the other host's login. OMP's displayed account identity is opaque; the private protocol account JSON stays in its credential store.
- Refreshes only use credentials owned by the current host. The extension does not rotate or write the CodeArts client's original credential files.
- New credentials are bound to a configured environment. Existing official unbound credentials migrate only to the original official environment.
- A custom environment is a trust decision, not just a convenience URL. Configuring a malicious identity service or gateway can expose credentials and prompts. Confirm all endpoints with your administrator.
- Endpoints must use HTTPS without URL credentials, query strings or fragments. Model-supplied URLs and project configuration cannot redirect credential routing. Chat transport restricts the exact configured path; credential-bearing fetches disable redirects.
- No disabled TLS verification. Use approved corporate CA configuration when necessary.

## Browser authorization

PKCE and ES256 DPoP bind the authorization code exchange and token requests. A random-port loopback listener is opened only during authorization and closed after completion, timeout or cancellation. The verified CodeArts official portal uses a nonstandard, server-managed callback state rather than echoing an extension-supplied OAuth state. Its `stateMode: "pkce"` relies on the per-attempt PKCE verifier for code-exchange binding and does not pretend to verify that callback state. Compatible enterprise environments that echo standard OAuth state can use `stateMode: "required"`, which sends a random state and rejects missing or mismatched callbacks. Legacy tickets require explicit opt-in.

## Operational limits

- Refresh tokens can expire or be revoked. Reauthorization is then required.
- Background model discovery is metadata-only, bounded by a timeout, and canceled on session shutdown. No code self-update or subnet scanning.
- busy/idle heartbeats are best effort. Network loss or a forced process kill can prevent idle delivery; service-side cleanup still matters. The extension does not bypass concurrent-session quotas.
- Usage totals are service-reported; zero configured cost is not a promise of free service.
- The plugin supports the currently implemented CodeArts wire protocol, not arbitrary Huawei Cloud products or every private SSO deployment.

## Reporting

Do not put access/refresh tokens, AK/SK, DPoP private JWKs, auth.json, full HTTP headers or private enterprise addresses in public issues. Use a private GitHub vulnerability report where available, or first ask for a private reporting channel without including the sensitive details.

If credentials are exposed, revoke them with the service and reauthorize. Deleting a local copy alone does not revoke a server-side token.
