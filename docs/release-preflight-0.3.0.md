# 0.3.0 release preflight

The last npm package is `@krimvp/xpl@0.2.2`. Git tags `v0.2.3` and `v0.2.4` point to an older
commit that still declares version 0.2.2. Both tag-triggered release runs failed before npm
publication. Neither version shipped to npm; the 0.3.0 changelog compares from `v0.2.2`.

After the preparation PR merges, check that main and its required CI jobs are green. Confirm npm still
does not have `@krimvp/xpl@0.3.0`, that its trusted publisher names `krimvp/xpl` and
`.github/workflows/release.yml`, and that the owner-only tag rule and GitHub Pages environment allow
the release. Only then create `v0.3.0` at the verified main commit.

The tag runs the [release workflow](../.github/workflows/release.yml): it checks tag ancestry,
package version and npm availability, builds and tests the installed artifact, dry-runs pack and
publish, then publishes to npm with provenance and creates a GitHub Release. The
[Pages workflow](../.github/workflows/pages.yml) builds and deploys the same tagged source. Verify
the npm version and provenance, GitHub Release, Pages URL, and tag workflow results before closing
[#222](https://github.com/krimvp/xpl/issues/222).
