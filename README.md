# Site Command Palette

A keyboard-first Chrome extension that brings a fast command palette to any
website. Save the pages you use on each site, fuzzy-search them, and navigate
without leaving the keyboard.

The extension is currently available for local installation only and is not
yet published in the Chrome Web Store.

## Feature Highlights

- Site-specific commands: links saved on one hostname stay scoped to that site.
- Fuzzy search with bold character highlighting and keyboard result selection.
- Backtick opens the palette; Alt+Backtick also works from editable fields.
- Arrow keys select a command, Enter activates it, and Escape clears or closes.
- Alt+A adds the current page with its title and URL already filled in.
- Alt+E edits the selected command and Alt+X deletes it.
- Slash actions provide quick access to `/add`, `/theme`, and `/settings`.
- Light, Dark, and System themes with optional per-site overrides.
- Commands and preferences remain in local Chrome extension storage.
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

## License

Site Command Palette is available under the [MIT License](LICENSE).
