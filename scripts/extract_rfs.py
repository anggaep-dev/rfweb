#!/usr/bin/env python3
"""
Extracts loose files (.msh/.ani/.RFT->.dds/...) out of RF Online's .RFS
archives, for uploading to a CDN instead of shipping/fetching whole packed
archives at runtime.

Binary layout and every archive-name list here is a direct port of the
already-verified parsing logic in this repo - not a re-derivation:
  - RFS layout:            src/rf/rfs.ts
  - fixed-string decoding: src/rf/BinaryReader.ts (fixedString)
  - .RFT XOR "unlock_dds": src/rf/texture.ts (RFT_PASSWORD_BYTES/decodeRft)
  - archive-name lists:    src/rf/character.ts (RACE_CONFIGS, armorArchiveNames,
                            CLOAK_MESH_ARCHIVE_NAMES/CLOAK_TEX_ARCHIVE_NAMES).
                            The weapon lists (WEAPON_MESH_ARCHIVE_NAMES /
                            WEAPON_TEX_ARCHIVE_NAMES) used to live there too,
                            but the runtime no longer needs them - once
                            weapons were extracted here and put on a CDN,
                            character.ts fetches by stem directly instead of
                            searching archives (see loadParsedWeaponMesh).
                            The copies below are this script's own now.
See docs/rf-format-notes.md for the full reverse-engineering writeup this
was built from, including the known name-collision cases handled below.

Usage:
  # Pilot: flatten every weapon mesh/tex archive into one CDN-ready folder,
  # skipping duplicate/shadowed names exactly the way the live app used to
  # resolve them back when it searched archives directly (see above).
  python scripts/extract_rfs.py weapons \\
      --assets-root public/game-assets --out dist/cdn-assets

  # Same idea, per race: flattens each race's DEFAULT{code} + 15 armor-tier
  # archives (R/W/F x 00/10/20/30/40) into character/<code>/{mesh,tex}.
  python scripts/extract_rfs.py bodyarmor \\
      --assets-root public/game-assets --out dist/cdn-assets

  # Same idea again, for the small race-agnostic cloak archive set.
  python scripts/extract_rfs.py cloak \\
      --assets-root public/game-assets --out dist/cdn-assets

  # Animations: every character/player/Ani/*.RFS archive extracted into its
  # own subfolder (never flattened together - see ANI_BASE's doc comment).
  python scripts/extract_rfs.py animations \\
      --assets-root public/game-assets --out dist/cdn-assets

  # Generic/safe extraction of one archive on its own, into its own output
  # folder (what the category-specific commands above use internally).
  python scripts/extract_rfs.py archive public/game-assets/character/player/Ani/ACCOA.RFS \\
      --out dist/cdn-assets/character/ani/ACCOA --ext ani

  # Inspect one archive's table without extracting anything.
  python scripts/extract_rfs.py list public/game-assets/item/Weapon/Mesh/WEM00.RFS
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

RECORD_SIZE = 64
NAME_SIZE = 32
# 5x u32 + 2x u16 of reserved fields between the name and the trailing
# offset/size pair - unknown purpose, constant layout (see rfs.ts).
RESERVED_SIZE = RECORD_SIZE - NAME_SIZE - 4 - 4
RECORD_STRUCT = struct.Struct(f"<{NAME_SIZE}s{RESERVED_SIZE}sII")

# Same XOR "unlock_dds" password used for .r3t material atlases -
# src/rf/texture.ts's RFT_PASSWORD_BYTES, byte-for-byte.
RFT_PASSWORD_BYTES = bytes([
    0x2e, 0x80, 0x4d, 0x76, 0x2e, 0xf8, 0xd1, 0xf0, 0xbd, 0x3f, 0x86, 0x81, 0x58, 0x2c, 0x3f, 0x3f, 0x2e, 0x2e, 0x67,
    0x6f, 0x3f, 0x40, 0x3f, 0x78, 0x3c, 0x3f, 0xf1, 0xc0, 0xa5, 0xf6, 0x3b, 0x9f, 0xc1, 0x20, 0x3f, 0xd7, 0xc8, 0xc1,
    0xe9, 0x85, 0x86, 0xbd, 0xef, 0x56, 0x3f, 0xa1, 0xfb, 0x2e, 0x87, 0x86, 0x61, 0x4c, 0x21, 0x3b, 0x4e, 0xb4, 0x78,
    0x57, 0xae, 0x97, 0x3f, 0x2e, 0x4a, 0x2e, 0x3f, 0x4c, 0x2e, 0x44, 0xcd, 0xc5, 0x5f, 0xe8, 0xe9, 0xec, 0xeb, 0xbd,
    0xbe, 0xbb, 0xf7, 0x6c, 0x2e, 0xf2, 0xe4, 0x2e, 0x3f, 0x3f, 0x97, 0x9f, 0x9d, 0xb3, 0x21, 0xb9, 0x76, 0x65, 0x54,
    0x3f, 0xe6, 0xf6, 0xc6, 0xf0, 0x79, 0xdb, 0xe2, 0xb2, 0x4b, 0x2e, 0x2e, 0xeb, 0xd3, 0xd3, 0xca, 0xab, 0xea, 0xc7,
    0xed, 0x9c, 0xc7, 0xd9, 0xd0, 0x65, 0x48, 0xb4, 0xfa, 0x35, 0x2e, 0x2e, 0x6a, 0x9b,
])
DDS_MAGIC = b"DDS "

# These used to live in src/rf/character.ts as WEAPON_MESH_ARCHIVE_NAMES /
# WEAPON_TEX_ARCHIVE_NAMES, searched in this exact order at runtime by a
# since-removed findInNamedArchives (see the module docstring above) -
# order still matters here: flattening in this order and keeping the first
# archive to claim a given name reproduces the resolution the live app used
# to perform when it searched archives directly (see the ORI70 vs ori6770
# case in docs/rf-format-notes.md: ORI70 was checked first, so its copies
# of the 7 names both archives share are the ones that were actually
# reachable before the CDN switch).
WEAPON_MESH_BASE = "item/Weapon/Mesh"
WEAPON_MESH_ARCHIVE_NAMES = [
    "WEM00", "WEM01", "WEM02", "WEM03", "WEM04", "WEM05", "WEM06", "WEM07", "WEM08", "WEM09", "WEM10", "WEM11", "WEM12",
    "WEVM00", "GEM00", "NEM00", "ELFWPM01", "PVPWP", "ORI70", "ORI70SIEG", "SIEGEORISS", "75siegeMesh", "ori6770w",
]
WEAPON_TEX_BASE = "item/Weapon/Tex"
WEAPON_TEX_ARCHIVE_NAMES = [
    "WET00", "WET01", "WET02", "WET03", "WET04", "WET05", "WET06", "WET07", "WET08", "WET09", "WET10", "WET11", "WET12", "WET13",
    "WEVT00", "GET00", "NET55", "ELFWPT01", "PVPWP", "ORI70", "ORI70SIEG", "SIEGEORISS", "ori6770",
]


# Race body/armor archives (character/player/{Mesh,Tex}/...) - same
# first-match-wins search order CharacterController.equipItem uses today:
# [DEFAULT{code}, ...armorArchiveNames(code)] from src/rf/character.ts
# (armorArchiveNames itself: R00..R40, then W00..W40, then F00..F40). Each
# race's archives are self-contained (stems embed the race's own nameToken,
# e.g. "BELFEMALE_ARMOR_..."), so - unlike the weapons pilot - these are
# flattened per-race rather than into one shared namespace.
BODY_MESH_BASE = "character/player/Mesh"
BODY_TEX_BASE = "character/player/Tex"
RACE_BODY_CODES = ["AA", "BF", "BM", "CF", "CM"]  # Accretia, Bell F/M, Cora F/M
ARMOR_CATEGORIES = ["R", "W", "F"]
ARMOR_TIERS = ["00", "10", "20", "30", "40"]


def body_archive_names(code: str) -> list[str]:
    names = [f"DEFAULT{code}"]
    for category in ARMOR_CATEGORIES:
        for tier in ARMOR_TIERS:
            names.append(f"{code}{category}{tier}")
    return names


# Cloak meshes/textures live in this small, fixed, race-agnostic archive set
# under item/Armor/ (not the per-race body archives above - real cloak
# meshes were confirmed absent from every character/player/Mesh archive).
# Same first-match-wins order loadCloakArchives uses in src/rf/character.ts.
CLOAK_MESH_BASE = "item/Armor/Mesh"
CLOAK_MESH_ARCHIVE_NAMES = ["AKM00", "NewCloakM", "PHBP01", "XMC"]
CLOAK_TEX_BASE = "item/Armor/Tex"
CLOAK_TEX_ARCHIVE_NAMES = ["AKT00", "NewCloakT"]

# Cloaks also carry their own small per-item skeleton (Bone) and dedicated
# animation set (Ani: ATTACK/DEFAULT/EQUIP/UNEQUIP/USE/UNUSE per item, e.g.
# sway/attack/equip-transition poses) - confirmed unreferenced anywhere in
# src/, so this is genuinely unimplemented in the app today (cloaks
# currently render as a static mesh skinned to the main body skeleton),
# not just unextracted. Extracting it now anyway so the CDN side is ready
# whenever that feature gets built.
#
# Both directories ship mostly as already-loose files (no archive at all
# for Bone; Ani has loose files plus two archives) - confirmed by direct
# comparison: every one of ACA00.RFS's 60 entries is byte-identical to a
# same-named loose .ANI file already sitting next to it (fully redundant,
# skip it), while NewCloakA.RFS's 2 entries (COM_ARMOR_CLOAK_255_RUN/STAND,
# the generic fallback rig's clips) have no loose counterpart at all and
# do need real extraction.
CLOAK_BONE_BASE = "item/Armor/Bone"
CLOAK_ANI_BASE = "item/Armor/Ani"
CLOAK_ANI_EXTRA_ARCHIVE = "NewCloakA"  # the one non-redundant archive; ACA00 is skipped entirely


def copy_loose_files(src_dir: Path, out_dir: Path, pattern: str) -> list[dict]:
    """For directories that ship as already-extracted loose files (no RFS
    archive involved at all) - just copies them through with the same
    manifest shape extract_flattened produces, so callers can treat both
    uniformly."""
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []
    for src_path in sorted(src_dir.glob(pattern)):
        data = src_path.read_bytes()
        out_path = out_dir / src_path.name
        out_path.write_bytes(data)
        manifest.append({
            "name": src_path.name,
            "sourceArchive": str(src_path),
            "outputPath": str(out_path),
            "size": len(data),
            "sha256": sha256_hex(data),
        })
    return manifest

# Animation archives (character/player/Ani/{race}{SUFFIX}.RFS) are the one
# category that must NOT be flattened across archives - see
# docs/rf-format-notes.md: ~89% of real .ani names fill the full 32-byte
# name slot with no extension even visible, so "unique name" only ever
# holds within the single archive it came from, exactly like
# findRfsEntry's own truncated-name comparison already assumes at runtime.
# Every real archive under this directory is processed (top-level only -
# the sibling "#edited" folder holds an alternate/dev copy the live app
# never fetches), rather than hardcoding every race+suffix combination.
ANI_BASE = "character/player/Ani"


@dataclass(frozen=True)
class RfsEntry:
    name: str
    offset: int
    size: int


def parse_rfs_header(path: Path) -> list[RfsEntry]:
    """Reads only the index table (not the payload) - mirrors parseRfs in
    src/rf/rfs.ts, including its own sanity checks against a truncated or
    non-archive (e.g. dev-server HTML fallback) file."""
    file_size = path.stat().st_size
    with path.open("rb") as f:
        (entry_count,) = struct.unpack("<I", f.read(4))
        expected_index_bytes = 4 + entry_count * RECORD_SIZE
        if entry_count < 0 or expected_index_bytes > file_size:
            raise ValueError(
                f"{path}: RFS header looks invalid (entryCount={entry_count} would need "
                f"{expected_index_bytes} bytes just for the index, but the file is only "
                f"{file_size} bytes)"
            )

        table = f.read(entry_count * RECORD_SIZE)

    entries: list[RfsEntry] = []
    max_end = 0
    for i in range(entry_count):
        raw_name, _reserved, offset, size = RECORD_STRUCT.unpack_from(table, i * RECORD_SIZE)
        nul = raw_name.find(b"\x00")
        name = (raw_name if nul < 0 else raw_name[:nul]).decode("ascii", errors="replace")
        entries.append(RfsEntry(name=name, offset=offset, size=size))
        max_end = max(max_end, offset + size)

    if file_size < max_end:
        raise ValueError(
            f"{path}: RFS archive looks truncated - its own index expects data up to byte "
            f"{max_end}, but the file is only {file_size} bytes"
        )

    return entries


def read_entry_bytes(path: Path, entry: RfsEntry) -> bytes:
    """Streams just the one entry's byte range off disk - never loads the
    whole (possibly 10s of MB) archive into memory to pull out one file."""
    with path.open("rb") as f:
        f.seek(entry.offset)
        data = f.read(entry.size)
    if len(data) != entry.size:
        raise ValueError(f"{path}: short read for entry {entry.name!r} (expected {entry.size}, got {len(data)})")
    return data


def decode_rft_to_dds(data: bytes) -> bytes:
    """Same XOR-unlock as src/rf/texture.ts's decodeRft: only the first 128
    header bytes are ever encrypted, and only if the DDS magic isn't
    already readable at offset 0 (some .RFT files are already plain DDS)."""
    if data[:4] == DDS_MAGIC:
        return data
    header = bytearray(data[:128])
    for i in range(128):
        header[i] ^= RFT_PASSWORD_BYTES[i]
    return bytes(header) + data[128:]


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# Flattened extraction with explicit archive-priority collision handling.
# Used both for flattening several archives into one shared namespace
# (weapons, armor, cloak - real names never collide there) and for a single
# archive on its own (animations - see docs/rf-format-notes.md on why .ani
# names truncate to 32 bytes and must stay archive-scoped, never flattened
# *across* archives; a length-1 priority list here still gets the same
# intra-archive first-match-wins handling real dupes need).
# --------------------------------------------------------------------------

def force_extension(name: str, expected_ext: str) -> str:
    """Every entry in a Weapon/Mesh archive is a .msh and every entry in a
    Weapon/Tex archive is a .RFT - always, regardless of what the stored
    32-byte name field looks like. That field truncates long real filenames
    (confirmed: 57 of 349 weapon mesh entries and 37 of 297 weapon tex
    entries lose their real extension this way, e.g.
    "ACCRETIA_WEAPON_MININGTOOL_002.msh" -> stored as "...002.m", or
    "ACCRETIA_WEAPON_TFLAMETHROWER_130.RFT" -> stored with no dot at all).
    The live app never notices because it only ever compares two names
    truncated the same way - it never filters entries by extension. This
    extractor has to actively repair that, or it silently drops every
    truncated entry instead of writing it under a usable filename."""
    if name.lower().endswith(expected_ext):
        return name
    head, dot, tail = name.rpartition(".")
    if dot and 0 < len(tail) <= 4 and tail.isalnum():
        # Looks like a truncated remnant of the real extension - drop it
        # rather than end up with "NAME.m.msh".
        name = head
    return name + expected_ext


def extract_flattened(
    archive_paths_in_priority_order: list[Path],
    out_dir: Path,
    expected_ext: str | None,
) -> tuple[list[dict], list[dict]]:
    """Extracts every entry (no extension filtering - see force_extension
    for why that would silently lose real files) from each archive in
    priority order, keeping the first archive to claim a given raw stored
    name and logging any later, differently-sized claim as a collision
    instead of silently overwriting it. This reproduces findInNamedArchives'
    own first-match-wins search order byte for byte - including within a
    single archive, when called with a length-1 priority list.

    expected_ext forces every entry's output name to that extension (use
    this whenever the source directory is known to be homogeneous - every
    Weapon/Mesh entry is a .msh, every Ani entry is a .ani, etc. - see
    force_extension for why that's necessary, not cosmetic). Pass None for
    a genuinely mixed/unknown archive: names are used as stored, with a
    best-effort .RFT->.dds decode only when the name happens to already end
    in .rft."""
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []
    collisions: list[dict] = []
    claimed: dict[str, dict] = {}  # upper(name) -> manifest entry that won it

    for archive_path in archive_paths_in_priority_order:
        if not archive_path.exists():
            print(f"  (skip, not found) {archive_path}", file=sys.stderr)
            continue
        entries = parse_rfs_header(archive_path)
        for entry in entries:
            key = entry.name.upper()
            data = read_entry_bytes(archive_path, entry)
            if expected_ext is not None:
                out_name = force_extension(entry.name, expected_ext)
                is_rft = expected_ext == ".rft"
            else:
                out_name = entry.name
                is_rft = out_name.lower().endswith(".rft")
            if is_rft:
                data = decode_rft_to_dds(data)
                out_name = str(Path(out_name).with_suffix(".dds"))
            digest = sha256_hex(data)

            if key in claimed:
                winner = claimed[key]
                if winner["size"] != len(data) or winner["sha256"] != digest:
                    collisions.append({
                        "name": entry.name,
                        "keptArchive": winner["sourceArchive"],
                        "shadowedArchive": str(archive_path),
                        "keptSize": winner["size"],
                        "shadowedSize": len(data),
                    })
                continue  # first archive in priority order always wins, matches findInNamedArchives

            out_path = out_dir / out_name
            out_path.write_bytes(data)
            record = {
                "name": entry.name,
                "sourceArchive": str(archive_path),
                "outputPath": str(out_path),
                "size": len(data),
                "sha256": digest,
            }
            claimed[key] = record
            manifest.append(record)

    return manifest, collisions


def cmd_weapons(args: argparse.Namespace) -> None:
    assets_root = Path(args.assets_root)
    out_root = Path(args.out)

    mesh_archives = [assets_root / WEAPON_MESH_BASE / f"{name}.RFS" for name in WEAPON_MESH_ARCHIVE_NAMES]
    tex_archives = [assets_root / WEAPON_TEX_BASE / f"{name}.RFS" for name in WEAPON_TEX_ARCHIVE_NAMES]

    print(f"Extracting weapon meshes from {len(mesh_archives)} archives (priority order)...")
    mesh_manifest, mesh_collisions = extract_flattened(mesh_archives, out_root / "weapons" / "mesh", ".msh")
    print(f"  -> {len(mesh_manifest)} unique .msh files, {len(mesh_collisions)} shadowed-name conflicts")

    print(f"Extracting weapon textures from {len(tex_archives)} archives (priority order)...")
    tex_manifest, tex_collisions = extract_flattened(tex_archives, out_root / "weapons" / "tex", ".rft")
    print(f"  -> {len(tex_manifest)} unique textures (.RFT decoded to .dds), {len(tex_collisions)} shadowed-name conflicts")

    all_collisions = mesh_collisions + tex_collisions
    if all_collisions:
        print(f"\n{len(all_collisions)} name(s) existed in more than one archive with DIFFERENT content:")
        for c in all_collisions:
            print(f"  {c['name']}: kept {c['keptArchive']} (size={c['keptSize']}), "
                  f"shadowed {c['shadowedArchive']} (size={c['shadowedSize']})")
        print("The shadowed copy was NOT written - this matches the live app's own archive search order.")

    manifest_path = out_root / "weapons" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps({
        "mesh": mesh_manifest,
        "tex": tex_manifest,
        "collisions": all_collisions,
    }, indent=2))
    print(f"\nWrote manifest: {manifest_path}")


def cmd_bodyarmor(args: argparse.Namespace) -> None:
    assets_root = Path(args.assets_root)
    out_root = Path(args.out)

    total_mesh = total_tex = total_collisions = 0
    per_race_manifest: dict[str, dict] = {}

    for code in RACE_BODY_CODES:
        names = body_archive_names(code)
        mesh_archives = [assets_root / BODY_MESH_BASE / f"{name}.RFS" for name in names]
        tex_archives = [assets_root / BODY_TEX_BASE / f"{name}.RFS" for name in names]

        print(f"[{code}] Extracting body/armor meshes from {len(mesh_archives)} archives (priority order)...")
        mesh_manifest, mesh_collisions = extract_flattened(mesh_archives, out_root / "character" / code / "mesh", ".msh")
        print(f"  -> {len(mesh_manifest)} unique .msh files, {len(mesh_collisions)} shadowed-name conflicts")

        print(f"[{code}] Extracting body/armor textures from {len(tex_archives)} archives (priority order)...")
        tex_manifest, tex_collisions = extract_flattened(tex_archives, out_root / "character" / code / "tex", ".rft")
        print(f"  -> {len(tex_manifest)} unique textures (.RFT decoded to .dds), {len(tex_collisions)} shadowed-name conflicts")

        collisions = mesh_collisions + tex_collisions
        if collisions:
            print(f"\n[{code}] {len(collisions)} name(s) existed in more than one archive with DIFFERENT content:")
            for c in collisions:
                print(f"  {c['name']}: kept {c['keptArchive']} (size={c['keptSize']}), "
                      f"shadowed {c['shadowedArchive']} (size={c['shadowedSize']})")
            print("The shadowed copy was NOT written - this matches the live app's own archive search order.")

        per_race_manifest[code] = {"mesh": mesh_manifest, "tex": tex_manifest, "collisions": collisions}
        total_mesh += len(mesh_manifest)
        total_tex += len(tex_manifest)
        total_collisions += len(collisions)

    manifest_path = out_root / "character" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(per_race_manifest, indent=2))
    print(f"\nTotal: {total_mesh} mesh files, {total_tex} textures, {total_collisions} collisions across {len(RACE_BODY_CODES)} races")
    print(f"Wrote manifest: {manifest_path}")


def cmd_cloak(args: argparse.Namespace) -> None:
    assets_root = Path(args.assets_root)
    out_root = Path(args.out)

    mesh_archives = [assets_root / CLOAK_MESH_BASE / f"{name}.RFS" for name in CLOAK_MESH_ARCHIVE_NAMES]
    tex_archives = [assets_root / CLOAK_TEX_BASE / f"{name}.RFS" for name in CLOAK_TEX_ARCHIVE_NAMES]

    print(f"Extracting cloak meshes from {len(mesh_archives)} archives (priority order)...")
    mesh_manifest, mesh_collisions = extract_flattened(mesh_archives, out_root / "cloak" / "mesh", ".msh")
    print(f"  -> {len(mesh_manifest)} unique .msh files, {len(mesh_collisions)} shadowed-name conflicts")

    print(f"Extracting cloak textures from {len(tex_archives)} archives (priority order)...")
    tex_manifest, tex_collisions = extract_flattened(tex_archives, out_root / "cloak" / "tex", ".rft")
    print(f"  -> {len(tex_manifest)} unique textures (.RFT decoded to .dds), {len(tex_collisions)} shadowed-name conflicts")

    all_collisions = mesh_collisions + tex_collisions
    if all_collisions:
        print(f"\n{len(all_collisions)} name(s) existed in more than one archive with DIFFERENT content:")
        for c in all_collisions:
            print(f"  {c['name']}: kept {c['keptArchive']} (size={c['keptSize']}), "
                  f"shadowed {c['shadowedArchive']} (size={c['shadowedSize']})")

    # Bone/Ani - not wired into the app yet (see CLOAK_BONE_BASE's doc
    # comment), extracted anyway so the CDN side is ready ahead of that
    # feature. Bone ships as loose files only; Ani is loose files plus one
    # genuinely non-redundant archive (ACA00.RFS is a fully redundant
    # duplicate of the loose files, verified byte-for-byte, so it's skipped).
    print(f"\nCopying cloak bones from {assets_root / CLOAK_BONE_BASE}...")
    bone_manifest = copy_loose_files(assets_root / CLOAK_BONE_BASE, out_root / "cloak" / "bone", "*.bn")
    print(f"  -> {len(bone_manifest)} .bn files")

    print(f"Copying loose cloak animations from {assets_root / CLOAK_ANI_BASE}...")
    ani_manifest = copy_loose_files(assets_root / CLOAK_ANI_BASE, out_root / "cloak" / "ani", "*.ANI")
    extra_ani_archive = assets_root / CLOAK_ANI_BASE / f"{CLOAK_ANI_EXTRA_ARCHIVE}.RFS"
    extra_manifest, extra_collisions = extract_flattened([extra_ani_archive], out_root / "cloak" / "ani", ".ani")
    ani_manifest += extra_manifest
    print(f"  -> {len(ani_manifest)} .ani files ({len(extra_manifest)} from {CLOAK_ANI_EXTRA_ARCHIVE}.RFS, the rest already loose)")

    manifest_path = out_root / "cloak" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps({
        "mesh": mesh_manifest,
        "tex": tex_manifest,
        "bone": bone_manifest,
        "ani": ani_manifest,
        "collisions": all_collisions + extra_collisions,
    }, indent=2))
    print(f"\nWrote manifest: {manifest_path}")


def cmd_animations(args: argparse.Namespace) -> None:
    assets_root = Path(args.assets_root)
    out_root = Path(args.out)
    ani_dir = assets_root / ANI_BASE

    # Top-level only (Path.glob, not rglob) - deliberately skips the
    # "#edited" subfolder, matching what loadRaceAssets/getWeaponClip
    # actually fetch (character/player/Ani/{code}{SUFFIX}.RFS, never the
    # #edited variant).
    archive_paths = sorted(ani_dir.glob("*.RFS"))
    print(f"Found {len(archive_paths)} animation archives under {ani_dir}")

    combined_manifest: dict[str, dict] = {}
    total_entries = total_collisions = 0

    for archive_path in archive_paths:
        # Each archive gets its own output folder and its own first-wins
        # pass (length-1 priority list) - names are NOT flattened across
        # archives, see ANI_BASE's doc comment above.
        manifest, collisions = extract_flattened([archive_path], out_root / "character" / "ani" / archive_path.stem, ".ani")
        combined_manifest[archive_path.stem] = {"entries": manifest, "collisions": collisions}
        total_entries += len(manifest)
        total_collisions += len(collisions)
        if collisions:
            print(f"[{archive_path.stem}] {len(collisions)} name(s) repeated within this archive with DIFFERENT content:")
            for c in collisions:
                print(f"  {c['name']}: kept size={c['keptSize']}, shadowed size={c['shadowedSize']}")

    manifest_path = out_root / "character" / "ani" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(combined_manifest, indent=2))
    print(f"\nTotal: {total_entries} clips across {len(archive_paths)} archives, {total_collisions} intra-archive collisions")
    print(f"Wrote manifest: {manifest_path}")


def cmd_archive(args: argparse.Namespace) -> None:
    archive_path = Path(args.archive)
    out_dir = Path(args.out)
    expected_ext = None
    if args.ext:
        expected_ext = args.ext.lower() if args.ext.startswith(".") else f".{args.ext.lower()}"

    manifest, collisions = extract_flattened([archive_path], out_dir, expected_ext)
    print(f"Extracted {len(manifest)} entries from {archive_path} -> {out_dir}")
    if collisions:
        print(f"{len(collisions)} name(s) repeated within this archive with DIFFERENT content (kept the first, table order):")
        for c in collisions:
            print(f"  {c['name']}: kept size={c['keptSize']}, shadowed size={c['shadowedSize']}")

    manifest_path = out_dir / f"{archive_path.stem}.manifest.json"
    manifest_path.write_text(json.dumps({"entries": manifest, "collisions": collisions}, indent=2))
    print(f"Wrote manifest: {manifest_path}")


def cmd_list(args: argparse.Namespace) -> None:
    archive_path = Path(args.archive)
    entries = parse_rfs_header(archive_path)
    print(f"{archive_path}: {len(entries)} entries")
    for entry in entries:
        print(f"  {entry.name:<40} offset={entry.offset:<10} size={entry.size}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_weapons = sub.add_parser("weapons", help="Flatten every weapon mesh/tex archive into a CDN-ready folder")
    p_weapons.add_argument("--assets-root", default="public/game-assets", help="Root of the game-assets tree")
    p_weapons.add_argument("--out", required=True, help="Output directory (gets weapons/mesh, weapons/tex, manifest.json)")
    p_weapons.set_defaults(func=cmd_weapons)

    p_bodyarmor = sub.add_parser("bodyarmor", help="Flatten every race's default body + armor-tier mesh/tex archives into per-race CDN-ready folders")
    p_bodyarmor.add_argument("--assets-root", default="public/game-assets", help="Root of the game-assets tree")
    p_bodyarmor.add_argument("--out", required=True, help="Output directory (gets character/<code>/mesh, character/<code>/tex, character/manifest.json)")
    p_bodyarmor.set_defaults(func=cmd_bodyarmor)

    p_cloak = sub.add_parser("cloak", help="Flatten the cloak mesh/tex archives into a CDN-ready folder")
    p_cloak.add_argument("--assets-root", default="public/game-assets", help="Root of the game-assets tree")
    p_cloak.add_argument("--out", required=True, help="Output directory (gets cloak/mesh, cloak/tex, manifest.json)")
    p_cloak.set_defaults(func=cmd_cloak)

    p_animations = sub.add_parser("animations", help="Extract every character/player/Ani archive into its own archive-scoped folder (never flattened across archives)")
    p_animations.add_argument("--assets-root", default="public/game-assets", help="Root of the game-assets tree")
    p_animations.add_argument("--out", required=True, help="Output directory (gets character/ani/<archive-stem>/*.ani, manifest.json)")
    p_animations.set_defaults(func=cmd_animations)

    p_archive = sub.add_parser("archive", help="Extract one archive's entries into its own output folder")
    p_archive.add_argument("archive", help="Path to a single .RFS file")
    p_archive.add_argument("--out", required=True, help="Output directory for this archive's entries")
    p_archive.add_argument("--ext", help="Force this extension on every entry (e.g. --ext ani) - use when the archive is known to be homogeneous, same reasoning as force_extension. Default: use names as stored.")
    p_archive.set_defaults(func=cmd_archive)

    p_list = sub.add_parser("list", help="Print one archive's entry table without extracting anything")
    p_list.add_argument("archive", help="Path to a single .RFS file")
    p_list.set_defaults(func=cmd_list)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
