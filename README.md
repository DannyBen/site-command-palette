# Site Command Palette

A minimal Chrome extension that provides a hostname-specific command palette.

## Try it in Chrome on Windows

1. Copy this directory to the Windows machine.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Select this directory (the one containing `manifest.json`).
6. Open or refresh a normal HTTP or HTTPS page.
7. Press backtick (`` ` ``) or Alt+Backtick (`` Alt+` ``).

Chrome will warn that the extension can read and change data on websites because
the in-page palette requires a content script on those sites.

## Prototype behavior

- Commands are scoped to the exact hostname. Commands saved on
  `mail.google.com` are not shown on `calendar.google.com`.
- **Add current page** fills in the current page title and URL.
- Typing performs fuzzy filtering.
- Up and down arrows change the selected command.
- Enter opens the selected link or runs the selected built-in action.
- Alt+A opens the add-current-page form while the palette is open.
- Alt+T opens the palette action list filtered to `/theme`.
- Alt+E edits the selected command while the palette is open.
- Alt+X deletes the selected command while the palette is open.
- Escape returns from the add form, clears an active filter, and then closes the
  palette on successive presses.
- The remove button deletes a command.
- Bare backtick opens the palette outside editable fields. Alt+Backtick also
  opens it from inputs, textareas, and editable content.
- Bare backtick and Alt+Backtick both close an open palette, including while
  the search field is focused or filtered.
- While the palette is open, its keyboard events are stopped before they reach
  the underlying page's shortcut handlers.
- Typing `/` shows built-in actions in the same result list as saved links.
- `/add` opens the add-current-page form.
- `/theme` offers global, per-site Light, and per-site Dark choices. The global
  theme is Light until a settings page is added.
- Theme actions apply and refresh the palette in place, retaining the `/theme`
  filter and selected action.

The palette cannot run on protected Chrome pages such as `chrome://extensions`.

## Test

Run the complete dependency-free suite with:

```bash
npm test
```

The suite uses Node's built-in test runner. It validates pure logic and the
manifest, then launches installed Chromium against a localhost-only fixture to
exercise real extension keyboard and theme behavior. It creates an isolated
temporary Chrome profile and removes it afterward. Set `CHROMIUM_BIN` if the
Chromium executable is installed somewhere other than a standard Linux path.
