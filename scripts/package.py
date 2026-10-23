"""Build the unpacked Chrome extension ZIP using only the Python standard library."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
ASSETS = (
    "background.js",
    "core.js",
    "manifest.json",
    "options.css",
    "options.html",
    "options.js",
)


def main():
    manifest = json.loads((ROOT / "extension/manifest.json").read_text())
    package = json.loads((ROOT / "package.json").read_text())
    if manifest["version"] != package["version"]:
        raise ValueError("Versionen in package.json und manifest.json stimmen nicht überein.")
    files = {name: ROOT / "extension" / name for name in ASSETS}
    files["README.md"] = ROOT / "README.md"
    contents = {name: path.read_bytes() for name, path in files.items()}
    output = ROOT / "dist/ichwillnixverpassen.zip"
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(contents.items()):
            # Stable timestamps and permissions keep the build reproducible.
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    print(f"Erstellt: {output.relative_to(ROOT)} (Version {manifest['version']})")


if __name__ == "__main__":
    main()
