# Opzero Chrome

Chrome automation extension for Opzero agents.

It includes:

- Manifest V3 Chrome extension
- Native messaging host
- JSON-RPC bridge
- Chrome Debugger Protocol bridge through `chrome.debugger`
- Tab/session/group management
- Cursor overlay content script
- Opzero agent skill

## Install For Users

Download `opzero-chrome-extension.zip` from the latest GitHub Release, unzip it, then load the folder from `chrome://extensions` with Developer mode enabled.

## Install The Agent Skill

Download `opzero-chrome-skill.zip` from the latest GitHub Release and install it into your agent's skills folder.

## Verify

```sh
pnpm run check
pnpm run check-native-host -- --extension-id <your-extension-id> --json
pnpm run check-extension -- --extension-id <your-extension-id> --json
pnpm run client -- ping
pnpm run client -- getInfo
```

If `ping` and `getInfo` work, Chrome, the extension, and the native host are connected.

## Development

See [docs/DEVELOPER.md](docs/DEVELOPER.md) for local setup and native host installation.

```sh
pnpm install
pnpm run build
pnpm run check
```

## Release

See [docs/RELEASE.md](docs/RELEASE.md).

## Chrome Web Store

See [docs/CHROME_WEB_STORE.md](docs/CHROME_WEB_STORE.md) and [docs/PRIVACY.md](docs/PRIVACY.md).
