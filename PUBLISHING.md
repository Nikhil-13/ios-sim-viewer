# Publishing checklist

Steps to publish iOS Simulator Viewer to the VS Code Marketplace from the separate GitHub account.

## 1. Fill in the placeholders

| File | Placeholder | Replace with |
| --- | --- | --- |
| `package.json` | `your-publisher-id` | Your Marketplace publisher ID (lowercase, from https://marketplace.visualstudio.com/manage) |
| `package.json` | `your-github-user` (3 URLs) | The new GitHub account's username |
| `LICENSE` | `YOUR_NAME` | The copyright holder's name |

Check that none are left:

```sh
grep -rn "your-publisher-id\|your-github-user\|YOUR_NAME" package.json LICENSE
```

## 2. Use the new account's identity for git

Commits must not carry your main identity. These settings apply to this repo only:

```sh
git init
git config user.name "<new account name>"
git config user.email "<new account email or its GitHub noreply address>"
git add . && git commit -m "Initial release"
```

## 3. Push to GitHub before publishing

Create the `ios-sim-viewer` repo on the new account and push. The README links to `images/screenshot.png` on GitHub, so the screenshot won't show on the Marketplace until it's pushed.

```sh
git remote add origin https://github.com/<new-account>/ios-sim-viewer.git
git push -u origin main
```

## 4. Publish for Mac only

1. Create a publisher at https://marketplace.visualstudio.com/manage, signed in with the new account. Its ID must match `publisher` in `package.json`.
2. Create a personal access token in Azure DevOps (https://dev.azure.com, User settings → Personal access tokens). Set Organization to "All accessible organizations" and Scopes to Marketplace → Manage.
3. Log in and publish. The target flag stops Windows and Linux users being offered the extension.

```sh
npx @vscode/vsce login <publisher-id>
npx @vscode/vsce publish --target darwin-arm64 darwin-x64
```

To check the package first without publishing, run `npx @vscode/vsce package`. It should finish with no warnings.

## 5. Remove your local copy

After installing from the Marketplace, delete the old symlinked install. It registers the same view and commands, so the two copies conflict:

```sh
rm ~/.vscode/extensions/local.ios-sim-viewer-0.1.0
```

Then run "Developer: Reload Window".

## Later releases

Bump `version` in `package.json`, add an entry to `CHANGELOG.md`, commit and push, then run the publish command from step 4 again.
