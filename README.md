# Mermail CLI

Official automation-first CLI for the Mermail Sold API and hosted MCP server.

## Install

Until the package is on the public npm registry, install from GitHub:

```bash
npm install -g github:Nudgen-Marketing/mermail-cli
# or one-shot: npx --yes github:Nudgen-Marketing/mermail-cli --help
export MERMAIL_API_KEY="sk-proj-your-key"
```

Requires Node.js 22 or newer. After npm publish, `npm install -g mermail-cli` will work the same way.

## Examples

`--mailbox-id` accepts `public_id` (UUID), hosted alias id, or current email — prefer `public_id` from `mermail mailboxes list`.

```bash
mermail doctor
mermail auth check
mermail workspaces list
mermail mailboxes list --format table
mermail emails send \
  --mailbox-id MAILBOX_PUBLIC_ID \
  --to recipient@example.com \
  --from agent@mermail.app \
  --subject "Hello" \
  --text "Hello from Mermail"
mermail emails delete --mailbox-id MAILBOX_PUBLIC_ID --email-id MESSAGE_ID --permanent --yes
mermail mcp check
```

JSON is the default output. Use `--format yaml`, `pretty`, `table`, `raw`, or the interactive `explore` view. Transform structured output with JMESPath:

```bash
mermail mailboxes list --transform '[].{email:email, public_id:public_id}'
```

Flags and validation are generated per operation from the checked-in OpenAPI contract. Complex request bodies can still be supplied with `--data`, `--data-file`, or `--data-file -` for stdin.

## Authentication

Use `MERMAIL_API_KEY` whenever possible. `--api-key` is supported for ephemeral automation but may be captured in shell history. The CLI never stores credentials and has no telemetry.

**ChatGPT / Codex Official Plugins Directory** (when published) connects Mermail MCP with **OAuth Apps Connected** — no CLI key required there. This CLI always uses an API key against the Sold API / MCP probe endpoints.

```bash
MERMAIL_BASE_URL=https://console-staging.mermail.app mermail mcp check
```

Destructive commands prompt in an interactive terminal and require `--yes` in non-interactive environments. Write, send, and delete requests are never retried automatically.

## Development

```bash
npm install
npm run check
npm run validate:remote
```

The checked-in operation manifest intentionally exposes exactly 62 Sold API business operations. `npm run validate:openapi` checks every method/path and regenerates operation-specific flags; the scheduled remote contract job compares all 62 tool names with the production MCP server card. Console-only API-key administration is not available through project API keys.

## License

MIT
