#!/usr/bin/env python3
"""
Merges RF Online `.msh` meshes with their `.dds`/`.RFT` textures into
standalone glTF Binary (`.glb`) files - one `.glb` per mesh stem, geometry
and (when found) texture embedded together.

Ported directly from this project's own TypeScript readers, not
reverse-engineered from scratch:
  - `.msh` parsing (both the "default" format and the newer MESH08 variant):
    src/rf/mesh.ts
  - `.RFT`/DDS decode (XOR header decrypt, DXT1/DXT3/DXT5 CPU block decode,
    uncompressed 32bpp/24bpp/RGB565 paths): src/rf/texture.ts
  - 3ds Max -> Y-up space conversion: src/rf/coords.ts
  - Texture-name candidate resolution: src/rf/character.ts's
    `textureNameCandidates`/`boosterTextureName`
See docs/rf-format-notes.md for the full format writeups these came from.

Dependencies: Python 3.9+ stdlib, plus Pillow (`pip install pillow`) for PNG
encoding only - no glTF/mesh library, no network access needed.

Two ways to pick which meshes get converted:

1. Directory glob (no real item data needed) - every `.msh` file found under
   the category's mesh directory:
       python scripts/msh_to_gltf.py --root public/game-assets --out build/gltf
       python scripts/msh_to_gltf.py --root public/game-assets --out build/gltf --categories armor --races BMB55,BFB55

2. Real item catalog (`--definitions`) - mirrors src/rf/resource.ts and
   src/rf/items.ts exactly: enumerates real, currently-obtainable items from
   `weaponItem.json`/`helmetItem.json`/etc, resolves each one's numeric
   `Model` id to a mesh filename stem via `itemResource.json`/
   `playerResource.json` (the same id->stem lookup, including the per-race
   0x100000 block correction, the live app itself uses), and converts only
   those stems - so orphaned/test `.msh` files with no real matching item
   are skipped, and any item whose stem is missing from disk is reported by
   name instead of just not being in the output:
       python scripts/msh_to_gltf.py --cdn-root "C:/Users/you/cdn_upload" \\
           --definitions "C:/Users/you/cdn_upload/definitions" --out build/gltf

Every mesh that *is* found is converted and written even when no texture is
found (as untextured geometry) - the whole point of the run is to surface
which items are missing a texture, not to silently skip them. A full
failure list is printed at the end (and written to
`<out>/texture_failures.log`).
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

try:
    from PIL import Image
except ImportError:
    print("This script needs Pillow: pip install pillow", file=sys.stderr)
    raise

# --------------------------------------------------------------------------
# Coordinate conversion (src/rf/coords.ts) - 3ds Max (Z-up) -> Y-up, which
# is also glTF's own convention, so no further conversion is needed for
# glTF output beyond what this project's own renderer already applies.
# --------------------------------------------------------------------------


def convert_vec3(x: float, y: float, z: float) -> tuple[float, float, float]:
    return (-x, z, y)


def convert_quat(x: float, y: float, z: float, w: float) -> tuple[float, float, float, float]:
    return (-x, z, y, w)


def convert_scale(x: float, y: float, z: float) -> tuple[float, float, float]:
    return (x, z, y)


class Mat4:
    """Column-major 4x4, matching THREE.Matrix4's own element layout (and
    the raw file layout - see BinaryReader.matrix4Raw's own comment: no
    reshaping needed between the two)."""

    __slots__ = ("e",)

    def __init__(self, e: list[float] | None = None):
        self.e = e if e is not None else [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

    def determinant(self) -> float:
        e = self.e
        n11, n12, n13, n14 = e[0], e[4], e[8], e[12]
        n21, n22, n23, n24 = e[1], e[5], e[9], e[13]
        n31, n32, n33, n34 = e[2], e[6], e[10], e[14]
        n41, n42, n43, n44 = e[3], e[7], e[11], e[15]
        return (
            n41 * (+n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34)
            + n42 * (+n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33 - n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31)
            + n43 * (+n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32 + n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31)
            + n44 * (-n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33 + n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31)
        )

    def decompose(self) -> tuple[tuple[float, float, float], tuple[float, float, float, float], tuple[float, float, float]]:
        """Matches THREE.Matrix4.prototype.decompose exactly."""
        te = self.e
        sx = math.sqrt(te[0] * te[0] + te[1] * te[1] + te[2] * te[2])
        sy = math.sqrt(te[4] * te[4] + te[5] * te[5] + te[6] * te[6])
        sz = math.sqrt(te[8] * te[8] + te[9] * te[9] + te[10] * te[10])
        if self.determinant() < 0:
            sx = -sx
        pos = (te[12], te[13], te[14])

        inv_sx = 1 / sx if sx != 0 else 0
        inv_sy = 1 / sy if sy != 0 else 0
        inv_sz = 1 / sz if sz != 0 else 0
        m11, m12, m13 = te[0] * inv_sx, te[4] * inv_sy, te[8] * inv_sz
        m21, m22, m23 = te[1] * inv_sx, te[5] * inv_sy, te[9] * inv_sz
        m31, m32, m33 = te[2] * inv_sx, te[6] * inv_sy, te[10] * inv_sz

        trace = m11 + m22 + m33
        if trace > 0:
            s = 0.5 / math.sqrt(trace + 1.0)
            qw = 0.25 / s
            qx = (m32 - m23) * s
            qy = (m13 - m31) * s
            qz = (m21 - m12) * s
        elif m11 > m22 and m11 > m33:
            s = 2.0 * math.sqrt(1.0 + m11 - m22 - m33)
            qw = (m32 - m23) / s
            qx = 0.25 * s
            qy = (m12 + m21) / s
            qz = (m13 + m31) / s
        elif m22 > m33:
            s = 2.0 * math.sqrt(1.0 + m22 - m11 - m33)
            qw = (m13 - m31) / s
            qx = (m12 + m21) / s
            qy = 0.25 * s
            qz = (m23 + m32) / s
        else:
            s = 2.0 * math.sqrt(1.0 + m33 - m11 - m22)
            qw = (m21 - m12) / s
            qx = (m13 + m31) / s
            qy = (m23 + m32) / s
            qz = 0.25 * s

        return pos, (qx, qy, qz, qw), (sx, sy, sz)

    @staticmethod
    def compose(pos: tuple[float, float, float], quat: tuple[float, float, float, float], scale: tuple[float, float, float]) -> "Mat4":
        x, y, z, w = quat
        x2, y2, z2 = x + x, y + y, z + z
        xx, xy, xz = x * x2, x * y2, x * z2
        yy, yz, zz = y * y2, y * z2, z * z2
        wx, wy, wz = w * x2, w * y2, w * z2
        sx, sy, sz = scale

        e = [0.0] * 16
        e[0] = (1 - (yy + zz)) * sx
        e[1] = (xy + wz) * sx
        e[2] = (xz - wy) * sx
        e[3] = 0
        e[4] = (xy - wz) * sy
        e[5] = (1 - (xx + zz)) * sy
        e[6] = (yz + wx) * sy
        e[7] = 0
        e[8] = (xz + wy) * sz
        e[9] = (yz - wx) * sz
        e[10] = (1 - (xx + yy)) * sz
        e[11] = 0
        e[12], e[13], e[14], e[15] = pos[0], pos[1], pos[2], 1
        return Mat4(e)

    @staticmethod
    def multiply(a: "Mat4", b: "Mat4") -> "Mat4":
        """Matches THREE.Matrix4.multiplyMatrices(a, b) - column-major a*b."""
        ae, be = a.e, b.e
        te = [0.0] * 16
        for col in range(4):
            for row in range(4):
                te[col * 4 + row] = sum(ae[k * 4 + row] * be[col * 4 + k] for k in range(4))
        return Mat4(te)


IDENTITY_MAT4 = Mat4()


def convert_matrix(raw: Mat4) -> Mat4:
    """Matches src/rf/coords.ts's convertMatrix: decompose, convert position
    + rotation through the vector/quaternion rules, reuse scale as-is
    (permuted only, not sign-flipped - a deliberate asymmetry, not a
    shortcut, so this can't be replaced with a plain matrix conjugation)."""
    pos, quat, scale = raw.decompose()
    pos2 = convert_vec3(*pos)
    quat2 = convert_quat(*quat)
    scale2 = convert_scale(*scale)
    return Mat4.compose(pos2, quat2, scale2)


# --------------------------------------------------------------------------
# Binary reader (mirrors src/rf/BinaryReader.ts)
# --------------------------------------------------------------------------


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.offset = 0

    def seek(self, relative: int) -> None:
        self.offset += relative

    def u8(self) -> int:
        v = self.data[self.offset]
        self.offset += 1
        return v

    def u16(self) -> int:
        v = struct.unpack_from("<H", self.data, self.offset)[0]
        self.offset += 2
        return v

    def i16(self) -> int:
        v = struct.unpack_from("<h", self.data, self.offset)[0]
        self.offset += 2
        return v

    def u32(self) -> int:
        v = struct.unpack_from("<I", self.data, self.offset)[0]
        self.offset += 4
        return v

    def i32(self) -> int:
        v = struct.unpack_from("<i", self.data, self.offset)[0]
        self.offset += 4
        return v

    def f32(self) -> float:
        v = struct.unpack_from("<f", self.data, self.offset)[0]
        self.offset += 4
        return v

    def fixed_string(self, length: int, encoding: str = "ascii") -> str:
        raw = self.data[self.offset : self.offset + length]
        self.offset += length
        end = raw.find(b"\x00")
        if end < 0:
            end = len(raw)
        return raw[:end].decode(encoding, errors="replace")

    def vec3_raw(self) -> tuple[float, float, float]:
        return (self.f32(), self.f32(), self.f32())

    def vec3(self) -> tuple[float, float, float]:
        return convert_vec3(*self.vec3_raw())

    def matrix4_raw(self) -> Mat4:
        return Mat4([self.f32() for _ in range(16)])


EUCKR = "euckr"  # Python's codec name for EUC-KR

# --------------------------------------------------------------------------
# .msh parsing (mirrors src/rf/mesh.ts exactly - both formats)
# --------------------------------------------------------------------------

INVALID_NAME = "NULL"
MESH08_WEIGHT_TOLERANCE = 1e-5


@dataclass
class MeshObject:
    name: str
    parent_name: str
    object_matrix: Mat4
    texture_path: str
    # Indexed representation: unique (position, normal, uv) corners, deduped
    # by full attribute tuple (so hard edges/UV seams still split correctly)
    # - NOT flattened to non-indexed like mesh.ts's own three.js-facing
    # output, since indexed is exactly the glTF-side win this script exists
    # for. Positions are already baked into bind/world space here when the
    # object has any skin weights, same rule mesh.ts uses (this script does
    # not emit glTF skins - see the module docstring - so this bake is what
    # makes a skinned part's geometry look right as a static pose).
    positions: list[tuple[float, float, float]] = field(default_factory=list)
    normals: list[tuple[float, float, float]] = field(default_factory=list)
    uvs: list[tuple[float, float]] = field(default_factory=list)
    indices: list[int] = field(default_factory=list)
    # True when this object carries any skin weights - positions/normals
    # above are already baked into bind/world space in that case (see this
    # class's own doc comment), so the glTF *node* for it must get an
    # identity transform, not object_matrix again - applying object_matrix
    # a second time as the node transform would double-transform it.
    has_weights: bool = False
    # Parallel to positions (one 4-entry pair per welded vertex), only
    # populated when has_weights - the exact same per-vertex bone-name/
    # weight data mesh.ts's own RfMeshObject.skinBoneNames/skinWeights
    # carries, preserved through welding instead of discarded, so
    # GlbBuilder.add_mesh_primitive can encode it as real JOINTS_0/WEIGHTS_0
    # accessors (see its own doc comment) and a live-equipped, ANIMATED
    # character.ts consumer can rebuild proper skinning from a `.glb`
    # instead of the file only being useful for a static bind-pose preview.
    bone_names: list[list[str]] = field(default_factory=list)
    bone_weights: list[list[float]] = field(default_factory=list)


def _weld_corners(
    corner_pos: list[tuple[float, float, float]],
    corner_normal: list[tuple[float, float, float]],
    corner_uv: list[tuple[float, float]],
    corner_weights: list[tuple[list[str], list[float]]],
) -> tuple[
    list[tuple[float, float, float]],
    list[tuple[float, float, float]],
    list[tuple[float, float]],
    list[tuple[list[str], list[float]]],
    list[int],
]:
    """Dedupes (pos, normal, uv) corner triples into an indexed buffer. Skin
    weight data is a pure function of the underlying base vertex (always
    identical across every corner that shares one), so it rides along keyed
    by the same (pos, normal, uv) welding decision without taking part in
    it - a hard edge/UV seam can still legitimately split one base vertex
    into several welded ones, each simply carrying a copy of the same
    weight data, which is harmless (just a handful of duplicate entries,
    not a correctness bug)."""
    seen: dict[tuple, int] = {}
    positions: list[tuple[float, float, float]] = []
    normals: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    weights: list[tuple[list[str], list[float]]] = []
    indices: list[int] = []
    for p, n, uv, w in zip(corner_pos, corner_normal, corner_uv, corner_weights):
        key = (p, n, uv)
        idx = seen.get(key)
        if idx is None:
            idx = len(positions)
            seen[key] = idx
            positions.append(p)
            normals.append(n)
            uvs.append(uv)
            weights.append(w)
        indices.append(idx)
    return positions, normals, uvs, weights, indices


def _bake_skin_positions(
    corner_pos: Iterable[tuple[float, float, float]],
    corner_normal: Iterable[tuple[float, float, float]],
    object_matrix: Mat4,
) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]]:
    """Applies objectMatrix to positions/normals - mirrors mesh.ts's own
    bind/world-space bake for weighted objects (rigid objects stay in local
    space, same as mesh.ts)."""
    e = object_matrix.e
    normal_mat = _normal_matrix_from(object_matrix)
    baked_pos = []
    baked_normal = []
    for (x, y, z) in corner_pos:
        nx = e[0] * x + e[4] * y + e[8] * z + e[12]
        ny = e[1] * x + e[5] * y + e[9] * z + e[13]
        nz = e[2] * x + e[6] * y + e[10] * z + e[14]
        baked_pos.append((nx, ny, nz))
    for (x, y, z) in corner_normal:
        nx = normal_mat[0] * x + normal_mat[3] * y + normal_mat[6] * z
        ny = normal_mat[1] * x + normal_mat[4] * y + normal_mat[7] * z
        nz = normal_mat[2] * x + normal_mat[5] * y + normal_mat[8] * z
        length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        baked_normal.append((nx / length, ny / length, nz / length))
    return baked_pos, baked_normal


def _normal_matrix_from(m: Mat4) -> list[float]:
    """3x3 inverse-transpose of m's upper-left 3x3 (column-major, 9 floats)."""
    e = m.e
    a, b, c = e[0], e[4], e[8]
    d, f, g = e[1], e[5], e[9]
    h, i, j = e[2], e[6], e[10]
    det = a * (f * j - g * i) - b * (d * j - g * h) + c * (d * i - f * h)
    if det == 0:
        return [1, 0, 0, 0, 1, 0, 0, 0, 1]
    inv_det = 1.0 / det
    # inverse (row-major of the 3x3), then transpose == inverse-transpose column-major
    m00 = (f * j - g * i) * inv_det
    m01 = (c * i - b * j) * inv_det
    m02 = (b * g - c * f) * inv_det
    m10 = (g * h - d * j) * inv_det
    m11 = (a * j - c * h) * inv_det
    m12 = (c * d - a * g) * inv_det
    m20 = (d * i - f * h) * inv_det
    m21 = (b * h - a * i) * inv_det
    m22 = (a * f - b * d) * inv_det
    # Normal matrix = transpose(inverse(M)). Above is inverse (row-major);
    # transposing it and reading column-major gives the same 9 numbers back
    # in this symmetric layout, so this is already correct as column-major.
    return [m00, m10, m20, m01, m11, m21, m02, m12, m22]


def _decode_default_object(r: Reader, vertex_amount: int, triangle_amount: int, weight_amount: int, weight_model_type: int):
    base_vertices = []  # (pos, normal)
    for _ in range(vertex_amount):
        pos = r.vec3()
        r.seek(4)
        normal = r.vec3()
        base_vertices.append((pos, normal))

    tri_indices = []
    tri_normals = []
    tri_uvs = []
    for _ in range(triangle_amount):
        a, b, c = r.u32(), r.u32(), r.u32()
        tri_indices.append((a, b, c))
        n0, n1, n2 = r.vec3(), r.vec3(), r.vec3()
        tri_normals.append((n0, n1, n2))

        def read_uv():
            u = r.f32()
            v = r.f32()
            r.f32()  # padding
            return (u, 1 - v)  # V is stored top-down - flip (default format's own convention)

        tri_uvs.append((read_uv(), read_uv(), read_uv()))
        r.seek(4)

    weights_by_vertex: dict[int, tuple[list[str], list[float]]] = {}
    if weight_model_type == 1:
        bone_amount = r.u32()
        bone_names_for_assignment = [r.fixed_string(100, EUCKR) for _ in range(bone_amount)]
        for _ in range(weight_amount):
            vertex_index = r.u32()
            r.u32()  # amount of weights - unused
            bone_indices = [r.i32(), r.i32(), r.i32(), r.i32()]
            w = [r.f32(), r.f32(), r.f32(), r.f32()]
            bone_names = [bone_names_for_assignment[bi] if bi != -1 else INVALID_NAME for bi in bone_indices]
            weights_by_vertex[vertex_index] = (bone_names, w)
    elif weight_amount > 0:
        for _ in range(weight_amount):
            vertex_index = r.u32()
            r.u32()
            bone_names = [r.fixed_string(100, EUCKR) for _ in range(4)]
            w = [r.f32(), r.f32(), r.f32(), r.f32()]
            weights_by_vertex[vertex_index] = (bone_names, w)

    return base_vertices, tri_indices, tri_normals, tri_uvs, weights_by_vertex


def _decode_mesh08_object(r: Reader, weight_amount: int):
    vertex_amount = r.u16()
    base_vertices = []  # (pos, normal)
    uvs_by_vertex = []
    bone_indices_by_vertex = []
    resolved_weights_by_vertex = []

    for _ in range(vertex_amount):
        pos = r.vec3()
        w0, w1, w2 = r.f32(), r.f32(), r.f32()
        bi = (r.u16(), r.u16(), r.u16(), r.u16())
        normal = r.vec3()
        u, v = r.f32(), r.f32()
        r.seek(12)  # binormal(?) - unused

        base_vertices.append((pos, normal))
        uvs_by_vertex.append((u, -v))  # MESH08's own convention - negate, not "1-v"
        bone_indices_by_vertex.append(bi)

        if weight_amount > 0:
            s = w0 + w1 + w2
            weights = [w0, w1, w2, 1 - s] if s < 1 - MESH08_WEIGHT_TOLERANCE else [w0, w1, w2, 0.0]
            if sum(weights) < 1e-6:
                weights = [1.0, 0.0, 0.0, 0.0]
            resolved_weights_by_vertex.append(weights)

    triangle_index_count = r.u16()
    tri_indices = []
    for _ in range(triangle_index_count // 3):
        a, b, c = r.u16(), r.u16(), r.u16()
        tri_indices.append((a, b, c))

    bone_group_amount = r.u16()
    unique_bone_names: list[str] = []
    for _ in range(bone_group_amount):
        group_bone_amount = r.u32()
        for _ in range(group_bone_amount):
            name = r.fixed_string(100, EUCKR)
            if name not in unique_bone_names:
                unique_bone_names.append(name)
        r.seek((4 - group_bone_amount) * 100)

    weights_by_vertex: dict[int, tuple[list[str], list[float]]] = {}
    if weight_amount > 0:
        for i in range(vertex_amount):
            weights = resolved_weights_by_vertex[i]
            bi = bone_indices_by_vertex[i]
            bone_names = []
            weight_values = []
            for k, w in enumerate(weights):
                if w > 1e-6:
                    idx = bi[k]
                    bone_names.append(unique_bone_names[idx] if idx < len(unique_bone_names) else INVALID_NAME)
                    weight_values.append(w)
            if bone_names:
                weights_by_vertex[i] = (bone_names, weight_values)

    tri_normals = [tuple(base_vertices[i][1] for i in tri) for tri in tri_indices]
    tri_uvs = [tuple(uvs_by_vertex[i] for i in tri) for tri in tri_indices]

    return base_vertices, tri_indices, tri_normals, tri_uvs, weights_by_vertex


def parse_mesh(data: bytes) -> list[MeshObject]:
    r = Reader(data)
    is_mesh08 = data[0:6] == b"MESH08"
    if is_mesh08:
        r.seek(6)

    object_amount = r.u16()
    objects: list[MeshObject] = []

    for _ in range(object_amount):
        name = r.fixed_string(100, EUCKR)
        parent_name = r.fixed_string(100, EUCKR)
        object_matrix = convert_matrix(r.matrix4_raw())
        r.seek(128)  # local matrix + a third, unused matrix

        vertex_amount = r.u16()
        triangle_amount = r.u16()
        weight_amount = r.u16()

        texture_path = r.fixed_string(100, EUCKR)
        r.fixed_string(100, EUCKR)  # effect path - unused

        r.vec3()  # bbox max
        r.vec3()  # bbox min
        r.vec3_raw()  # unknown
        r.u32()
        r.u32()  # unknown flags
        weight_model_type = r.u32()
        r.vec3_raw()
        r.f32()
        r.seek(31)

        if is_mesh08:
            base_vertices, tri_indices, tri_normals, tri_uvs, weights_by_vertex = _decode_mesh08_object(r, weight_amount)
        else:
            base_vertices, tri_indices, tri_normals, tri_uvs, weights_by_vertex = _decode_default_object(
                r, vertex_amount, triangle_amount, weight_amount, weight_model_type
            )

        corner_pos, corner_normal, corner_uv, corner_weights = [], [], [], []
        has_weights = len(weights_by_vertex) > 0
        for t, tri in enumerate(tri_indices):
            for corner in range(3):
                base_index = tri[corner]
                corner_pos.append(base_vertices[base_index][0])
                corner_normal.append(tri_normals[t][corner])
                corner_uv.append(tri_uvs[t][corner])
                wd = weights_by_vertex.get(base_index)
                if wd:
                    names, vals = wd
                    # Both decoders can hand back fewer than 4 slots
                    # (MESH08 only emits slots with a real nonzero weight) -
                    # pad to exactly 4 here so every downstream consumer
                    # (glTF's fixed-VEC4 JOINTS_0/WEIGHTS_0, and
                    # buildSkinAttributes on the TS side) sees a uniform
                    # shape regardless of which decoder produced it.
                    names4 = (list(names) + [INVALID_NAME] * 4)[:4]
                    vals4 = (list(vals) + [0.0] * 4)[:4]
                else:
                    names4 = [INVALID_NAME] * 4
                    vals4 = [0.0] * 4
                corner_weights.append((names4, vals4))

        if has_weights:
            corner_pos, corner_normal = _bake_skin_positions(corner_pos, corner_normal, object_matrix)

        positions, normals, uvs, weld_weights, indices = _weld_corners(corner_pos, corner_normal, corner_uv, corner_weights)

        objects.append(
            MeshObject(
                name=name,
                parent_name=parent_name,
                object_matrix=object_matrix,
                texture_path=texture_path,
                positions=positions,
                normals=normals,
                uvs=uvs,
                indices=indices,
                has_weights=has_weights,
                bone_names=[w[0] for w in weld_weights] if has_weights else [],
                bone_weights=[w[1] for w in weld_weights] if has_weights else [],
            )
        )

    return objects


# --------------------------------------------------------------------------
# .ani parsing (mirrors src/rf/animation.ts's parseAnimation exactly - NOT
# buildAnimationClip, which stays TS-side unchanged; this only needs to
# reproduce parseAnimation's raw per-object keyframe output so it can be
# embedded as real glTF node animations - see GlbBuilder.add_animation and
# character.ts's own reconstruction of this same RfAnimation shape from the
# glTF clip it gets back).
# --------------------------------------------------------------------------

ANI_FRAME_SCALE = 160
ANI_FPS = 30


@dataclass
class AniObject:
    name: str
    rotation_frames: list[tuple[float, tuple[float, float, float, float]]] = field(default_factory=list)
    position_frames: list[tuple[float, tuple[float, float, float]]] = field(default_factory=list)
    scale_frames: list[tuple[float, tuple[float, float, float]]] = field(default_factory=list)


def _read_ani_quat(r: Reader) -> tuple[float, float, float, float]:
    x, y, z, w = r.f32(), r.f32(), r.f32(), r.f32()
    qx, qy, qz, qw = convert_quat(x, y, z, w)
    return (-qx, -qy, -qz, qw)  # conjugate - file stores the inverse of the true local rotation


def parse_animation(data: bytes) -> tuple[list[AniObject], float]:
    r = Reader(data)
    object_count = r.u16()
    objects: list[AniObject] = []
    max_frame = 0.0

    for _ in range(object_count):
        name = r.fixed_string(100, EUCKR)
        # The declared frame amount can exceed the last real keyframe (a
        # hold before the clip loops); when it does, it - not the keyframe
        # data - defines where the loop point actually is.
        declared_frame_amount = r.u16()
        max_frame = max(max_frame, declared_frame_amount / ANI_FRAME_SCALE / ANI_FPS)
        r.u16()  # frame count - unused
        r.seek(36)

        rotation_frames: list[tuple[float, tuple[float, float, float, float]]] = []
        rotation_kf_count = r.u16()
        for _ in range(rotation_kf_count):
            q = _read_ani_quat(r)
            scaled_frame = r.u32()
            t = scaled_frame / ANI_FRAME_SCALE / ANI_FPS
            max_frame = max(max_frame, t)
            rotation_frames.append((t, q))

        position_frames: list[tuple[float, tuple[float, float, float]]] = []
        position_kf_count = r.u16()
        for _ in range(position_kf_count):
            pos = r.vec3()
            scaled_frame = r.u32()
            t = scaled_frame / ANI_FRAME_SCALE / ANI_FPS
            max_frame = max(max_frame, t)
            position_frames.append((t, pos))

        scale_frames: list[tuple[float, tuple[float, float, float]]] = []
        scale_kf_count = r.u16()
        for _ in range(scale_kf_count):
            raw = r.vec3_raw()
            scale = convert_scale(*raw)
            scaled_frame = r.u32()
            t = scaled_frame / ANI_FRAME_SCALE / ANI_FPS
            max_frame = max(max_frame, t)
            scale_frames.append((t, scale))

        unknown_kf_count = r.u16()
        r.seek(unknown_kf_count * 8)  # float + u32 per entry, unused channel

        objects.append(AniObject(name=name, rotation_frames=rotation_frames, position_frames=position_frames, scale_frames=scale_frames))

    return objects, max_frame


# --------------------------------------------------------------------------
# DDS/.RFT texture decode (mirrors src/rf/texture.ts)
# --------------------------------------------------------------------------

RFT_PASSWORD_BYTES = bytes(
    [
        0x2E, 0x80, 0x4D, 0x76, 0x2E, 0xF8, 0xD1, 0xF0, 0xBD, 0x3F, 0x86, 0x81, 0x58, 0x2C, 0x3F, 0x3F, 0x2E, 0x2E, 0x67,
        0x6F, 0x3F, 0x40, 0x3F, 0x78, 0x3C, 0x3F, 0xF1, 0xC0, 0xA5, 0xF6, 0x3B, 0x9F, 0xC1, 0x20, 0x3F, 0xD7, 0xC8, 0xC1,
        0xE9, 0x85, 0x86, 0xBD, 0xEF, 0x56, 0x3F, 0xA1, 0xFB, 0x2E, 0x87, 0x86, 0x61, 0x4C, 0x21, 0x3B, 0x4E, 0xB4, 0x78,
        0x57, 0xAE, 0x97, 0x3F, 0x2E, 0x4A, 0x2E, 0x3F, 0x4C, 0x2E, 0x44, 0xCD, 0xC5, 0x5F, 0xE8, 0xE9, 0xEC, 0xEB, 0xBD,
        0xBE, 0xBB, 0xF7, 0x6C, 0x2E, 0xF2, 0xE4, 0x2E, 0x3F, 0x3F, 0x97, 0x9F, 0x9D, 0xB3, 0x21, 0xB9, 0x76, 0x65, 0x54,
        0x3F, 0xE6, 0xF6, 0xC6, 0xF0, 0x79, 0xDB, 0xE2, 0xB2, 0x4B, 0x2E, 0x2E, 0xEB, 0xD3, 0xD3, 0xCA, 0xAB, 0xEA, 0xC7,
        0xED, 0x9C, 0xC7, 0xD9, 0xD0, 0x65, 0x48, 0xB4, 0xFA, 0x35, 0x2E, 0x2E, 0x6A, 0x9B,
    ]
)


class TextureDecodeError(Exception):
    pass


def _decode_rft(data: bytes) -> bytes:
    if data[0:4] == b"DDS ":
        return data
    decoded = bytearray(data)
    for i in range(min(128, len(decoded))):
        decoded[i] ^= RFT_PASSWORD_BYTES[i]
    return bytes(decoded)


def _rgb565_to_rgb888(c: int) -> tuple[int, int, int]:
    r = (c >> 11) & 0x1F
    g = (c >> 5) & 0x3F
    b = c & 0x1F
    return ((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2))


def _decode_bc1_style_colors(data: bytes, offset: int) -> tuple[list[tuple[int, int, int]], int]:
    c0 = data[offset] | (data[offset + 1] << 8)
    c1 = data[offset + 2] | (data[offset + 3] << 8)
    r0, g0, b0 = _rgb565_to_rgb888(c0)
    r1, g1, b1 = _rgb565_to_rgb888(c1)
    colors = [
        (r0, g0, b0),
        (r1, g1, b1),
        ((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3),
        ((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3),
    ]
    index_bits = data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24)
    return colors, index_bits


def _write_texel(out: bytearray, out_w: int, out_h: int, x: int, y: int, r: int, g: int, b: int, a: int) -> None:
    if x >= out_w or y >= out_h:
        return
    o = (y * out_w + x) * 4
    out[o], out[o + 1], out[o + 2], out[o + 3] = r, g, b, a


def _decode_dxt1_block(data: bytes, offset: int, out: bytearray, out_w: int, out_h: int, bx: int, by: int) -> None:
    c0 = data[offset] | (data[offset + 1] << 8)
    c1 = data[offset + 2] | (data[offset + 3] << 8)
    r0, g0, b0 = _rgb565_to_rgb888(c0)
    r1, g1, b1 = _rgb565_to_rgb888(c1)
    if c0 > c1:
        colors = [
            (r0, g0, b0, 255),
            (r1, g1, b1, 255),
            ((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3, 255),
            ((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3, 255),
        ]
    else:
        colors = [
            (r0, g0, b0, 255),
            (r1, g1, b1, 255),
            ((r0 + r1) // 2, (g0 + g1) // 2, (b0 + b1) // 2, 255),
            (0, 0, 0, 0),
        ]
    index_bits = data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24)
    for py in range(4):
        for px in range(4):
            pixel_idx = py * 4 + px
            idx = (index_bits >> (2 * pixel_idx)) & 0x3
            r, g, b, a = colors[idx]
            _write_texel(out, out_w, out_h, bx + px, by + py, r, g, b, a)


def _decode_dxt3_block(data: bytes, offset: int, out: bytearray, out_w: int, out_h: int, bx: int, by: int) -> None:
    colors, index_bits = _decode_bc1_style_colors(data, offset + 8)
    for py in range(4):
        for px in range(4):
            pixel_idx = py * 4 + px
            alpha_byte = data[offset + (pixel_idx >> 1)]
            nibble = (alpha_byte >> 4) if (pixel_idx & 1) else (alpha_byte & 0xF)
            a = (nibble << 4) | nibble
            c_idx = (index_bits >> (2 * pixel_idx)) & 0x3
            r, g, b = colors[c_idx]
            _write_texel(out, out_w, out_h, bx + px, by + py, r, g, b, a)


def _decode_dxt5_block(data: bytes, offset: int, out: bytearray, out_w: int, out_h: int, bx: int, by: int) -> None:
    a0 = data[offset]
    a1 = data[offset + 1]
    av = [0] * 8
    av[0], av[1] = a0, a1
    if a0 > a1:
        av[2] = round((6 * a0 + 1 * a1) / 7)
        av[3] = round((5 * a0 + 2 * a1) / 7)
        av[4] = round((4 * a0 + 3 * a1) / 7)
        av[5] = round((3 * a0 + 4 * a1) / 7)
        av[6] = round((2 * a0 + 5 * a1) / 7)
        av[7] = round((1 * a0 + 6 * a1) / 7)
    else:
        av[2] = round((4 * a0 + 1 * a1) / 5)
        av[3] = round((3 * a0 + 2 * a1) / 5)
        av[4] = round((2 * a0 + 3 * a1) / 5)
        av[5] = round((1 * a0 + 4 * a1) / 5)
        av[6] = 0
        av[7] = 255

    a_low = data[offset + 2] | (data[offset + 3] << 8) | (data[offset + 4] << 16)
    a_high = data[offset + 5] | (data[offset + 6] << 8) | (data[offset + 7] << 16)
    alpha_indices = [0] * 16
    for i in range(8):
        alpha_indices[i] = (a_low >> (3 * i)) & 0x7
    for i in range(8):
        alpha_indices[8 + i] = (a_high >> (3 * i)) & 0x7

    colors, index_bits = _decode_bc1_style_colors(data, offset + 8)
    for py in range(4):
        for px in range(4):
            pixel_idx = py * 4 + px
            c_idx = (index_bits >> (2 * pixel_idx)) & 0x3
            r, g, b = colors[c_idx]
            a = av[alpha_indices[pixel_idx]]
            _write_texel(out, out_w, out_h, bx + px, by + py, r, g, b, a)


def _decompress_block_texture(data: bytes, width: int, height: int, fourcc: str) -> bytearray:
    out = bytearray(width * height * 4)
    block_size = 8 if fourcc == "DXT1" else 16
    decode_fn = {"DXT1": _decode_dxt1_block, "DXT3": _decode_dxt3_block, "DXT5": _decode_dxt5_block}[fourcc]
    blocks_wide = math.ceil(width / 4)
    blocks_high = math.ceil(height / 4)
    offset = 0
    for by in range(blocks_high):
        for bx in range(blocks_wide):
            decode_fn(data, offset, out, width, height, bx * 4, by * 4)
            offset += block_size
    return out


def decode_texture(raw: bytes) -> tuple[int, int, bytes]:
    """Returns (width, height, RGBA8 bytes) for an .RFT/.dds buffer -
    DXT1/DXT3/DXT5, uncompressed 32bpp/24bpp, and the one confirmed-real
    16bpp RGB565 layout. Raises TextureDecodeError for anything else
    (matches decodeRftTexture's own "throw, don't guess" policy)."""
    data = _decode_rft(raw)
    if data[0:4] != b"DDS ":
        raise TextureDecodeError("not a DDS file after RFT decrypt")

    header_size = struct.unpack_from("<I", data, 4)[0]
    height = struct.unpack_from("<I", data, 12)[0]
    width = struct.unpack_from("<I", data, 16)[0]
    pf_offset = 4 + 72
    pf_flags = struct.unpack_from("<I", data, pf_offset + 4)[0]
    fourcc_raw = data[pf_offset + 8 : pf_offset + 12]
    fourcc = fourcc_raw.decode("ascii", errors="ignore").rstrip("\x00")
    data_offset = 4 + header_size

    if fourcc in ("DXT1", "DXT3", "DXT5"):
        rgba = _decompress_block_texture(data[data_offset:], width, height, fourcc)
        return width, height, bytes(rgba)

    DDPF_RGB = 0x40
    rgb_bit_count = struct.unpack_from("<I", data, pf_offset + 12)[0]
    r_mask = struct.unpack_from("<I", data, pf_offset + 16)[0]
    g_mask = struct.unpack_from("<I", data, pf_offset + 20)[0]
    b_mask = struct.unpack_from("<I", data, pf_offset + 24)[0]
    a_mask = struct.unpack_from("<I", data, pf_offset + 28)[0]

    if pf_flags & DDPF_RGB and rgb_bit_count == 32 and (r_mask & 0xFF0000) and (g_mask & 0xFF00) and (b_mask & 0xFF) and (a_mask & 0xFF000000):
        out = bytearray(width * height * 4)
        src = data[data_offset:]
        for i in range(width * height):
            b, g, r, a = src[i * 4], src[i * 4 + 1], src[i * 4 + 2], src[i * 4 + 3]
            out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3] = r, g, b, a
        return width, height, bytes(out)

    if pf_flags & DDPF_RGB and rgb_bit_count == 24 and (r_mask & 0xFF0000) and (g_mask & 0xFF00) and (b_mask & 0xFF):
        out = bytearray(width * height * 4)
        src = data[data_offset:]
        for i in range(width * height):
            b, g, r = src[i * 3], src[i * 3 + 1], src[i * 3 + 2]
            out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3] = r, g, b, 255
        return width, height, bytes(out)

    if pf_flags & DDPF_RGB and rgb_bit_count == 16 and r_mask == 0xF800 and g_mask == 0x7E0 and b_mask == 0x1F and a_mask == 0:
        out = bytearray(width * height * 4)
        src = data[data_offset:]
        for i in range(width * height):
            c = src[i * 2] | (src[i * 2 + 1] << 8)
            r, g, b = _rgb565_to_rgb888(c)
            out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3] = r, g, b, 255
        return width, height, bytes(out)

    raise TextureDecodeError(f"unsupported DDS variant (fourCC={fourcc!r}, pfFlags={pf_flags:#x}, rgbBitCount={rgb_bit_count})")


def classify_alpha(rgba: bytes) -> str:
    """Mirrors texture.ts's classifyAlpha - returns 'OPAQUE'/'MASK'/'BLEND' for glTF's alphaMode."""
    pixel_count = len(rgba) // 4
    opaque = sum(1 for i in range(3, len(rgba), 4) if rgba[i] == 255)
    transparent = sum(1 for i in range(3, len(rgba), 4) if rgba[i] == 0)
    if opaque == pixel_count:
        return "OPAQUE"
    binary_pct = (opaque + transparent) / pixel_count * 100
    if binary_pct > 90:
        return "MASK"
    return "BLEND"


# --------------------------------------------------------------------------
# glTF Binary (.glb) writer - minimal, hand-rolled (no external glTF lib
# available in this environment), one buffer / one bin chunk per file.
# --------------------------------------------------------------------------


class GlbBuilder:
    def __init__(self):
        self.bin = bytearray()
        self.buffer_views: list[dict] = []
        self.accessors: list[dict] = []
        self.meshes: list[dict] = []
        self.materials: list[dict] = []
        self.textures: list[dict] = []
        self.images: list[dict] = []
        self.nodes: list[dict] = []
        self.animations: list[dict] = []
        # Only set for cloak conversions (see convert_one's ani handling) -
        # which cloak .ANI states had a real file found on disk and parsed
        # successfully, regardless of whether it produced any real glTF
        # animation channel (add_animation refuses to add a channel-less
        # animation - invalid per glTF's own spec - but a state that's
        # genuinely present with zero keyframe data, e.g. a real "USE"/
        # "UNUSE" file confirmed to carry no motion on some real cloaks,
        # must still round-trip as "this state exists, holds bind pose" -
        # not silently vanish - to exactly match what fetching that same
        # empty file directly would produce via buildAnimationClip's own
        # bind-pose-fallback today). Written into the scene's own extras
        # (assignExtrasToUserData in GLTFLoader.js puts scene extras onto
        # `gltf.scene.userData`) since it's metadata about the *file*, not
        # any one node/animation.
        self.scene_extras: dict | None = None
        self._material_cache: dict[str, int] = {}

    def _align(self) -> None:
        while len(self.bin) % 4 != 0:
            self.bin.append(0)

    def _add_buffer_view(self, data: bytes, target: int | None = None) -> int:
        self._align()
        offset = len(self.bin)
        self.bin.extend(data)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def add_mesh_primitive(self, obj: MeshObject, material_index: int | None) -> int:
        pos_data = b"".join(struct.pack("<3f", *p) for p in obj.positions)
        normal_data = b"".join(struct.pack("<3f", *n) for n in obj.normals)
        uv_data = b"".join(struct.pack("<2f", *uv) for uv in obj.uvs)
        # u32 indices - simplest, always safe regardless of vertex count
        # (this project's own meshes are small; no need to fit u16).
        index_data = b"".join(struct.pack("<I", i) for i in obj.indices)

        if not obj.positions:
            return -1

        xs = [p[0] for p in obj.positions]
        ys = [p[1] for p in obj.positions]
        zs = [p[2] for p in obj.positions]

        pos_view = self._add_buffer_view(pos_data, target=34962)
        pos_accessor = len(self.accessors)
        self.accessors.append(
            {
                "bufferView": pos_view,
                "componentType": 5126,
                "count": len(obj.positions),
                "type": "VEC3",
                "min": [min(xs), min(ys), min(zs)],
                "max": [max(xs), max(ys), max(zs)],
            }
        )

        normal_view = self._add_buffer_view(normal_data, target=34962)
        normal_accessor = len(self.accessors)
        self.accessors.append({"bufferView": normal_view, "componentType": 5126, "count": len(obj.normals), "type": "VEC3"})

        attributes = {"POSITION": pos_accessor, "NORMAL": normal_accessor}

        if obj.uvs:
            uv_view = self._add_buffer_view(uv_data, target=34962)
            uv_accessor = len(self.accessors)
            self.accessors.append({"bufferView": uv_view, "componentType": 5126, "count": len(obj.uvs), "type": "VEC2"})
            attributes["TEXCOORD_0"] = uv_accessor

        primitive_extras: dict | None = None
        if obj.bone_names:
            # Real JOINTS_0/WEIGHTS_0 accessors (the actual binary skinning
            # wire format - THREE.GLTFLoader maps these straight onto
            # geometry attributes "skinIndex"/"skinWeight", no `skins`/
            # joint-hierarchy node graph needed for that mapping to happen),
            # but joint INDEX here is only ever local to this one mesh's own
            # small used-bone set (never the live character skeleton's
            # indices - this exporter has no skeleton loaded at all) - the
            # name each local index actually means is carried alongside in
            # primitive.extras.jointNames instead of a real glTF `skins`
            # entry, since a consumer (character.ts's glb adapter) already
            # has its own live skeleton to resolve bone *names* against
            # (the same buildSkinAttributes()/nameToIndex path the raw
            # .msh pipeline already uses) - exporting a redundant duplicate
            # joint/bone hierarchy + inverseBindMatrices here would just be
            # extra data the consumer immediately discards.
            joint_names: list[str] = []
            joint_index_by_name: dict[str, int] = {}
            joints_data = bytearray()
            weights_data = bytearray()
            for names4, weights4 in zip(obj.bone_names, obj.bone_weights):
                for slot in range(4):
                    name = names4[slot]
                    w = weights4[slot]
                    if name == INVALID_NAME or w <= 0:
                        local_idx = 0
                        w = 0.0
                    else:
                        local_idx = joint_index_by_name.get(name)
                        if local_idx is None:
                            local_idx = len(joint_names)
                            joint_index_by_name[name] = local_idx
                            joint_names.append(name)
                    joints_data += struct.pack("<H", local_idx)
                    weights_data += struct.pack("<f", w)
            if not joint_names:
                joint_names.append(INVALID_NAME)

            joints_view = self._add_buffer_view(bytes(joints_data), target=34962)
            joints_accessor = len(self.accessors)
            self.accessors.append({"bufferView": joints_view, "componentType": 5123, "count": len(obj.positions), "type": "VEC4"})
            weights_view = self._add_buffer_view(bytes(weights_data), target=34962)
            weights_accessor = len(self.accessors)
            self.accessors.append({"bufferView": weights_view, "componentType": 5126, "count": len(obj.positions), "type": "VEC4"})
            attributes["JOINTS_0"] = joints_accessor
            attributes["WEIGHTS_0"] = weights_accessor
            primitive_extras = {"jointNames": joint_names}

        index_view = self._add_buffer_view(index_data, target=34963)
        index_accessor = len(self.accessors)
        self.accessors.append({"bufferView": index_view, "componentType": 5125, "count": len(obj.indices), "type": "SCALAR"})

        primitive: dict = {"attributes": attributes, "indices": index_accessor}
        if material_index is not None:
            primitive["material"] = material_index
        if primitive_extras is not None:
            primitive["extras"] = primitive_extras

        mesh_index = len(self.meshes)
        self.meshes.append({"name": obj.name, "primitives": [primitive]})
        return mesh_index

    def add_material_with_texture(self, cache_key: str, rgba: bytes, width: int, height: int, alpha_mode: str) -> int:
        if cache_key in self._material_cache:
            return self._material_cache[cache_key]

        png_bytes = io.BytesIO()
        Image.frombytes("RGBA", (width, height), rgba).save(png_bytes, format="PNG")
        image_view = self._add_buffer_view(png_bytes.getvalue())
        image_index = len(self.images)
        self.images.append({"bufferView": image_view, "mimeType": "image/png"})
        texture_index = len(self.textures)
        self.textures.append({"source": image_index})

        material_index = len(self.materials)
        material: dict = {
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": texture_index},
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
            "doubleSided": True,
        }
        if alpha_mode != "OPAQUE":
            material["alphaMode"] = alpha_mode
            if alpha_mode == "MASK":
                material["alphaCutoff"] = 0.5
        self.materials.append(material)

        self._material_cache[cache_key] = material_index
        return material_index

    def add_untextured_material(self) -> int:
        cache_key = "__untextured__"
        if cache_key in self._material_cache:
            return self._material_cache[cache_key]
        material_index = len(self.materials)
        self.materials.append({"pbrMetallicRoughness": {"baseColorFactor": [0.7, 0.7, 0.7, 1.0], "metallicFactor": 0.0, "roughnessFactor": 1.0}})
        self._material_cache[cache_key] = material_index
        return material_index

    def add_node(self, name: str, matrix: Mat4, mesh_index: int | None, parent_name: str | None = None) -> int:
        node: dict = {"name": name, "matrix": matrix.e}
        if mesh_index is not None and mesh_index >= 0:
            node["mesh"] = mesh_index
        # glTF has no "parented by name" concept (only real scene-graph
        # nesting) - the original per-object parent chain is stashed in
        # extras instead so a consumer that needs it (rigid parts bone-
        # attach/sibling-chain by name, not by glTF hierarchy - see
        # character.ts's buildObjectsFromParsedMesh) can recover it
        # losslessly. Every node in this file is a flat scene root (see
        # write()'s own scene list) specifically so this string survives
        # untouched instead of being reinterpreted as real nesting.
        #
        # `name` rides along here too, deliberately duplicating the node's
        # own `name` field above - THREE.GLTFLoader unconditionally runs
        # every node name through PropertyBinding.sanitizeNodeName (spaces
        # -> underscores) when building the live Object3D, but this exact
        # same raw string is also what `parent_name` values elsewhere in
        # the file point AT (parentName is never sanitized, since it's
        # extras data, not a node name). Without this, a name WITH a space
        # (e.g. a cloak's "BONE Cloak") ends up in a different namespace
        # than the (unsanitized) parentName strings that reference it -
        # `buildObjectsFromParsedMesh`'s sibling-chain lookup
        # (`siblingsByName.get(obj.parentName)`) then silently misses for
        # every child of that object, which falls back to unparented
        # world placement: it LOOKS right at rest (a rigid part's bind-pose
        # world position happens to match whether or not it's actually
        # parented), but doesn't move with its real parent's animation and
        # isn't actually attached to it - confirmed as the exact cause of
        # a cloak's wings appearing to "hover" independently of its base
        # pivot instead of following it. Weapon/armor sub-object names
        # never contain spaces, so this never surfaced there.
        node["extras"] = {"parentName": parent_name or INVALID_NAME, "name": name}
        self.nodes.append(node)
        return len(self.nodes) - 1

    def add_animation(self, name: str, ani_objects: list["AniObject"], node_name_to_index: dict[str, int], duration_seconds: float) -> bool:
        """Encodes one parsed `.ani` state as a real glTF node-TRS animation
        (channels/samplers), targeting the mesh nodes already added via
        add_node, matched by name. Real glTF animation, not a custom format -
        THREE.GLTFLoader reconstructs this straight into a THREE.AnimationClip
        with standard `${nodeName}.position`/`.quaternion`/`.scale` tracks
        (see PATH_PROPERTIES in GLTFLoader.js) - character.ts's own
        reconstruction just walks those tracks back into the same
        RfAnimation shape parseAnimation() itself produces from a raw .ani,
        so buildAnimationClip (unchanged) can build the final clip exactly
        as it always has, including its own bind-pose-fallback/dedupe logic.
        `duration_seconds` (parse_animation's own richer duration - it can
        exceed the last real keyframe when the file declares a loop-hold
        frame count beyond the keyframe data) has no standard glTF field to
        live in, so it rides along in this animation's own `extras` -
        GLTFLoader assigns animation-level extras onto the resulting
        AnimationClip's `userData` (see `assignExtrasToUserData(animation,
        animationDef)` in GLTFLoader.js), where character.ts reads it back.
        Returns False (and adds nothing) if not one object's channels ended
        up mapping to a real mesh node - an animation with zero channels
        would be dead weight, and per glTF's own spec, invalid."""
        channels: list[dict] = []
        samplers: list[dict] = []

        def add_channel(node_idx: int, times: list[float], values: list[float], n_components: int, path: str) -> None:
            time_data = b"".join(struct.pack("<f", t) for t in times)
            time_view = self._add_buffer_view(time_data)
            time_acc = len(self.accessors)
            self.accessors.append(
                {"bufferView": time_view, "componentType": 5126, "count": len(times), "type": "SCALAR", "min": [min(times)], "max": [max(times)]}
            )
            val_data = b"".join(struct.pack("<f", v) for v in values)
            val_view = self._add_buffer_view(val_data)
            val_acc = len(self.accessors)
            self.accessors.append({"bufferView": val_view, "componentType": 5126, "count": len(times), "type": "VEC4" if n_components == 4 else "VEC3"})
            sampler_idx = len(samplers)
            samplers.append({"input": time_acc, "output": val_acc, "interpolation": "LINEAR"})
            channels.append({"sampler": sampler_idx, "target": {"node": node_idx, "path": path}})

        for obj in ani_objects:
            node_idx = node_name_to_index.get(obj.name)
            if node_idx is None:
                # This animated object (from the .ani file) doesn't match
                # any real sub-object in this mesh - harmless, just nothing
                # to drive (mirrors buildAnimationClip's own objectsByName
                # lookup silently falling through to a bind-pose-only track
                # for any bone a clip doesn't mention).
                continue
            if obj.rotation_frames:
                times = [t for t, _ in obj.rotation_frames]
                values = [c for _, q in obj.rotation_frames for c in q]
                add_channel(node_idx, times, values, 4, "rotation")
            if obj.position_frames:
                times = [t for t, _ in obj.position_frames]
                values = [c for _, p in obj.position_frames for c in p]
                add_channel(node_idx, times, values, 3, "translation")
            if obj.scale_frames:
                times = [t for t, _ in obj.scale_frames]
                values = [c for _, s in obj.scale_frames for c in s]
                add_channel(node_idx, times, values, 3, "scale")

        if not channels:
            return False
        self.animations.append({"name": name, "channels": channels, "samplers": samplers, "extras": {"durationSeconds": duration_seconds}})
        return True

    def write(self, path: Path) -> None:
        scene: dict = {"nodes": list(range(len(self.nodes)))}
        if self.scene_extras:
            scene["extras"] = self.scene_extras
        gltf = {
            "asset": {"version": "2.0", "generator": "rfweb msh_to_gltf.py"},
            "scene": 0,
            "scenes": [scene],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "textures": self.textures,
            "images": self.images,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.bin)}],
        }
        if self.animations:
            gltf["animations"] = self.animations
        json_bytes = _json_dumps(gltf).encode("utf-8")
        while len(json_bytes) % 4 != 0:
            json_bytes += b" "
        bin_bytes = bytes(self.bin)
        while len(bin_bytes) % 4 != 0:
            bin_bytes += b"\x00"

        total_length = 12 + (8 + len(json_bytes)) + (8 + len(bin_bytes))
        with open(path, "wb") as f:
            f.write(struct.pack("<4sII", b"glTF", 2, total_length))
            f.write(struct.pack("<I4s", len(json_bytes), b"JSON"))
            f.write(json_bytes)
            f.write(struct.pack("<I4s", len(bin_bytes), b"BIN\x00"))
            f.write(bin_bytes)


def _json_dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"))


# --------------------------------------------------------------------------
# Texture candidate resolution (mirrors character.ts's textureNameCandidates
# / boosterTextureName) - deliberately a superset of what the live app
# currently tries per-category (weapon items there only try the bare stem;
# every candidate below is tried for every category here), so this script
# can only find *more* matches, never fewer, while still logging anything
# it can't resolve.
# --------------------------------------------------------------------------

BOOSTER_TIER_TO_INDEX = {"50": "01", "52": "02", "53": "03", "54": "04"}
BOOSTER_RACE_TOKEN_TO_CODE = {
    "ACCRETIA": "AC",
    "BELFEMALE": "BE",
    "BELMALE": "BE",
    "CORFEMALE": "CO",
    "CORMALE": "CO",
}
_BOOSTER_STEM_RE = re.compile(r"^([A-Z]+)_COSTUMEARMOR_CLOAK_(\d+)$")


def _booster_texture_name(stem: str) -> str | None:
    m = _BOOSTER_STEM_RE.match(stem)
    if not m:
        return None
    race_token, tier = m.groups()
    code = BOOSTER_RACE_TOKEN_TO_CODE.get(race_token)
    index = BOOSTER_TIER_TO_INDEX.get(tier)
    return f"{index}_buster_{code}" if code and index else None


def texture_name_candidates(stem: str, embedded_texture_path: str) -> list[str]:
    candidates = []
    # New: the mesh's own embedded texture reference, basename only (it's
    # usually an absolute original-author dev-machine path - see
    # docs/rf-format-notes.md's .RFT section - but trying its basename
    # costs nothing and occasionally matches directly).
    if embedded_texture_path:
        base = embedded_texture_path.replace("\\", "/").rsplit("/", 1)[-1]
        base = base.rsplit(".", 1)[0] if "." in base else base
        if base:
            candidates.append(base)
    candidates.append(stem)
    if "_ARMOR_" in stem:
        candidates.append(stem.replace("_ARMOR_", "_WEAPON_"))
    if "_WEAPON_" in stem:
        candidates.append(stem.replace("_WEAPON_", "_ARMOR_"))
    booster = _booster_texture_name(stem)
    if booster:
        candidates.append(booster)
    # De-dupe, preserve order.
    seen = set()
    out = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


_DIR_INDEX_CACHE: dict[Path, dict[str, Path]] = {}


def _indexed_dir(dir_path: Path) -> dict[str, Path]:
    """Case-insensitive `UPPERCASE stem+ext -> real Path` index of one
    directory's files, built once and cached - matches
    fetchChefAssetCaseInsensitive's own reasoning (character.ts) that real
    on-disk casing routinely disagrees with whatever a resource/item JSON
    happens to reference, and this project's item catalogs are consistently
    upper-cased (see the FileName samples in resource.ts's own doc
    comments) while actual files are often mixed-case."""
    cached = _DIR_INDEX_CACHE.get(dir_path)
    if cached is not None:
        return cached
    index: dict[str, Path] = {}
    if dir_path.is_dir():
        for p in dir_path.iterdir():
            if p.is_file():
                index[p.name.upper()] = p
    _DIR_INDEX_CACHE[dir_path] = index
    return index


def find_texture_file(tex_dir: Path, candidates: list[str]) -> Path | None:
    index = _indexed_dir(tex_dir)
    for candidate in candidates:
        for ext in (".dds", ".rft"):
            found = index.get(f"{candidate}{ext}".upper())
            if found is not None:
                return found
    return None


def find_mesh_file(mesh_dir: Path, stem: str) -> Path | None:
    return _indexed_dir(mesh_dir).get(f"{stem}.msh".upper())


# Which of a cloak's own animation states to embed - mirrors character.ts's
# own CLOAK_ANI_STATES exactly (see its doc comment for why DEFAULT/UNEQUIP
# aren't included: DEFAULT is just the bind pose, nothing to play; UNEQUIP
# appears unused by the real client for this, UNUSE is what actually plays
# on removal). Real state names are also the glTF animation `name` this
# writes, matched back up by character.ts's own reconstruction.
CLOAK_ANI_STATES = ["EQUIP", "USE", "UNUSE", "ATTACK"]


def find_ani_file(ani_dir: Path, name: str) -> Path | None:
    return _indexed_dir(ani_dir).get(f"{name}.ANI".upper())


# --------------------------------------------------------------------------
# Real item-catalog-driven stem resolution (mirrors src/rf/resource.ts and
# src/rf/items.ts exactly) - Model id -> mesh filename stem, the same lookup
# the live app itself uses to decide what to render for an equipped item,
# rather than converting every loose `.msh` a directory happens to contain
# (which can include orphaned/test files with no real matching item, and
# conversely gives no way to notice an item whose mesh is simply missing).
# --------------------------------------------------------------------------

# Index into every list below = RaceGender's own enum value (character.ts) -
# Bell_Male=0, Bell_Female=1, Cora_Male=2, Cora_Female=3, Accretia=4.
RACE_GENDER_CONFIGS = [
    {"name_token": "BELMALE", "mesh_tex_code": "BM"},
    {"name_token": "BELFEMALE", "mesh_tex_code": "BF"},
    {"name_token": "CORMALE", "mesh_tex_code": "CM"},
    {"name_token": "CORFEMALE", "mesh_tex_code": "CF"},
    {"name_token": "ACCRETIA", "mesh_tex_code": "AA"},
]
# playerResource.json/itemResource.json give every race its own contiguous
# 0x100000-wide id block for real per-race tiers - see resolveItemMeshStem's
# own doc comment in resource.ts for how this was confirmed.
RACE_MESH_BLOCK_SIZE = 0x100000

# Item definition file per slot (src/rf/items.ts's ITEM_FILE_BY_SLOT) - only
# the slots this script currently converts (weapon + body armor) are listed;
# cloakItem.json is the natural next slot to add, same pattern throughout.
ITEM_FILE_BY_SLOT = {
    "weapon": "weaponItem.json",
    "cloak": "cloakItem.json",
    "helmet": "helmetItem.json",
    "face": "faceItem.json",
    "upper": "upperItem.json",
    "lower": "lowerItem.json",
    "gauntlet": "gauntletItem.json",
    "shoe": "shoeItem.json",
}
ARMOR_SLOTS = ["helmet", "face", "upper", "lower", "gauntlet", "shoe"]


def load_json_resource(path: Path) -> dict:
    # utf-8-sig: tolerate a BOM (seen on some of these exported files).
    return json.loads(path.read_text(encoding="utf-8-sig"))


def is_item_usable_by_race(civil: str, race_gender: int, slot: str) -> bool:
    """Mirrors items.ts's isItemUsableByRace exactly, including its
    slot-specific quirks (see that function's own doc comment for why
    faceItem.json's Civil is a genuinely-different-width code, and why
    weaponItem.json/cloakItem.json's numeric Civil needs the trailing-zeros
    division the other slots' already-8-char-padded strings don't)."""
    if slot == "face":
        return civil.rjust(5, "0")[race_gender] == "1"
    race_code = int(civil) // 1000
    return str(race_code).rjust(5, "0")[race_gender] == "1"


def load_slot_items(definitions_dir: Path, slot: str) -> list[dict]:
    """Mirrors items.ts's fetchSlotItems exactly: skip rows with no
    Model/Civil, and for weapon/cloak only, skip IsExist=0 (removed/unused
    placeholder) rows - see RawItemEntry.IsExist's own doc comment in
    items.ts for why that filter is weapon/cloak-specific, not universal."""
    raw = load_json_resource(definitions_dir / ITEM_FILE_BY_SLOT[slot])
    items = []
    for item_id, entry in raw.items():
        model = entry.get("Model")
        civil = entry.get("Civil")
        if not model or civil is None:
            continue
        if slot in ("weapon", "cloak") and str(entry.get("IsExist", 1)) == "0":
            continue
        items.append({"id": item_id, "name": entry.get("Name", item_id), "model": str(model), "civil": str(civil)})
    return items


def build_resource_index(resource_json: dict, mesh_key: str | None) -> tuple[dict[str, str], dict[int, str]]:
    """Builds `{id -> mesh stem}` and `{parsed-hex-value -> mesh stem}`
    indexes from one resource JSON's entries. `mesh_key=None` for
    itemResource.json (a flat `{id: entry}` object); mesh_key='Mesh' for
    playerResource.json (`{"Mesh": [entry, ...], ...}`) - mirrors
    loadItemResourceIndex/loadPlayerResourceMeshIndexes in resource.ts."""
    entries: Iterable[tuple[str, dict]]
    entries = resource_json.items() if mesh_key is None else ((e["ID"], e) for e in resource_json[mesh_key])

    by_id: dict[str, str] = {}
    by_value: dict[int, str] = {}
    for id_, entry in entries:
        file_name = entry.get("FileName")
        if not file_name:
            continue
        stem = re.sub(r"\.msh$", "", file_name, flags=re.IGNORECASE)
        by_id[id_] = stem
        try:
            by_value[int(id_, 16)] = stem
        except ValueError:
            pass
    return by_id, by_value


def resolve_weapon_mesh_stem(model_id: str, item_resource_by_id: dict[str, str]) -> str | None:
    """Mirrors resolveWeaponMesh - weapons are common loose files, an exact
    Model-id match against itemResource.json, no per-race block needed."""
    return item_resource_by_id.get(model_id)


def resolve_item_mesh_stem(model_id: str, race_gender: int, by_id: dict[str, str], by_value: dict[int, str]) -> str | None:
    """Mirrors resolveItemMeshStem (body armor, via playerResource.json) and
    resolveCloakMeshStem (cloaks, via itemResource.json) - same two-step
    resolution either way: try an exact id match first (legacy/simple
    items), then the per-race 0x100000 block correction for real armor
    tiers whose Model was authored under a different race's own block."""
    direct = by_id.get(model_id)
    if direct:
        return direct
    if not re.fullmatch(r"[0-9a-fA-F]+", model_id):
        return None
    low = int(model_id, 16) & 0xFFFFF
    return by_value.get(race_gender * RACE_MESH_BLOCK_SIZE + low)


# --------------------------------------------------------------------------
# Conversion driver
# --------------------------------------------------------------------------


@dataclass
class ConvertStats:
    converted: int = 0
    mesh_failures: list[tuple[str, str]] = field(default_factory=list)
    texture_failures: list[tuple[str, list[str], str]] = field(default_factory=list)


def convert_one(mesh_path: Path, tex_dir: Path, out_path: Path, stats: ConvertStats, ani_dir: Path | None = None) -> None:
    stem = mesh_path.stem
    try:
        objects = parse_mesh(mesh_path.read_bytes())
    except Exception as exc:  # noqa: BLE001 - report and keep going
        stats.mesh_failures.append((stem, f"{type(exc).__name__}: {exc}"))
        print(f"[MESH FAIL] {stem}: {exc}")
        return

    real_objects = [o for o in objects if o.positions]
    if not real_objects:
        # Socket-only file (every sub-object is a zero-vertex dummy) - not a
        # failure, just nothing to texture/export as geometry.
        return

    embedded_path = next((o.texture_path for o in real_objects if o.texture_path), "")
    candidates = texture_name_candidates(stem, embedded_path)
    tex_path = find_texture_file(tex_dir, candidates)

    builder = GlbBuilder()
    material_index: int | None = None

    if tex_path is None:
        stats.texture_failures.append((stem, candidates, embedded_path))
        print(f"[TEXTURE FAIL] {stem}: tried {candidates} in {tex_dir} (mesh's own texturePath: {embedded_path!r})")
    else:
        try:
            width, height, rgba = decode_texture(tex_path.read_bytes())
            alpha_mode = classify_alpha(rgba)
            material_index = builder.add_material_with_texture(tex_path.stem, rgba, width, height, alpha_mode)
        except Exception as exc:  # noqa: BLE001 - a malformed/truncated texture file must not abort the whole batch
            stats.texture_failures.append((stem, candidates, embedded_path))
            print(f"[TEXTURE DECODE FAIL] {stem}: found {tex_path.name} but couldn't decode it: {type(exc).__name__}: {exc}")

    node_name_to_index: dict[str, int] = {}
    for obj in objects:
        mesh_index = builder.add_mesh_primitive(obj, material_index) if obj.positions else None
        # A weighted object's positions/normals are already baked into
        # bind/world space (see MeshObject.has_weights) - giving it
        # object_matrix again here as the node's own transform would
        # double-transform it. Matches buildObjectsFromParsedMesh's own
        # split: a SkinnedMesh binds at identity for exactly this reason;
        # only a rigid (unweighted) part's node actually carries
        # object_matrix.
        node_matrix = IDENTITY_MAT4 if obj.has_weights else obj.object_matrix
        node_idx = builder.add_node(
            obj.name or "unnamed",
            node_matrix,
            mesh_index if mesh_index is not None and mesh_index >= 0 else None,
            obj.parent_name,
        )
        if obj.name:
            node_name_to_index[obj.name] = node_idx

    if ani_dir is not None:
        ani_states_found: list[str] = []
        for state in CLOAK_ANI_STATES:
            ani_path = find_ani_file(ani_dir, f"{stem}_{state}")
            if ani_path is None:
                continue
            try:
                ani_objects, duration = parse_animation(ani_path.read_bytes())
            except Exception as exc:  # noqa: BLE001 - a malformed .ani must not abort the whole batch
                print(f"[ANI FAIL] {stem} {state}: {type(exc).__name__}: {exc}")
                continue
            ani_states_found.append(state)
            if not builder.add_animation(state, ani_objects, node_name_to_index, duration):
                print(f"[ANI EMPTY] {stem} {state}: parsed but no channel matched a real mesh node (a genuinely no-op clip, not a failure)")
        if ani_states_found:
            builder.scene_extras = {"cloakAniStatesPresent": ani_states_found}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    builder.write(out_path)
    stats.converted += 1


def convert_flat_category(mesh_dir: Path, tex_dir: Path, out_dir: Path, stats: ConvertStats) -> None:
    for mesh_path in sorted(mesh_dir.glob("*.msh")):
        out_path = out_dir / f"{mesh_path.stem}.glb"
        convert_one(mesh_path, tex_dir, out_path, stats)


def convert_armor_category(mesh_root: Path, tex_root: Path, out_dir: Path, stats: ConvertStats, races: list[str] | None) -> None:
    race_dirs = sorted(p for p in mesh_root.iterdir() if p.is_dir())
    if races:
        wanted = {r.upper() for r in races}
        race_dirs = [p for p in race_dirs if p.name.upper() in wanted]
    for race_dir in race_dirs:
        tex_dir = tex_root / race_dir.name
        for mesh_path in sorted(race_dir.glob("*.msh")):
            out_path = out_dir / race_dir.name / f"{mesh_path.stem}.glb"
            convert_one(mesh_path, tex_dir, out_path, stats)


def _convert_resolved_stem(
    stem: str, mesh_dir: Path, tex_dir: Path, out_dir: Path, stats: ConvertStats, referenced_by: str, ani_dir: Path | None = None
) -> None:
    mesh_path = find_mesh_file(mesh_dir, stem)
    if mesh_path is None:
        stats.mesh_failures.append((stem, f"referenced by {referenced_by} but no {stem}.msh in {mesh_dir}"))
        print(f"[MESH MISSING] {stem}: {referenced_by} references this stem, not found in {mesh_dir}")
        return
    convert_one(mesh_path, tex_dir, out_dir / f"{stem}.glb", stats, ani_dir=ani_dir)


def convert_weapon_catalog(definitions_dir: Path, mesh_dir: Path, tex_dir: Path, out_dir: Path, stats: ConvertStats) -> None:
    item_resource = load_json_resource(definitions_dir / "resource" / "itemResource.json")
    by_id, _ = build_resource_index(item_resource, mesh_key=None)

    items = load_slot_items(definitions_dir, "weapon")
    stems = sorted({s for s in (resolve_weapon_mesh_stem(item["model"], by_id) for item in items) if s})
    print(f"=== weapon (catalog-driven): {len(items)} real weaponItem.json entries -> {len(stems)} unique mesh stems ===")

    unresolved = len(items) - sum(1 for item in items if resolve_weapon_mesh_stem(item["model"], by_id))
    if unresolved:
        print(f"  ({unresolved} catalog items have a Model id with no itemResource.json entry at all - not a mesh/texture problem, just no resource row for that Model; not logged individually)")

    for stem in stems:
        _convert_resolved_stem(stem, mesh_dir, tex_dir, out_dir, stats, "weaponItem.json")


def convert_armor_catalog(definitions_dir: Path, mesh_root: Path, tex_root: Path, out_dir: Path, stats: ConvertStats, races: list[int] | None) -> None:
    player_resource = load_json_resource(definitions_dir / "resource" / "playerResource.json")
    by_id, by_value = build_resource_index(player_resource, mesh_key="Mesh")

    race_indices = races if races else [0, 1, 2, 3, 4]
    slot_items_cache = {slot: load_slot_items(definitions_dir, slot) for slot in ARMOR_SLOTS}

    for race_gender in race_indices:
        cfg = RACE_GENDER_CONFIGS[race_gender]
        mesh_dir = mesh_root / cfg["mesh_tex_code"] / "mesh"
        tex_dir = tex_root / cfg["mesh_tex_code"] / "tex"
        if not mesh_dir.is_dir():
            print(f"[SKIP] armor {cfg['name_token']}: {mesh_dir} does not exist")
            continue

        stems: set[str] = set()
        for slot, items in slot_items_cache.items():
            for item in items:
                if not is_item_usable_by_race(item["civil"], race_gender, slot):
                    continue
                stem = resolve_item_mesh_stem(item["model"], race_gender, by_id, by_value)
                if stem:
                    stems.add(stem)

        print(f"=== armor {cfg['name_token']} (catalog-driven): {len(stems)} unique mesh stems across {len(ARMOR_SLOTS)} slots ===")
        for stem in sorted(stems):
            _convert_resolved_stem(stem, mesh_dir, tex_dir, out_dir / cfg["mesh_tex_code"], stats, f"a body-armor item catalog ({cfg['name_token']})")


def convert_cloak_catalog(
    definitions_dir: Path, mesh_dir: Path, tex_dir: Path, ani_dir: Path, out_dir: Path, stats: ConvertStats, races: list[int] | None
) -> None:
    """Mirrors resolveCloakMeshStem (resource.ts): resolved via
    itemResource.json - same table as weapons, NOT playerResource.json's
    per-race Mesh blocks - but still needs the per-race 0x100000 block
    correction per raceGender (a stem like "BELMALE_ARMOR_CLOAK_000" only
    resolves for the right race), so this still loops races the way
    convert_armor_catalog does even though (unlike armor) every race's
    result lands in ONE flat mesh/tex/ani directory, matching the real CDN
    layout (character.ts's CLOAK_CDN_BASE has no per-race subfolder -
    stems are already race-prefixed by name)."""
    item_resource = load_json_resource(definitions_dir / "resource" / "itemResource.json")
    by_id, by_value = build_resource_index(item_resource, mesh_key=None)

    items = load_slot_items(definitions_dir, "cloak")
    race_indices = races if races else [0, 1, 2, 3, 4]

    stems: set[str] = set()
    for race_gender in race_indices:
        for item in items:
            if not is_item_usable_by_race(item["civil"], race_gender, "cloak"):
                continue
            stem = resolve_item_mesh_stem(item["model"], race_gender, by_id, by_value)
            if stem:
                stems.add(stem)

    print(f"=== cloak (catalog-driven): {len(items)} real cloakItem.json entries -> {len(stems)} unique mesh stems ===")
    for stem in sorted(stems):
        _convert_resolved_stem(stem, mesh_dir, tex_dir, out_dir, stats, "cloakItem.json", ani_dir=ani_dir)


def main() -> int:
    # Embedded texturePath/name fields are EUC-KR and occasionally contain
    # real Korean text; Windows' default console codec (cp1252) can't
    # display that and would otherwise crash any print() that hits one -
    # fall back to showing it lossy rather than aborting the whole batch.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path("public/game-assets"), help="Glob-mode asset root (default: public/game-assets) - unused in catalog mode (--definitions)")
    parser.add_argument("--out", type=Path, default=Path("build/gltf"), help="Output directory for .glb files")
    parser.add_argument("--categories", default="weapon,armor", help="Comma-separated: weapon,armor,cloak (default: weapon,armor - cloak is opt-in, catalog mode only)")
    parser.add_argument("--races", default="", help="Armor category only: comma-separated race codes - folder names in glob mode (e.g. BMB55), or BM/BF/CM/CF/AA (or BELMALE/...) in catalog mode (default: all)")
    parser.add_argument(
        "--definitions",
        type=Path,
        default=None,
        help="Enables catalog-driven mode: a directory with weaponItem.json/helmetItem.json/.../resource/itemResource.json/resource/playerResource.json (matches src/rf/items.ts's ITEM_FILE_BY_SLOT + src/rf/resource.ts) - only real, currently-obtainable items are converted, by their actual Model id, instead of every loose .msh under --root",
    )
    parser.add_argument("--cdn-root", type=Path, default=None, help="Catalog mode: CDN upload root containing weapons/{mesh,tex} and character/<code>/{mesh,tex} (matches WEAPON_CDN_BASE/CHARACTER_CDN_BASE's own layout) - required together with --definitions")
    parser.add_argument("--weapon-mesh-dir", type=Path, default=None, help="Override: flat directory of weapon .msh files (default: glob mode <root>/item/Weapon/Mesh, catalog mode <cdn-root>/weapons/mesh)")
    parser.add_argument("--weapon-tex-dir", type=Path, default=None, help="Override: flat directory of weapon .dds/.RFT files (default: glob mode <root>/item/Weapon/Tex, catalog mode <cdn-root>/weapons/tex)")
    parser.add_argument("--armor-mesh-dir", type=Path, default=None, help="Override: directory of per-race mesh subfolders (default: glob mode <root>/character/player/Mesh, catalog mode <cdn-root>/character)")
    parser.add_argument("--armor-tex-dir", type=Path, default=None, help="Override: directory of per-race texture subfolders (default: glob mode <root>/character/player/Tex, catalog mode <cdn-root>/character)")
    parser.add_argument("--cloak-mesh-dir", type=Path, default=None, help="Catalog mode only (cloak category): override flat directory of cloak .msh files (default <cdn-root>/cloak/mesh)")
    parser.add_argument("--cloak-tex-dir", type=Path, default=None, help="Catalog mode only (cloak category): override flat directory of cloak .dds/.RFT files (default <cdn-root>/cloak/tex)")
    parser.add_argument("--cloak-ani-dir", type=Path, default=None, help="Catalog mode only (cloak category): override flat directory of cloak .ANI files (default <cdn-root>/cloak/ani) - embedded as real glTF animations, see GlbBuilder.add_animation")
    args = parser.parse_args()

    categories = {c.strip().lower() for c in args.categories.split(",") if c.strip()}
    races_raw = [r.strip() for r in args.races.split(",") if r.strip()] or None
    catalog_mode = args.definitions is not None

    if catalog_mode and args.cdn_root is None:
        print("--definitions requires --cdn-root too (catalog mode needs to know where the real mesh/tex files actually live)", file=sys.stderr)
        return 2

    stats = ConvertStats()

    if catalog_mode:
        race_indices: list[int] | None = None
        if races_raw:
            wanted = {r.upper() for r in races_raw}
            race_indices = [i for i, cfg in enumerate(RACE_GENDER_CONFIGS) if cfg["mesh_tex_code"] in wanted or cfg["name_token"] in wanted]

        if "weapon" in categories:
            mesh_dir = args.weapon_mesh_dir or (args.cdn_root / "weapons" / "mesh")
            tex_dir = args.weapon_tex_dir or (args.cdn_root / "weapons" / "tex")
            if mesh_dir.is_dir():
                convert_weapon_catalog(args.definitions, mesh_dir, tex_dir, args.out / "weapon", stats)
            else:
                print(f"[SKIP] weapon: {mesh_dir} does not exist")

        if "armor" in categories:
            mesh_root = args.armor_mesh_dir or (args.cdn_root / "character")
            tex_root = args.armor_tex_dir or (args.cdn_root / "character")
            if mesh_root.is_dir():
                convert_armor_catalog(args.definitions, mesh_root, tex_root, args.out / "armor", stats, race_indices)
            else:
                print(f"[SKIP] armor: {mesh_root} does not exist")

        if "cloak" in categories:
            mesh_dir = args.cloak_mesh_dir or (args.cdn_root / "cloak" / "mesh")
            tex_dir = args.cloak_tex_dir or (args.cdn_root / "cloak" / "tex")
            ani_dir = args.cloak_ani_dir or (args.cdn_root / "cloak" / "ani")
            if mesh_dir.is_dir():
                convert_cloak_catalog(args.definitions, mesh_dir, tex_dir, ani_dir, args.out / "cloak", stats, race_indices)
            else:
                print(f"[SKIP] cloak: {mesh_dir} does not exist")
    else:
        if "weapon" in categories:
            mesh_dir = args.weapon_mesh_dir or (args.root / "item" / "Weapon" / "Mesh")
            tex_dir = args.weapon_tex_dir or (args.root / "item" / "Weapon" / "Tex")
            if mesh_dir.is_dir():
                print(f"=== weapon: {mesh_dir} ===")
                convert_flat_category(mesh_dir, tex_dir, args.out / "weapon", stats)
            else:
                print(f"[SKIP] weapon: {mesh_dir} does not exist")

        if "armor" in categories:
            mesh_root = args.armor_mesh_dir or (args.root / "character" / "player" / "Mesh")
            tex_root = args.armor_tex_dir or (args.root / "character" / "player" / "Tex")
            if mesh_root.is_dir():
                print(f"=== armor: {mesh_root} ===")
                convert_armor_category(mesh_root, tex_root, args.out / "armor", stats, races_raw)
            else:
                print(f"[SKIP] armor: {mesh_root} does not exist")

    print()
    print(f"Converted: {stats.converted}")
    print(f"Mesh parse failures: {len(stats.mesh_failures)}")
    print(f"Texture resolution failures: {len(stats.texture_failures)}")

    args.out.mkdir(parents=True, exist_ok=True)
    log_path = args.out / "texture_failures.log"
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(f"Mesh parse failures ({len(stats.mesh_failures)}):\n")
        for stem, err in stats.mesh_failures:
            f.write(f"  {stem}: {err}\n")
        f.write(f"\nTexture resolution failures ({len(stats.texture_failures)}):\n")
        for stem, candidates, embedded in stats.texture_failures:
            f.write(f"  {stem}: tried {candidates} (embedded texturePath: {embedded!r})\n")
    print(f"Full failure log written to {log_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
