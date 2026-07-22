# build-combined.js

Generates or updates a treatise's `combined.js` from its two source `.txt` files (the
Latin critical edition and a translation), following the format that `_layouts/ctw_texts.html`
and `ScriptLibrary/viewer.js` expect (see `Tinctoris/texts/<treatise>/combined.js` for
examples).

Written primarily for treatises that only have an edited text and one translation
embedded — `complexus`, `proportionale1`, `proportionale23` — but it's safe to run
against a treatise that has more (e.g. `depunctis`'s `.V`/`.BU`/`.Br1`/`.G` witness
transcriptions): anything the script doesn't manage is left untouched in the output.

## Usage

```
node scripts/build-combined.js --treatise complexus \
  --edited "Tinctoris/texts/complexus/11 Complexus effectuum.txt" \
  --translation "Tinctoris/texts/complexus/11 Complexus effectuum (English).txt"
```

Any option left out is asked for interactively. Run with `--help` for the full list.

## Options

| Flag | Required | Description |
|---|---|---|
| `--treatise <slug>` | yes | Key used on the site's `texts` object, e.g. `complexus`. Must be a valid bare JS property name (letters/digits/underscore, not starting with a digit). |
| `--edited <path>` | yes | Path to the Latin/critical-edition `.txt` file. |
| `--translation <path>` | yes | Path to the translation `.txt` file. |
| `--lang <code>` | no | Translation language key (default `english`). |
| `--out <path>` | no | Where to write `combined.js` (default: same folder as `--edited`, file `combined.js`). |
| `--date "YYYY-MM-DD[ HH:MM]"` | no | Export timestamp to record (default: now). |
| `--help` | no | Print usage and exit. |

## What it does

- **New file**: writes `texts.<treatise> = {}`, the export-date fields, an empty
  `sources = []`, `edited`, and `translation.<lang>`.
- **Existing file at `--out`**: backs it up to `<out>.bak`, then rewrites the
  export-date fields, `edited`, and `translation.<lang>` from the given `.txt` files.
  `sources` is carried over unchanged, and anything else already in the file (other
  translations, per-witness transcriptions, commentary, ...) is preserved verbatim.
- Text content is escaped and re-wrapped into the site's multi-line string format
  (`'line one\n\` continued across source lines) automatically — you don't need to
  hand-edit escaping or line breaks in the `.txt` files.

## Notes

- A trailing newline at the end of a `.txt` file (normal editor behaviour) is
  trimmed automatically; it isn't embedded as an extra blank line.
- The script only touches the `combined.js` you point `--out` at — it never updates
  `previous.js`. If you want the previous edition/translation preserved as a dated
  snapshot for the site's "view as of an earlier date" feature, archive it into
  `previous.js` by hand before running this script (see an existing `previous.js` for
  the expected `allTexts.<treatise>.edited[<unix-timestamp>] = '...'` format).
- Requires no dependencies beyond Node's built-ins (`fs`, `path`, `readline`).
