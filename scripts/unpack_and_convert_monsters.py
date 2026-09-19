#!/usr/bin/env python3
"""
End-to-end monster asset pipeline, driving the two other monster scripts
over a whole raw dump at once instead of one archive/one monster at a time:

  1. Unpacks every `.RFS` archive under <root>/Mesh, <root>/Tex, <root>/Ani
     in place (alongside whatever's already loose there) - reusing
     extract_rfs.py's own `extract_flattened` (imported, not reimplemented),
     one call per category across ALL of that category's archives together
     so a name that collides across two different archives is caught and
     logged instead of one silently overwriting the other - the same
     approach (and the same real risk - fixed 32-byte archive name slots
     truncate long real filenames, see extract_rfs.py's own
     force_extension) this project already accepts for weapons/armor/cloak.
     If the collision log below turns out non-empty for a monster you
     actually care about, re-extract just that one archive on its own with
     `extract_rfs.py archive ... --out <a different folder>` instead.
  2. Runs monster_to_gltf.py's convert_monster() for every stem that has a
     real `.bn` skeleton (Bone/*.bn is the census of "real" monsters in a
     dump like this - Mesh/Tex/Ani are checked per-stem and just skipped,
     not fatal, when missing), in-process rather than one `python` subprocess
     per monster (600+ of them here) to skip the repeated interpreter
     startup cost.

Usage:
    python scripts/unpack_and_convert_monsters.py \\
        --cdn-root "C:/Users/you/cdn_upload/Monster" --out build/gltf/monster
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_rfs  # noqa: E402
import monster_to_gltf as conv  # noqa: E402


def unpack_category_in_place(src_dir: Path, expected_ext: str) -> None:
    if not src_dir.is_dir():
        print(f"[SKIP] {src_dir} does not exist")
        return
    archives = sorted({p.resolve() for p in src_dir.iterdir() if p.is_file() and p.suffix.lower() == ".rfs"})
    if not archives:
        print(f"[{src_dir.name}] no .RFS archives to unpack ({sum(1 for _ in src_dir.iterdir())} loose files already present)")
        return
    print(f"[{src_dir.name}] unpacking {len(archives)} archive(s) in place...")
    manifest, collisions = extract_rfs.extract_flattened(archives, src_dir, expected_ext)
    print(f"  -> {len(manifest)} files extracted, {len(collisions)} name collision(s)")
    for c in collisions:
        print(f"  [COLLISION] {c['name']}: kept {Path(c['keptArchive']).name} (size={c['keptSize']}), shadowed {Path(c['shadowedArchive']).name} (size={c['shadowedSize']})")


def collect_monster_stems(bone_dir: Path) -> list[str]:
    stems: dict[str, str] = {}  # upper(stem) -> original-cased stem, first wins
    for p in sorted(bone_dir.iterdir()):
        if p.is_file() and p.suffix.lower() == ".bn":
            stems.setdefault(p.stem.upper(), p.stem)
    return [stems[k] for k in sorted(stems)]


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cdn-root", type=Path, required=True, help="Root containing Mesh/Tex/Ani/Bone subfolders")
    parser.add_argument("--out", type=Path, default=Path("build/gltf/monster"), help="Output directory for every <stem>.glb")
    parser.add_argument("--states", default=",".join(conv.DEFAULT_STATES), help="Comma-separated .ani state names to look for per monster")
    parser.add_argument("--skip-unpack", action="store_true", help="Skip step 1 (archives already unpacked) and go straight to conversion")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    mesh_dir = args.cdn_root / "Mesh"
    tex_dir = args.cdn_root / "Tex"
    ani_dir = args.cdn_root / "Ani"
    bone_dir = args.cdn_root / "Bone"
    states = [s.strip().upper() for s in args.states.split(",") if s.strip()]

    if not args.skip_unpack:
        print("=== Step 1: unpacking .RFS archives ===")
        unpack_category_in_place(mesh_dir, ".msh")
        unpack_category_in_place(tex_dir, ".rft")
        unpack_category_in_place(ani_dir, ".ani")
    else:
        print("=== Step 1: skipped (--skip-unpack) ===")

    print()
    print("=== Step 2: converting monsters ===")
    stems = collect_monster_stems(bone_dir)
    print(f"{len(stems)} monster skeleton(s) found in {bone_dir}")

    converted: list[str] = []
    skipped: list[tuple[str, str]] = []
    failed: list[tuple[str, str]] = []

    for stem in stems:
        out_path = args.out / f"{stem}.glb"
        try:
            conv.convert_monster(stem, mesh_dir, tex_dir, ani_dir, bone_dir, out_path, states)
            converted.append(stem)
        except conv.MonsterConversionError as exc:
            skipped.append((stem, str(exc)))
        except Exception as exc:  # noqa: BLE001 - one bad monster must not abort the whole batch
            failed.append((stem, f"{type(exc).__name__}: {exc}"))
            print(f"[FAIL] {stem}: {type(exc).__name__}: {exc}")

    print()
    print(f"Converted: {len(converted)}")
    print(f"Skipped (no mesh/bone/geometry): {len(skipped)}")
    print(f"Failed (parse/convert error): {len(failed)}")

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    manifest_path.write_text(json.dumps(sorted(converted), indent=2), encoding="utf-8")
    print(f"Manifest ({len(converted)} monster(s)) written to {manifest_path}")

    log_path = args.out / "monster_conversion.log"
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(f"Converted: {len(converted)}\n\n")
        f.write(f"Skipped ({len(skipped)}):\n")
        for stem, msg in skipped:
            f.write(f"  {stem}: {msg}\n")
        f.write(f"\nFailed ({len(failed)}):\n")
        for stem, msg in failed:
            f.write(f"  {stem}: {msg}\n")
    print(f"Full log written to {log_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
