# Release

GitHub Actions builds releases.

After the Chrome Web Store listing exists, set the repository variable `OPZERO_CHROME_EXTENSION_ID` to the published extension ID. Release builds will embed that ID into the packaged skill so the native-host installer can configure Chrome without asking the user to copy an ID.

Create and push a version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The release workflow uploads:

- `opzero-chrome-extension.zip`
- `opzero-chrome-skill.zip`

The workflow can also be run manually from GitHub Actions.
