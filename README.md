# Site Command Palette

A keyboard-first Chrome extension that brings a fast command palette to any
website. Save the pages you use on each site, fuzzy-search them, and navigate
without leaving the keyboard.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/site-command-palette/mggaoklidiacgmndlioocigolndokdfm).

![](/support/store/screenshots/palette-dark.png)

## Feature Highlights

- Flexible command scopes: exact sites by default, with global and wildcard patterns when needed.
- Commands use a consistent `Site › Page` name, with site names shared across matching destinations.
- Fuzzy search with bold character highlighting and keyboard result selection.
- Backtick opens the palette; Alt+Backtick also works from editable fields.
- Arrow keys select a command, Enter activates it, and Escape clears or closes.
- Tab toggles between commands in the current scope and all saved commands.
- Optional browsing-history search follows the same scope toggle and favors stronger matches and shorter URLs.
- Ctrl+Enter opens the selected command in a new tab.
- Default shortcuts use Alt+A to add, Alt+E to edit, and Alt+X to delete.
- Activation and palette-action shortcuts are configurable in Settings.
- Slash actions provide quick access to `/add`, `/theme`, and `/settings`.
- Light, Dark, and System themes with optional per-site overrides.
- Exact hostnames can be disabled from Settings when the palette should not run.
- Commands and preferences remain in local Chrome extension storage.
- Optional automatic backups write versioned JSON snapshots to a folder you choose.
  If Chrome removes folder access, backups pause and a red `!` appears on the extension icon.
  Open Settings and click **Reconnect folder** to approve access and back up the latest data.
- Page shortcuts are suppressed while the palette is open.

## Browsing History

History search is off by default. In Settings, under **Browsing history**, click
**Enable history search** and allow Chrome's history permission. **Disable history search**
turns it off and removes the permission.

Type at least three characters to find visited pages below your saved commands.
Tab switches between this site and all sites; the search prompt shows the current scope. Stronger
matches and shorter URLs come first. For example, `github vic` finds a repository,
while adding `pull` narrows the search to its pull requests. Adding words filters
results immediately. The first three characters retrieve candidates; the full
query fuzzy-matches them. Shorter searches show no history.

History stays local, is excluded from backups, and is not shown in incognito tabs.

## Install from Source

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this repository's directory, which contains `manifest.json`.
6. Open or refresh a normal HTTP or HTTPS page.
7. Press backtick (`` ` ``) or Alt+Backtick (`` Alt+` ``).

Chrome requests website access when you install the extension. To restrict access,
right-click its toolbar icon, open **This can read and change site data**, and choose
**On this site** or **On all sites**. Shortcuts work on allowed websites; reload the
page after changing access. Clicking the toolbar icon shows a shortcut reminder.
The extension does not run on protected Chrome pages such as `chrome://extensions`.

## Privacy

Site Command Palette keeps commands and preferences locally. See the
[Privacy Policy](PRIVACY.md) for details.

## License

Site Command Palette is available under the [MIT License](LICENSE) and is
provided **as is**, without warranty. See the license for the complete terms.
