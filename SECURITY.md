# Security policy

## Supported versions

Security fixes are made for the latest release line. The current supported line is 0.1.x. Upgrade to the
latest published version before reporting a vulnerability.

## Reporting a vulnerability

Please report security issues through [GitHub private vulnerability reporting](https://github.com/krimvp/xpl/security/advisories/new).
Do not open a public issue for an unpatched vulnerability. If private reporting is unavailable, contact the
maintainer through [GitHub](https://github.com/krimvp).

## Security model

`xpl view` and `xpl service` serve repository content. They bind to loopback by default; using `--host` to
bind another interface exposes that content to clients that can reach the host. Review the network boundary
before doing so.

The standalone HTML bundle includes source excerpts selected for the explanation and can be shared or
published. Check its contents before distribution. `integrity.json` records hashes that detect missing or
changed bundled files. It does not prove who published the package or that its contents are trustworthy.

Precise indexing may download and run language-specific SCIP tools through npm or the Go toolchain. These
tools and the repository's build dependencies run with the permissions of the current user. Use
`--precise off` to skip SCIP tools.
