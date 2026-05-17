# Release

GitHub Actions builds releases.

Release builds embed the stable Chrome Web Store extension ID from `scripts/extension-id.store.json` into the packaged skill so the native-host installer can configure Chrome without asking the user to copy an ID.

Current stable extension ID:

```text
dcnjjnecbhipdbngkhjppkckpkellmld
```

Set `OPZERO_CHROME_EXTENSION_ID` only when intentionally building a package for a different extension ID.

Create and push a version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The release workflow uploads:

- `opzero-chrome-extension.zip`
- `opzero-chrome-skill.zip`

The workflow can also be run manually from GitHub Actions.
