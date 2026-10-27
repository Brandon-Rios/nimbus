#!/usr/bin/env python3
"""Safety check for an Office/zip file before unpacking it (stdlib only).

  python3 office_check.py <file> [--unpack DIR]

Refuses zip bombs (over 200 MB uncompressed or 10,000 parts), absolute or ../ paths, and symlink
entries; reports macros (vbaProject.bin, .docm/.xlsm/.pptm), which must never be run. With --unpack it
extracts the safe entries into DIR (symlinks are skipped). Exit code 0 = safe, 1 = refused.
"""
import json, os, stat, sys, zipfile

MAX_BYTES, MAX_PARTS = 200 * 1024 * 1024, 10_000

def check(path):
    report = {"file": path, "ok": True, "problems": [], "macros": False, "parts": 0, "uncompressed": 0}
    if path.lower().endswith((".docm", ".xlsm", ".pptm")):
        report["macros"] = True
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        report.update(ok=False, problems=["Not a zip-based Office file (legacy .doc/.xls/.ppt: convert with soffice first)"])
        return report, None
    infos = z.infolist()
    report["parts"] = len(infos)
    report["uncompressed"] = sum(i.file_size for i in infos)
    if len(infos) > MAX_PARTS:
        report["problems"].append(f"Too many parts ({len(infos)})")
    if report["uncompressed"] > MAX_BYTES:
        report["problems"].append(f"Too large when unpacked ({report['uncompressed'] // 1_000_000} MB)")
    for i in infos:
        name = i.filename
        if name.startswith(("/", "\\")) or ".." in name.replace("\\", "/").split("/"):
            report["problems"].append(f"Unsafe path: {name}")
        if stat.S_ISLNK(i.external_attr >> 16):
            report.setdefault("symlinks", []).append(name)
        if name.lower().endswith("vbaproject.bin"):
            report["macros"] = True
    report["ok"] = not report["problems"]
    return report, z

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    report, z = check(sys.argv[1])
    if report["ok"] and "--unpack" in sys.argv:
        dest = os.path.abspath(sys.argv[sys.argv.index("--unpack") + 1])
        skip = set(report.get("symlinks", []))
        for i in z.infolist():
            if i.filename in skip:
                continue
            target = os.path.abspath(os.path.join(dest, i.filename))
            if not target.startswith(dest + os.sep) and target != dest:
                continue
            if i.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(i) as src, open(target, "wb") as out:
                out.write(src.read())
        report["unpacked_to"] = dest
    print(json.dumps(report, indent=1))
    sys.exit(0 if report["ok"] else 1)

main()
