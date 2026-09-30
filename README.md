# Site Command Palette

A keyboard-first Chrome extension that brings a fast command palette to any
website. Save the pages you use on each site, fuzzy-search them, and navigate
without leaving the keyboard.

The extension is currently available for local installation only and is not
yet published in the Chrome Web Store.

## Feature Highlights

- Flexible command scopes: exact sites by default, with global and wildcard patterns when needed.
- Commands use a consistent `Site › Page` name, with site names shared across matching destinations.
- Fuzzy search with bold character highlighting and keyboard result selection.
- Backtick opens the palette; Alt+Backtick also works from editable fields.
- Arrow keys select a command, Enter activates it, and Escape clears or closes.
- Tab toggles between commands in the current scope and all saved commands.
- Ctrl+Enter opens the selected command in a new tab.
- Default shortcuts use Alt+A to add, Alt+E to edit, and Alt+X to delete.
- Activation and palette-action shortcuts are configurable in Settings.
- Slash actions provide quick access to `/add`, `/theme`, and `/settings`.
- Light, Dark, and System themes with optional per-site overrides.
- Commands and preferences remain in local Chrome extension storage.
- Optional automatic backups write versioned JSON snapshots to a folder you choose.
- Page shortcuts are suppressed while the palette is open.

## Install Locally

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this repository's directory, which contains `manifest.json`.
6. Open or refresh a normal HTTP or HTTPS page.
7. Press backtick (`` ` ``) or Alt+Backtick (`` Alt+` ``).

Chrome will request access to websites because the extension must install its
keyboard listener and display the palette within each page. The extension does
not run on protected Chrome pages such as `chrome://extensions`.

## Privacy

Site Command Palette keeps commands and preferences locally. See the
[Privacy Policy](PRIVACY.md) for details.

## License

Site Command Palette is available under the [MIT License](LICENSE).
