# Developer Setup

## Local Extension Install

1. Download `opzero-chrome-extension.zip` from the latest GitHub Release, or run `pnpm run build` and use `dist/extension`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped extension folder or `dist/extension`.
6. Copy the generated extension ID.

## Native Host

From a local checkout:

```sh
pnpm install
pnpm run install-native-host -- --extension-id <your-extension-id>
```

Reload the extension in `chrome://extensions` after installing the native host.

The installer saves the extension ID to `dist/scripts/extension-id.json` so follow-up checks can run without passing `--extension-id` again.

## Verify

```sh
pnpm run check
pnpm run check-native-host -- --extension-id <your-extension-id> --json
pnpm run check-extension -- --extension-id <your-extension-id> --json
pnpm run client -- ping
pnpm run client -- getInfo
```
