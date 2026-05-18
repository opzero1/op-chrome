# Release

GitHub Actions builds releases.

Release builds embed the stable Chrome Web Store extension ID from `scripts/extension-id.store.json` into the packaged skill so the native-host installer can configure Chrome without asking the user to copy an ID.

The committed `skills/opzero-chrome` directory is also kept installable for Codex `skill-installer` GitHub path installs. Run `pnpm run build` before release changes so the generated `native-host`, `scripts`, and `chunks` files under `skills/opzero-chrome` match the packaged release skill.

Current stable extension ID:

```text
dcnjjnecbhipdbngkhjppkckpkellmld
```

Set `OPZERO_CHROME_EXTENSION_ID` only when intentionally building a package for a different extension ID.

Create and push a version tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The release workflow uploads:

- `opzero-chrome-extension.zip`
- `opzero-chrome-skill.zip`

The workflow can also be run manually from GitHub Actions.

## Chrome Web Store Updates

After the first Chrome Web Store approval, run the `Chrome Web Store` workflow manually and enter the Git tag to publish, for example `v0.1.1`. The workflow checks out that tag, builds the extension package, uploads it, and requests publication. Chrome still reviews each uploaded version before it reaches users.

Required GitHub Actions secrets:

- `CHROME_EXTENSION_ID`
- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`
- `CHROME_PUBLISHER_ID`

Each submitted update must increase `src/extension/manifest.json` version.
