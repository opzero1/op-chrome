# Opzero Chrome

Chrome automation extension for Opzero agents.

## Install For Users

Install Opzero Chrome from the Chrome Web Store:

```text
https://chromewebstore.google.com/detail/opzero-chrome/dcnjjnecbhipdbngkhjppkckpkellmld
```

For local development or manual testing, you can still download `opzero-chrome-extension.zip` from the latest GitHub Release, unzip it, then load the folder from `chrome://extensions` with Developer mode enabled.

## Install The Agent Skill

Install the `chrome-control` skill from the repository path with any agent runtime that supports repository/path-based skill installs:

```text
https://github.com/opzero1/op-chrome/tree/main/skills/chrome-control
```

Alternatively, install the latest release zip into opencode's global skills directory with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/opzero1/op-chrome/main/scripts/install-chrome-control-skill.sh | sh
```

Manual install:

```sh
mkdir -p ~/.config/opencode/skills/chrome-control
curl -fsSL https://github.com/opzero1/op-chrome/releases/latest/download/chrome-control-skill.zip -o /tmp/chrome-control-skill.zip
unzip -o /tmp/chrome-control-skill.zip -d ~/.config/opencode/skills/chrome-control
```

Trigger it in agents with `@chrome-control`, or by asking for Chrome/browser automation, Chrome setup checks, native host repair, tab/session control, or CDP access.

After installing the skill, run the native host installer from the installed skill directory:

```sh
node scripts/install-native-host.js --extension-id "$(node -p 'require("./scripts/extension-id.json").extensionId')"
```

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
