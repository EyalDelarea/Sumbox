# Self-Hosted Fonts

These fonts are self-hosted for local-first / offline operation. They were
downloaded from Google Fonts (fonts.gstatic.com) and are served directly
without any third-party network requests.

## Fonts

### Frank Ruhl Libre
- Weights: 700, 900
- Subsets: hebrew, latin
- License: SIL Open Font License 1.1
- Files:
  - `frank-ruhl-libre-700-hebrew.woff2`
  - `frank-ruhl-libre-700-latin.woff2`
  - `frank-ruhl-libre-900-hebrew.woff2`
  - `frank-ruhl-libre-900-latin.woff2`

### Heebo
- Weights: 300, 400, 500, 700
- Subsets: hebrew, latin
- License: SIL Open Font License 1.1
- Files:
  - `heebo-300-hebrew.woff2`
  - `heebo-300-latin.woff2`
  - `heebo-400-hebrew.woff2`
  - `heebo-400-latin.woff2`
  - `heebo-500-hebrew.woff2`
  - `heebo-500-latin.woff2`
  - `heebo-700-hebrew.woff2`
  - `heebo-700-latin.woff2`

### IBM Plex Mono
- Weights: 400, 500
- Subsets: latin (IBM Plex Mono has no hebrew subset)
- License: SIL Open Font License 1.1
- Files:
  - `ibm-plex-mono-400-latin.woff2`
  - `ibm-plex-mono-500-latin.woff2`

## Notes

- All files are in woff2 format (Web Open Font Format Version 2), verified
  with magic bytes `wOF2`.
- The `@font-face` CSS declarations (with `unicode-range` for subsetting) are
  in `styles.css` — not in this directory.
- Google Fonts serves the hebrew and latin subsets of Heebo and Frank Ruhl
  Libre via the same woff2 file for each weight (the browser applies
  `unicode-range` to select the correct glyphs). The files here reflect the
  actual downloaded binaries.
