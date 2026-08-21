# Releasing Mermail CLI

Publishable CLI changes must bump `package.json` and `package-lock.json` together. CI enforces the bump. A merge to `main` then validates the package, creates the matching `vX.Y.Z` tag, publishes to npm with provenance, verifies the public version, and creates the GitHub release. The generated tag does not trigger a second release run; manual reruns are serialized and idempotent.

## npm Trusted Publishing

The one-time npm bootstrap is complete. `mermail-cli@0.1.1` created the public package, and npm now trusts the release workflow through OIDC:

- organization: `Nudgen-Marketing`
- repository: `mermail-cli`
- workflow: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

Publishing access requires 2FA and disallows bypass tokens. Do not add an `NPM_TOKEN`; later releases use short-lived GitHub OIDC credentials and automatic provenance.

## Cross-repository release orchestration

`upstream-mcp-release.yml` receives `mermail-mcp-released` from `Nudgen-Marketing/mermail`, validates the deployed server card, unauthenticated MCP boundary, and reproducibility of the tracked OpenAPI snapshot, then dispatches `mermail-cli-compatible` to `Nudgen-Marketing/mermail-skills`. Contract drift opens a version-specific issue and stops the chain. A successful standalone CLI release also dispatches `mermail-cli-released` to the skills repo. The public OpenAPI document currently covers a narrower HTTP surface than the CLI's MCP-backed operation manifest, so live compatibility is intentionally gated by the server card plus MCP behavior rather than by regenerating from production OpenAPI.

Configure `RELEASE_ORCHESTRATOR_TOKEN` as a fine-grained PAT with **Contents: write** access to `Nudgen-Marketing/mermail-skills`. The token is only used to create repository dispatch events; npm continues to use OIDC Trusted Publishing.
