# Offline Chinese fonts for browser QA

These four OpenType subsets provide Noto Sans CJK SC and Noto Serif CJK SC,
in Regular and Bold, to the screenshot workflow without a network download.
They are test assets: the production page does not load them as web fonts.

The source is the `fonts-noto-cjk` package installed under
`/usr/share/fonts/opentype/noto`, from the upstream
[Noto CJK project](https://github.com/notofonts/noto-cjk). The fonts are licensed
under the SIL Open Font License 1.1; the original copyright notices and complete
license are included in `OFL.txt`. Original font names, copyright, license and
license URL metadata are retained. The `QA` filenames distinguish these subsets
from the complete upstream fonts.

Each subset includes every character occurring in `index.html` that its upstream
font supports, plus printable ASCII. All Chinese ideographs in the source must
be present. Unsupported emoji and control characters are intentionally left to
the browser's normal fallback. The selected Simplified Chinese faces retain
their SC glyphs; unused other-region and vertical substitutions are omitted.

## Regenerate after adding text

With Python and `fontTools` installed (generated with fontTools 4.61.1), run:

```sh
python scripts/subset-qa-fonts.py
python scripts/subset-qa-fonts.py --check
```

Regeneration reads the four Regular/Bold TTC source files and the package's
`/usr/share/doc/fonts-noto-cjk/copyright`. Alternate locations can be supplied
with `--source-dir` and `--license-source`. No download is performed. Commit the
regenerated OTF files and license together with new source text.

The script reopens every generated font, checks Unicode coverage, preserves all
original name records (including name IDs 0, 13 and 14), and prints sizes and
SHA-256 hashes. `--check` validates the committed subsets' Chinese/ASCII coverage
without requiring the upstream TTC files. CI also checks the actual fonts used
by Chrome, so an installed file alone is not considered a successful visual QA.
