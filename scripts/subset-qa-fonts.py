#!/usr/bin/env python3
"""Regenerate the offline, QA-only Noto CJK SC fonts (requires fontTools)."""
import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTCollection, TTFont

ROOT = Path(__file__).resolve().parent.parent
FACES = [(kind, weight) for kind in ("Sans", "Serif") for weight in ("Regular", "Bold")]


def cjk(code):
    return any(first <= code <= last for first, last in (
        (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x2FA1F)))


def names(font):
    return {(item.nameID, item.platformID, item.platEncID, item.langID, item.toUnicode())
            for item in font["name"].names}


def validate(filename, requested, family, original_names=None, expected=None):
    with TTFont(filename) as font:
        cmap = set(font.getBestCmap())
        required = expected if expected is not None else {code for code in requested if cjk(code) or 32 <= code < 127}
        missing = required - cmap
        if missing:
            raise ValueError(f"{filename.name}: missing " + ", ".join(f"U+{code:04X}" for code in sorted(missing)))
        if font["name"].getDebugName(1) != family:
            raise ValueError(f"{filename.name}: family changed")
        if original_names is not None and not original_names.issubset(names(font)):
            raise ValueError(f"{filename.name}: original name/license metadata was lost")
        for name_id in (0, 13, 14):
            if not font["name"].getDebugName(name_id):
                raise ValueError(f"{filename.name}: missing copyright/license name {name_id}")
        print(f"{filename.name}: {len(cmap)} characters, {filename.stat().st_size:,} bytes, "
              f"SHA256 {hashlib.sha256(filename.read_bytes()).hexdigest()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path("/usr/share/fonts/opentype/noto"))
    parser.add_argument("--license-source", type=Path, default=Path("/usr/share/doc/fonts-noto-cjk/copyright"))
    parser.add_argument("--check", action="store_true", help="Check committed fonts against current index.html without regenerating")
    args = parser.parse_args()
    requested = set(map(ord, (ROOT / "index.html").read_text(encoding="utf-8"))) | set(range(32, 127))
    destination = ROOT / "scripts" / "qa-fonts"
    destination.mkdir(parents=True, exist_ok=True)
    copyrights = set()
    for kind, weight in FACES:
        family = f"Noto {kind} CJK SC"
        filename = destination / f"Noto{kind}CJKsc-QA-{weight}.otf"
        if args.check:
            validate(filename, requested, family)
            continue
        collection = TTCollection(args.source_dir / f"Noto{kind}CJK-{weight}.ttc", lazy=True)
        try:
            font = next(font for font in collection.fonts if font["name"].getDebugName(1) == family)
            original_names = names(font)
            copyrights.add(font["name"].getDebugName(0))
            available = set(font.getBestCmap())
            if any(cjk(code) for code in requested - available):
                raise ValueError(f"Source font {family} cannot cover every source CJK character")
            options = subset.Options()
            options.name_IDs = ["*"]
            options.name_languages = ["*"]
            options.name_legacy = True
            # The selected SC face already maps Chinese characters to SC forms.
            # This UI uses horizontal text; other-region and vertical alternates
            # need not inflate the small QA-only fonts.
            options.layout_features = ["ccmp", "liga", "kern", "mark", "mkmk"]
            options.recalc_timestamp = False
            font.recalcTimestamp = False
            builder = subset.Subsetter(options=options)
            builder.populate(unicodes=sorted(requested & available))
            builder.subset(font)
            font.save(filename)
            validate(filename, requested, family, original_names, requested & available)
        finally:
            collection.close()
    if not args.check:
        package_license = args.license_source.read_text(encoding="utf-8")
        ofl = package_license.split("\nLicense: SIL-1.1\n ", 1)[1].split("\nLicense: GPL-3+", 1)[0]
        lines = [line[1:] if line.startswith(" ") else line for line in ofl.splitlines()]
        license_text = "\n".join("" if line == "." else line for line in lines).strip()
        (destination / "OFL.txt").write_text("\n".join(sorted(copyrights)) + "\n\n" + license_text + "\n", encoding="utf-8")
    print(f"All {sum(cjk(code) for code in requested)} source CJK characters and ASCII are covered.")


if __name__ == "__main__":
    main()
