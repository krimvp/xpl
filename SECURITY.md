# Security policy

## Supported versions

Security fixes are made for the latest minor release, now 0.3.x (see [CHANGELOG.md](CHANGELOG.md)).
Upgrade to the latest published version before you report a vulnerability.

## Reporting a vulnerability

Please report security issues through [GitHub private vulnerability reporting](https://github.com/krimvp/xpl/security/advisories/new).
Do not open a public issue for an unpatched vulnerability. If private reporting is unavailable, contact the
maintainer through [GitHub](https://github.com/krimvp).

## Security model

`xpl view` and `xpl service` serve repository content. `xpl view` binds to loopback by default. Its `--host`
option binds another interface, and then every client that can reach that interface can read the content.
Check the network boundary before you use it. `xpl service` always binds to 127.0.0.1.

The standalone HTML bundle holds the source excerpts that the guide links to, and it can be shared or
published. Check its contents before distribution. `integrity.json` records hashes that detect missing or
changed bundled files. It does not prove who published the package or that its contents are trustworthy.

Precise indexing may download and run language-specific SCIP tools through npm or the Go toolchain. These
tools and the repository's build dependencies run with the permissions of the current user. Use
`--precise off` to skip SCIP tools.

`xpl live --backend api` sends the guide and the source code it explains to the model endpoint you set in
`XPL_LLM_BASE_URL` (or `--base-url`), and nowhere else. It reads the key only from `XPL_LLM_API_KEY`, sends it
only to that endpoint, and leaves it out of the status, the page, the logs and error messages. The model reads
the files of the repository's index through read-only tools; it cannot run commands or write files, and only a
patch that passes the checks of `xpl apply` is applied. Use a local endpoint (Ollama, LM Studio, vLLM) to keep
the code on your machine. `xpl live --backend claude` runs Claude Code, which sends code to its provider under
your Claude Code settings.
