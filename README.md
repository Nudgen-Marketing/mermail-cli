# Mermail CLI

Official automation-first CLI for the Mermail Sold API and hosted MCP server.

## Install

```bash
npm install -g mermail-cli
export MERMAIL_API_KEY="sk-proj-your-key"
```

Requires Node.js 22 or newer.

## Examples

```bash
mermail doctor
mermail auth check
mermail workspaces list
mermail mailboxes list --format table
mermail emails send \
  --mailbox-id agent@mermail.app \
  --to recipient@example.com \
  --from agent@mermail.app \
  --subject "Hello" \
  --text "Hello from Mermail"
mermail emails delete --mailbox-id agent@mermail.app --email-id MESSAGE_ID --permanent --yes
mermail mcp check
```

JSON is the default output. Use `--format yaml`, `pretty`, `table`, or `raw`. Complex request bodies can be supplied with `--data`, `--data-file`, or `--data-file -` for stdin.

## Authentication

Use `MERMAIL_API_KEY` whenever possible. `--api-key` is supported for ephemeral automation but may be captured in shell history. The CLI never stores credentials and has no telemetry.

```bash
MERMAIL_BASE_URL=https://console-staging.mermail.app mermail mcp check
```

Destructive commands prompt in an interactive terminal and require `--yes` in non-interactive environments. Write, send, and delete requests are never retried automatically.

## Development

```bash
npm install
npm run check
```

The checked-in operation manifest intentionally exposes exactly 62 Sold API business operations. Console-only API-key administration is not available through project API keys.

## License

MIT
