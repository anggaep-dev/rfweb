#!/usr/bin/env python3
"""
Validates `.glb` files produced by msh_to_gltf.py - structural sanity
checks (chunk framing, accessor bounds, index range, embedded-image
decodability) plus optional PNG extraction for visual spot-checking.
Doesn't need a real glTF viewer/three.js - just Python stdlib + Pillow.

Usage:
    python scripts/validate_gltf.py build/gltf/weapon
    python scripts/validate_gltf.py build/gltf/weapon/ACCRETIA_WEAPON_TAXE_112.glb --extract-textures out/preview
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

from PIL import Image


class ValidationError(Exception):
    pass


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    if len(data) < 12:
        raise ValidationError(f"file too short ({len(data)} bytes) to even hold a GLB header")

    magic, version, total_length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValidationError(f"bad magic {magic!r} (expected b'glTF')")
    if version != 2:
        raise ValidationError(f"unexpected glTF version {version} (expected 2)")
    if total_length != len(data):
        raise ValidationError(f"header declares length {total_length} but file is {len(data)} bytes")

    offset = 12
    json_chunk = None
    bin_chunk = b""
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<I4s", data, offset)
        offset += 8
        chunk_data = data[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == b"JSON":
            json_chunk = chunk_data
        elif chunk_type == b"BIN\x00":
            bin_chunk = chunk_data
        else:
            raise ValidationError(f"unknown chunk type {chunk_type!r}")

    if json_chunk is None:
        raise ValidationError("no JSON chunk found")

    gltf = json.loads(json_chunk.decode("utf-8"))
    return gltf, bin_chunk


def buffer_view_bytes(gltf: dict, bin_data: bytes, buffer_view_index: int) -> bytes:
    bv = gltf["bufferViews"][buffer_view_index]
    start = bv.get("byteOffset", 0)
    return bin_data[start : start + bv["byteLength"]]


COMPONENT_TYPE_FORMATS = {5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
TYPE_COMPONENT_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_accessor(gltf: dict, bin_data: bytes, accessor_index: int) -> list:
    acc = gltf["accessors"][accessor_index]
    fmt_char, comp_size = COMPONENT_TYPE_FORMATS[acc["componentType"]]
    n_components = TYPE_COMPONENT_COUNTS[acc["type"]]
    raw = buffer_view_bytes(gltf, bin_data, acc["bufferView"])
    expected_len = acc["count"] * n_components * comp_size
    if len(raw) < expected_len:
        raise ValidationError(f"accessor {accessor_index}: bufferView too short ({len(raw)} bytes, need {expected_len})")
    fmt = f"<{acc['count'] * n_components}{fmt_char}"
    flat = struct.unpack_from(fmt, raw, 0)
    return [flat[i : i + n_components] for i in range(0, len(flat), n_components)]


def validate_file(path: Path, extract_dir: Path | None) -> list[str]:
    problems: list[str] = []
    try:
        gltf, bin_data = read_glb(path)
    except ValidationError as exc:
        return [f"STRUCTURE: {exc}"]

    if gltf.get("asset", {}).get("version") != "2.0":
        problems.append(f"asset.version is {gltf.get('asset', {}).get('version')!r}, expected '2.0'")

    declared_buffer_len = gltf.get("buffers", [{}])[0].get("byteLength")
    if declared_buffer_len != len(bin_data):
        problems.append(f"buffers[0].byteLength={declared_buffer_len} but BIN chunk is {len(bin_data)} bytes")

    node_count = len(gltf.get("nodes", []))
    mesh_count = len(gltf.get("meshes", []))
    material_count = len(gltf.get("materials", []))
    image_count = len(gltf.get("images", []))

    total_verts = 0
    total_tris = 0
    for mesh_idx, mesh in enumerate(gltf.get("meshes", [])):
        for prim_idx, prim in enumerate(mesh.get("primitives", [])):
            pos_idx = prim["attributes"].get("POSITION")
            if pos_idx is None:
                problems.append(f"mesh[{mesh_idx}].primitives[{prim_idx}] has no POSITION attribute")
                continue
            try:
                positions = read_accessor(gltf, bin_data, pos_idx)
            except ValidationError as exc:
                problems.append(f"mesh[{mesh_idx}].primitives[{prim_idx}] POSITION: {exc}")
                continue

            total_verts += len(positions)
            for v in positions:
                if any(not math.isfinite(c) for c in v):
                    problems.append(f"mesh[{mesh_idx}].primitives[{prim_idx}]: non-finite vertex position {v}")
                    break

            pos_accessor = gltf["accessors"][pos_idx]
            declared_min, declared_max = pos_accessor.get("min"), pos_accessor.get("max")
            if declared_min and declared_max:
                real_min = [min(v[i] for v in positions) for i in range(3)]
                real_max = [max(v[i] for v in positions) for i in range(3)]
                for i in range(3):
                    if abs(real_min[i] - declared_min[i]) > 1e-3 or abs(real_max[i] - declared_max[i]) > 1e-3:
                        problems.append(
                            f"mesh[{mesh_idx}].primitives[{prim_idx}]: declared min/max {declared_min}/{declared_max} "
                            f"doesn't match real data {real_min}/{real_max}"
                        )
                        break

            indices_idx = prim.get("indices")
            if indices_idx is not None:
                indices = [i[0] for i in read_accessor(gltf, bin_data, indices_idx)]
                total_tris += len(indices) // 3
                bad = [i for i in indices if i < 0 or i >= len(positions)]
                if bad:
                    problems.append(f"mesh[{mesh_idx}].primitives[{prim_idx}]: {len(bad)} index/indices out of range (vertex count {len(positions)}), e.g. {bad[:5]}")
                if len(indices) % 3 != 0:
                    problems.append(f"mesh[{mesh_idx}].primitives[{prim_idx}]: index count {len(indices)} not a multiple of 3")

    for image_idx, image in enumerate(gltf.get("images", [])):
        bv_idx = image.get("bufferView")
        if bv_idx is None:
            problems.append(f"images[{image_idx}] has no bufferView (external-URI images not expected here)")
            continue
        png_bytes = buffer_view_bytes(gltf, bin_data, bv_idx)
        try:
            img = Image.open(__import__("io").BytesIO(png_bytes))
            img.load()
        except Exception as exc:  # noqa: BLE001
            problems.append(f"images[{image_idx}]: Pillow couldn't decode embedded PNG: {exc}")
            continue
        if img.width <= 0 or img.height <= 0:
            problems.append(f"images[{image_idx}]: degenerate size {img.width}x{img.height}")
        if extract_dir is not None:
            extract_dir.mkdir(parents=True, exist_ok=True)
            out_name = f"{path.stem}_image{image_idx}.png"
            img.convert("RGBA").save(extract_dir / out_name)

    summary = f"nodes={node_count} meshes={mesh_count} materials={material_count} images={image_count} verts={total_verts} tris={total_tris}"
    if not problems:
        print(f"OK   {path}  [{summary}]")
    else:
        print(f"FAIL {path}  [{summary}]")
        for p in problems:
            print(f"       - {p}")
    return problems


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", type=Path, help="A .glb file, or a directory to scan recursively")
    parser.add_argument("--extract-textures", type=Path, default=None, help="Directory to save every embedded texture as a viewable PNG")
    args = parser.parse_args()

    if args.path.is_file():
        files = [args.path]
    else:
        files = sorted(args.path.rglob("*.glb"))

    if not files:
        print(f"No .glb files found under {args.path}")
        return 1

    total_problems = 0
    for f in files:
        total_problems += len(validate_file(f, args.extract_textures))

    print()
    print(f"{len(files)} file(s) checked, {total_problems} problem(s) found.")
    return 1 if total_problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
