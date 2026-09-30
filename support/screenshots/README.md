# Screenshot generator

Generate reproducible Chrome Web Store screenshots from the real extension UI:

```bash
op screenshots
```

The tool creates a temporary Chrome profile, seeds the configured commands and
settings, loads the unpacked extension over a local generic fixture, drives the
requested screen, and writes opaque 1280x800 PNGs to `support/store/screenshots`.
The default 800x500 logical viewport is captured at 1.6x pixel density so the
palette occupies more of the Store image without changing its real CSS.

Edit `config.json` to define shared or per-screenshot commands and these states:

- `screen`: `list`, `add`, `edit`, or `settings`
- `theme`: `light` or `dark`
- `paletteScope`: `site` or `all`
- `query`: optional search text; for `edit`, it identifies the command to edit
- `form`: optional stable `site`, `page`, `url`, and `scope` values for add/edit
- `focus`: optional `Site`, `Page`, `URL`, or `Scope` field for add/edit

Set `form.preserveScopePreset` when a screenshot should replace the displayed
scope without recomputing the preset indicator from the offline fixture host.

Commands use `global`, `site`, or a normal scope pattern. A URL beginning with
`fixture:` points to the local fixture, such as `fixture:/docs`.

Pass another configuration file when experimenting:

```bash
node support/screenshots/generate.mjs path/to/config.json
```

Live websites are intentionally unsupported. This keeps captures deterministic
and avoids including third-party page content in Store assets.

Set `paletteCrop` on a list screenshot to also create a transparent crop of the
palette in `support/store/palette-crops`. These crops are intended for composing
the promotional tiles, not for direct Chrome Web Store screenshot upload.
