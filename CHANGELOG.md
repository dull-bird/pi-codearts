# Changelog

## [0.2.0] - 2026-11-10

- Package the extension for installation via Pi's Git package manager.
- Make independent, refreshable browser OAuth the default; reject silent temporary/local-login fallback.
- Add trusted environment profiles with separate Provider IDs, credential bindings and model caches.
- Preserve compatibility with existing official independent OAuth credentials.
- Add configurable endpoints, routes, Client ID, PKCE method, scope, optional interfaces and model-directory strategies.
- Read complete endpoint candidates from known local client configurations, requiring explicit confirmation before trust.
- Discover entitled tenant Agents instead of requiring a universal fixed Agent ID.
- Query thinking-variants metadata and expose only supported Pi reasoning levels; verify real GLM-5.2 high/max requests.
- Discover models after login and refresh stale metadata in interactive sessions, with offline cache fallback.
- Add security, lifecycle, native-Pi login, multi-environment and clean-package installation regression tests.
- Add CI, MIT license, reusable setup documentation and security policy.

## [0.1.0] - 2026-11-10

- Local implementation of CodeArts signing, browser OAuth, DPoP refresh and read-only credential import.
- Streaming inference, tools, images, cancellation, gateway error handling and busy/idle heartbeat support.
- Initial live authentication, inference and Pi tool-execution tests.
