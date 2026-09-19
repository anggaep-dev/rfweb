#!/usr/bin/env python3
"""
Converts one RF Online monster - `.msh` mesh + `.bn` skeleton + `.RFT`/`.dds`
texture + one `.ani` file per gameplay state (PEACEIDLE/WARATTACK/...) - into
a single, self-contained, real-skin/real-animation glTF Binary (`.glb`).

This is a *sibling* to `scripts/msh_to_gltf.py`, not a variant of it, because
a monster's own `.bn` skeleton is never shared with anything else (unlike
player equipment, which rigs onto the one already-loaded humanoid
skeleton - see msh_to_gltf.py's own module docstring). With no live skeleton
to attach to at runtime, the natural shape here is a normal, standalone
rigged glTF character: real `skins`/`joints`/`inverseBindMatrices`, and each
`.ani` state embedded as a real glTF animation targeting the skeleton's own
bone nodes by name - a stock `GLTFLoader` + `AnimationMixer` on the live
side, no bone-name-resolution-against-a-shared-skeleton needed at all.

Low-level pieces (binary reader, 3ds-Max -> Y-up coordinate conversion,
`.msh`/`.ani` parsing, `.RFT`/DDS decode, texture-name candidate resolution)
are imported straight from msh_to_gltf.py rather than re-derived - see that
file's own doc comment for where each one originally came from
(src/rf/mesh.ts, src/rf/texture.ts, src/rf/coords.ts, src/rf/character.ts).
`.bn` skeleton parsing is new here (mirrors src/rf/skeleton.ts's
`parseSkeleton`), and the animation-cleanup rules (drop the frame-0 anchor
keyframe, dedupe the loop-back keyframe, hold every bone at bind pose in
every clip that doesn't animate it) are baked into the exported glTF clips
directly - mirroring src/rf/animation.ts's `buildAnimationClip` exactly, so
the live side plays the embedded clips completely unmodified (see
docs/rf-format-notes.md's `.ani` section for why each of those rules exists).

Dependencies: same as msh_to_gltf.py - Python 3.9+ stdlib plus Pillow.

Usage (single monster, matching a `Mesh/Tex/Ani/Bone` raw dump layout like
a CDN upload staging folder):
    python scripts/monster_to_gltf.py TERRETB \\
        --cdn-root "C:/Users/you/cdn_upload/Monster" --out build/gltf/monster

Some monsters' Tex/Ani are still packed in per-monster `.RFS` archives
(Mesh/Bone are typically already loose in a raw dump like this) - unpack
those first with the existing extractor, same pattern used for every other
category, e.g.:
    python scripts/extract_rfs.py archive "<root>/Tex/GOLDENPIG.RFS" \\
        --out "<root>/Tex" --ext rft
    python scripts/extract_rfs.py archive "<root>/Ani/GOLDENPIG.RFS" \\
        --out "<root>/Ani" --ext ani
This script only ever reads already-loose files - it doesn't read `.RFS`
itself, same division of labor msh_to_gltf.py already uses.
"""

from __future__ import annotations

import argparse
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import msh_to_gltf as base  # noqa: E402 - see module docstring for why this is imported, not re-derived

DUPLICATE_TIME_EPSILON = 1e-6


class MonsterConversionError(Exception):
    """Raised for one monster's own missing/empty mesh|bone|skeleton data -
    a regular exception (not SystemExit) so a batch driver converting many
    monsters in one process (see unpack_and_convert_monsters.py) can catch
    it per-monster and keep going instead of the whole run dying on the
    first monster with no real mesh."""

# Real gameplay states seen across this project's own monster `.ani` dumps
# (`{stem}_{state}_01_00.ANI`, e.g. "TERRETB_WARIDLE_01_00.ANI") - mirrors
# the PEACE/WAR split the player skeleton's own clips use (see
# CharacterController's battle-mode toggle). Not every monster has every
# state; missing ones are silently skipped (see find_ani_file).
#
# Derived by scanning every real state token across the whole raw dump's
# Ani/ folder (~6000 files, ~24 distinct tokens after excluding two
# confirmed-redundant typo'd duplicates - "WAREIDLE" and
# "WARFORCEAUPPORT" - each confirmed, by checking every monster that has
# one, to always sit alongside a correctly-spelled "WARIDLE"/
# "WARFORCESUPPORT" for that same monster, so nothing is lost by dropping
# them) - NOT derived from one test monster's own file list, which is what
# silently dropped PEACEWALK/WARWALK (a stationary turret - the very first
# monster this script was tried against - has no walk cycle at all, so
# testing against it alone never surfaced that this list was missing two
# of the most commonly-needed states in the whole dump).
DEFAULT_STATES = [
    "PEACEIDLE",
    "PEACESTAND",
    "PEACEWALK",
    "PEACERUN",
    "PEACEDAMAGE",
    "PEACECRITICAL",
    "PEACEDIE",
    "PEACECORPSE",
    "WARIDLE",
    "WARSTAND",
    "WARWALK",
    "WARRUN",
    "WARATTACK",
    "WARDAMAGE",
    "WARCRITICAL",
    "WARPOWERUP",
    "WARFORCEATTACK",
    "WARFORCESUPPORT",
    "WARAIDSKILL",
    "WARSKILL",
    "WARDIE",
    "WARCORPSE",
]


# --------------------------------------------------------------------------
# `.bn` skeleton parsing - src/rf/skeleton.ts's parseSkeleton converts a
# bone's local position/rotation (convertVec3/convertQuat) but leaves its
# decomposed scale completely unconverted/unpermuted - a real asymmetry
# versus coords.ts's own convertScale, and one this script deliberately does
# NOT mirror: skeleton.ts's own choice is provably never exercised by a real
# player skeleton (every player .bn bone checked has scale (1,1,1), where an
# axis permutation is a no-op either way), so it's untested code, not a
# proven reference - unlike convert_matrix below, already proven correct
# across every real (frequently mirrored/negative-scale, e.g. symmetric L/R
# armor pieces) mesh object matrix this whole script converts. A monster's
# own skeleton routinely DOES have non-trivial (including negative, for
# mirrored L/R limb bones - confirmed via real ARGHOLQUICH/ANABOLACYST data)
# per-bone scale, which is exactly where skeleton.ts's untested shortcut
# and this script's own hand-converted position+rotation-only approach it
# used to have both broke (reported as bones/feet snapping to the wrong
# angle) - decompose()'s quaternion extraction for a negative-determinant
# matrix is only self-consistent with a scale that went through the exact
# same convert_matrix() round-trip (decompose -> convert each component,
# including convert_scale's axis permutation -> recompose -> decompose
# again), not with scale spliced in unconverted from the ORIGINAL
# (pre-conversion) decompose call.
# --------------------------------------------------------------------------


@dataclass
class RfBone:
    name: str
    parent_name: str
    parent_id: int
    local_pos: tuple[float, float, float]
    local_quat: tuple[float, float, float, float]
    local_scale: tuple[float, float, float]


def parse_skeleton(data: bytes) -> list[RfBone]:
    r = base.Reader(data)
    bone_count = r.u16()
    bones: list[RfBone] = []

    for _ in range(bone_count):
        name = r.fixed_string(100, "ascii")
        parent_name = r.fixed_string(100, "ascii")

        r.matrix4_raw()  # world/absolute matrix - unused, hierarchy rebuilt from local matrices
        local_matrix = r.matrix4_raw()
        r.matrix4_raw()  # parent-inverse matrix - unused

        local_pos, local_quat, local_scale = base.convert_matrix(local_matrix).decompose()

        shape_vertex_amount = r.u16()
        shape_face_amount = r.u16()
        unknown_amount = r.u16()

        r.seek(204)
        r.seek(12)  # hit box max
        r.seek(12)  # hit box min
        r.seek(67)
        r.seek(shape_vertex_amount * 28)  # vec3 vertex + 4 pad + vec3 normal
        r.seek(4)  # leading face index
        r.seek(shape_face_amount * 88)  # 2x u32 + 76 pad + trailing face index
        if unknown_amount > 0:
            r.seek(100 + 40 * unknown_amount)

        bones.append(RfBone(name, parent_name, -1, local_pos, local_quat, local_scale))

    name_to_index = {b.name: i for i, b in enumerate(bones)}
    for b in bones:
        b.parent_id = -1 if b.parent_name == base.INVALID_NAME else name_to_index.get(b.parent_name, -1)
    return bones


def invert_mat4(m: "base.Mat4") -> "base.Mat4":
    """General 4x4 inverse via Gauss-Jordan elimination (partial pivoting) -
    used for inverseBindMatrices, computed from each bone's bind-pose world
    matrix (see compute_world_matrices). A bind-pose bone transform is
    always a well-conditioned rotation+scale+translation, but this doesn't
    assume that - any invertible 4x4 works."""
    e = m.e
    a = [[e[c * 4 + r] for c in range(4)] for r in range(4)]
    inv = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]

    for col in range(4):
        pivot_row = max(range(col, 4), key=lambda r: abs(a[r][col]))
        if abs(a[pivot_row][col]) < 1e-12:
            raise ValueError("matrix is singular, cannot invert")
        a[col], a[pivot_row] = a[pivot_row], a[col]
        inv[col], inv[pivot_row] = inv[pivot_row], inv[col]
        pivot = a[col][col]
        a[col] = [v / pivot for v in a[col]]
        inv[col] = [v / pivot for v in inv[col]]
        for r in range(4):
            if r != col and a[r][col] != 0:
                factor = a[r][col]
                a[r] = [av - factor * cv for av, cv in zip(a[r], a[col])]
                inv[r] = [iv - factor * cv for iv, cv in zip(inv[r], inv[col])]

    out_e = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out_e[c * 4 + r] = inv[r][c]
    return base.Mat4(out_e)


def compute_world_matrices(bones: list[RfBone], local_mats: list["base.Mat4"]) -> list["base.Mat4"]:
    world: list["base.Mat4 | None"] = [None] * len(bones)

    def get_world(i: int) -> "base.Mat4":
        if world[i] is not None:
            return world[i]  # type: ignore[return-value]
        parent_id = bones[i].parent_id
        w = local_mats[i] if parent_id < 0 else base.Mat4.multiply(get_world(parent_id), local_mats[i])
        world[i] = w
        return w

    for i in range(len(bones)):
        get_world(i)
    return world  # type: ignore[return-value]


Quat = tuple[float, float, float, float]


def quat_mul(a: Quat, b: Quat) -> Quat:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def quat_conjugate(q: Quat) -> Quat:
    x, y, z, w = q
    return (-x, -y, -z, w)


def compute_bone_animation_corrections(bones: list[RfBone], parsed_clips: list[tuple[str, list["base.AniObject"], float]]) -> dict[str, Quat]:
    """A mirrored bone (real, confirmed data: a wing/limb root authored with
    a negative bind-pose scale to mirror an entire child subtree - see
    parse_skeleton's own doc comment) has its `.ani` rotation keyframes
    encoded in a DIFFERENT rotation-decomposition convention than its own
    `.bn` bind pose: converting them with the exact same convert_quat+
    conjugate formula every ordinary bone uses (correct for every bone
    checked EXCEPT these) reproduces a real rotation, just not the one that
    combines correctly with this bone's own negative scale - confirmed
    empirically (real DRACO wing data) by comparing world positions against
    the OTHER, unmirrored wing whose child bones share byte-identical
    relative-to-parent keyframe data with this wing's own children (i.e.
    both wings are authored to move as true mirror images of each other,
    making this a solvable, checkable constraint rather than a guess): the
    mirrored side's world motion only comes out as a correct mirror image
    once its root bone's every converted rotation keyframe is additionally
    RIGHT-multiplied by one constant correction quaternion.
    That correction is solvable in closed form from a single already-proven
    invariant this project's own animation.ts documents and this script's
    own tests confirm holds for every ordinary bone: a clip's frame-0
    keyframe is always byte-identical to the bone's own bind pose (it's a
    static reference/anchor, not real per-clip motion - see
    dropAnchorFrame's doc comment). So the correction is exactly whatever
    quaternion, right-multiplied onto that (already-converted) frame-0
    value, would turn it back into this bone's own (already-correct, via
    convert_matrix) bind quaternion: `conjugate(frame0) * bindQuat`. For an
    ordinary bone frame0 already equals bindQuat, so this comes out to
    identity (a harmless no-op) automatically - this function doesn't need
    to know in advance which bones are mirrored.
    Computed once per monster (not per clip): any clip that animates a
    given bone gives the same correction (frame-0 is the same static anchor
    in every clip for that bone), so the first parsed clip that has real
    rotation data for a bone is used and the rest are skipped for it.
    """
    corrections: dict[str, Quat] = {}
    for bone in bones:
        for _state, ani_objects, _duration in parsed_clips:
            obj = next((o for o in ani_objects if o.name == bone.name), None)
            if obj and obj.rotation_frames:
                frame0 = obj.rotation_frames[0][1]
                corrections[bone.name] = quat_mul(quat_conjugate(frame0), bone.local_quat)
                break
    return corrections


def find_bone_file(bone_dir: Path, stem: str) -> Path | None:
    return base._indexed_dir(bone_dir).get(f"{stem}.bn".upper())


def find_ani_file(ani_dir: Path, stem: str, state: str) -> Path | None:
    index = base._indexed_dir(ani_dir)
    prefix = f"{stem}_{state}".upper()
    matches = sorted(name for name in index if name.startswith(prefix) and name.endswith(".ANI"))
    return index[matches[0]] if matches else None


def drop_anchor_frame(frames: list) -> list:
    return frames[1:] if len(frames) > 1 else frames


def dedupe_frames(frames: list) -> list:
    if len(frames) < 2:
        return frames
    result = [frames[0]]
    for f in frames[1:]:
        if f[0] - result[-1][0] > DUPLICATE_TIME_EPSILON:
            result.append(f)
    return result


def clean_frames(frames: list) -> list:
    return dedupe_frames(drop_anchor_frame(frames))


# --------------------------------------------------------------------------
# glTF Binary writer - a monster-specific sibling of msh_to_gltf.py's own
# GlbBuilder: real node hierarchy (bones parent each other for real, instead
# of a flat scene + extras.parentName string) and a real `skins` entry,
# since there's a real standalone skeleton here to describe, unlike the
# equipment exporter's rigid-parts-with-no-skeleton-of-their-own case.
# --------------------------------------------------------------------------


class MonsterGlbBuilder:
    def __init__(self):
        self.bin = bytearray()
        self.buffer_views: list[dict] = []
        self.accessors: list[dict] = []
        self.meshes: list[dict] = []
        self.materials: list[dict] = []
        self.textures: list[dict] = []
        self.images: list[dict] = []
        self.nodes: list[dict] = []
        self.skins: list[dict] = []
        self.animations: list[dict] = []
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

    def add_material_with_texture(self, cache_key: str, rgba: bytes, width: int, height: int, alpha_mode: str) -> int:
        if cache_key in self._material_cache:
            return self._material_cache[cache_key]
        import io
        from PIL import Image

        png_bytes = io.BytesIO()
        Image.frombytes("RGBA", (width, height), rgba).save(png_bytes, format="PNG")
        image_view = self._add_buffer_view(png_bytes.getvalue())
        image_index = len(self.images)
        self.images.append({"bufferView": image_view, "mimeType": "image/png"})
        texture_index = len(self.textures)
        self.textures.append({"source": image_index})

        material_index = len(self.materials)
        material: dict = {
            "pbrMetallicRoughness": {"baseColorTexture": {"index": texture_index}, "metallicFactor": 0.0, "roughnessFactor": 1.0},
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

    def add_node(self, name: str, matrix: "base.Mat4 | None" = None, mesh: int | None = None, skin: int | None = None) -> int:
        node: dict = {"name": name}
        if matrix is not None:
            node["matrix"] = matrix.e
        if mesh is not None:
            node["mesh"] = mesh
        if skin is not None:
            node["skin"] = skin
        self.nodes.append(node)
        return len(self.nodes) - 1

    def set_parent(self, child_idx: int, parent_idx: int) -> None:
        self.nodes[parent_idx].setdefault("children", []).append(child_idx)

    def add_skin(self, inverse_binds: list["base.Mat4"], joint_node_indices: list[int]) -> int:
        data = b"".join(struct.pack("<16f", *m.e) for m in inverse_binds)
        view = self._add_buffer_view(data)
        acc = len(self.accessors)
        self.accessors.append({"bufferView": view, "componentType": 5126, "count": len(inverse_binds), "type": "MAT4"})
        skin_index = len(self.skins)
        self.skins.append({"inverseBindMatrices": acc, "joints": list(joint_node_indices)})
        return skin_index

    def add_static_mesh_primitive(self, obj: "base.MeshObject", material_index: int | None) -> int | None:
        if not obj.positions:
            return None
        pos_data = b"".join(struct.pack("<3f", *p) for p in obj.positions)
        normal_data = b"".join(struct.pack("<3f", *n) for n in obj.normals)
        uv_data = b"".join(struct.pack("<2f", *uv) for uv in obj.uvs)
        index_data = b"".join(struct.pack("<I", i) for i in obj.indices)

        xs = [p[0] for p in obj.positions]
        ys = [p[1] for p in obj.positions]
        zs = [p[2] for p in obj.positions]

        pos_view = self._add_buffer_view(pos_data, target=34962)
        pos_acc = len(self.accessors)
        self.accessors.append(
            {"bufferView": pos_view, "componentType": 5126, "count": len(obj.positions), "type": "VEC3", "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}
        )
        normal_view = self._add_buffer_view(normal_data, target=34962)
        normal_acc = len(self.accessors)
        self.accessors.append({"bufferView": normal_view, "componentType": 5126, "count": len(obj.normals), "type": "VEC3"})

        attributes = {"POSITION": pos_acc, "NORMAL": normal_acc}
        if obj.uvs:
            uv_view = self._add_buffer_view(uv_data, target=34962)
            uv_acc = len(self.accessors)
            self.accessors.append({"bufferView": uv_view, "componentType": 5126, "count": len(obj.uvs), "type": "VEC2"})
            attributes["TEXCOORD_0"] = uv_acc

        index_view = self._add_buffer_view(index_data, target=34963)
        index_acc = len(self.accessors)
        self.accessors.append({"bufferView": index_view, "componentType": 5125, "count": len(obj.indices), "type": "SCALAR"})

        primitive: dict = {"attributes": attributes, "indices": index_acc}
        if material_index is not None:
            primitive["material"] = material_index

        mesh_index = len(self.meshes)
        self.meshes.append({"name": obj.name, "primitives": [primitive]})
        return mesh_index

    def add_skinned_mesh_primitive(self, obj: "base.MeshObject", material_index: int | None, name_to_index: dict[str, int], unresolved: set[str]) -> int | None:
        """Same geometry as add_static_mesh_primitive, plus real JOINTS_0/
        WEIGHTS_0 indexed against the SKELETON's own bone order (unlike
        msh_to_gltf.py's equipment exporter, which builds a local-to-this-
        primitive joint table because it has no skeleton of its own to
        index into) - mirrors buildSkinAttributes (character.ts) exactly,
        including its per-vertex weight renormalization."""
        mesh_index = self.add_static_mesh_primitive(obj, material_index)
        if mesh_index is None:
            return None

        joints_data = bytearray()
        weights_data = bytearray()
        for names4, weights4 in zip(obj.bone_names, obj.bone_weights):
            idxs = [0, 0, 0, 0]
            vals = [0.0, 0.0, 0.0, 0.0]
            total = 0.0
            for k in range(4):
                name = names4[k]
                if name == base.INVALID_NAME:
                    continue
                joint_idx = name_to_index.get(name)
                if joint_idx is None:
                    unresolved.add(name)
                    continue
                idxs[k] = joint_idx
                vals[k] = weights4[k]
                total += weights4[k]
            if total > 0:
                vals = [v / total for v in vals]
            for idx in idxs:
                joints_data += struct.pack("<H", idx)
            for v in vals:
                weights_data += struct.pack("<f", v)

        joints_view = self._add_buffer_view(bytes(joints_data), target=34962)
        joints_acc = len(self.accessors)
        self.accessors.append({"bufferView": joints_view, "componentType": 5123, "count": len(obj.positions), "type": "VEC4"})
        weights_view = self._add_buffer_view(bytes(weights_data), target=34962)
        weights_acc = len(self.accessors)
        self.accessors.append({"bufferView": weights_view, "componentType": 5126, "count": len(obj.positions), "type": "VEC4"})
        self.meshes[mesh_index]["primitives"][0]["attributes"]["JOINTS_0"] = joints_acc
        self.meshes[mesh_index]["primitives"][0]["attributes"]["WEIGHTS_0"] = weights_acc
        return mesh_index

    def add_skeleton_animation(
        self,
        name: str,
        ani_objects: list["base.AniObject"],
        bones: list[RfBone],
        bone_node_indices: list[int],
        duration_seconds: float,
        bone_corrections: dict[str, Quat],
    ) -> None:
        """Embeds one `.ani` state as a real glTF animation targeting the
        skeleton's own bone nodes by name - NOT mesh sub-object nodes like
        msh_to_gltf.py's cloak handling (there is no equivalent mesh-node
        target here; a monster's `.ani` animates its skeleton directly,
        same as the player's own buildAnimationClip does). Every bone gets
        an explicit channel on every clip - even ones this state doesn't
        animate, held at bind pose - for the same reason buildAnimationClip
        does (animation.ts): AnimationMixer only ever writes what a track
        tells it to, so a bone missing from a clip would keep whatever a
        previously-played clip left it at instead of returning to bind
        pose. dropAnchorFrame/dedupeFrames are applied here too (see
        clean_frames) so the exported clip is ready to play completely
        as-is - no post-load reconstruction needed on the live side.
        `bone_corrections` (see compute_bone_animation_corrections) is
        applied to every rotation keyframe - a no-op (identity) for an
        ordinary bone, but load-bearing for a mirrored one (see that
        function's own doc comment for why its raw keyframes alone don't
        combine correctly with its own negative bind-pose scale)."""
        channels: list[dict] = []
        samplers: list[dict] = []

        def add_channel(node_idx: int, times: list[float], values: list[float], path: str) -> None:
            time_data = b"".join(struct.pack("<f", t) for t in times)
            time_view = self._add_buffer_view(time_data)
            time_acc = len(self.accessors)
            self.accessors.append({"bufferView": time_view, "componentType": 5126, "count": len(times), "type": "SCALAR", "min": [min(times)], "max": [max(times)]})
            val_data = b"".join(struct.pack("<f", v) for v in values)
            val_view = self._add_buffer_view(val_data)
            val_acc = len(self.accessors)
            n_components = 4 if path == "rotation" else 3
            self.accessors.append({"bufferView": val_view, "componentType": 5126, "count": len(times), "type": "VEC4" if n_components == 4 else "VEC3"})
            sampler_idx = len(samplers)
            samplers.append({"input": time_acc, "output": val_acc, "interpolation": "LINEAR"})
            channels.append({"sampler": sampler_idx, "target": {"node": node_idx, "path": path}})

        objects_by_name = {o.name: o for o in ani_objects}

        for i, bone in enumerate(bones):
            node_idx = bone_node_indices[i]
            obj = objects_by_name.get(bone.name)

            rot_frames = clean_frames(obj.rotation_frames) if obj and obj.rotation_frames else []
            if rot_frames:
                correction = bone_corrections.get(bone.name)
                rot_values = [quat_mul(q, correction) if correction else q for _, q in rot_frames]
                add_channel(node_idx, [t for t, _ in rot_frames], [c for q in rot_values for c in q], "rotation")
            else:
                add_channel(node_idx, [0.0], list(bone.local_quat), "rotation")

            pos_frames = clean_frames(obj.position_frames) if obj and obj.position_frames else []
            if pos_frames:
                add_channel(node_idx, [t for t, _ in pos_frames], [c for _, p in pos_frames for c in p], "translation")
            else:
                add_channel(node_idx, [0.0], list(bone.local_pos), "translation")

            scale_frames = clean_frames(obj.scale_frames) if obj and obj.scale_frames else []
            if scale_frames:
                add_channel(node_idx, [t for t, _ in scale_frames], [c for _, s in scale_frames for c in s], "scale")
            else:
                add_channel(node_idx, [0.0], list(bone.local_scale), "scale")

        self.animations.append({"name": name, "channels": channels, "samplers": samplers, "extras": {"durationSeconds": duration_seconds}})

    def write(self, path: Path, root_node_indices: list[int]) -> None:
        gltf: dict = {
            "asset": {"version": "2.0", "generator": "rfweb monster_to_gltf.py"},
            "scene": 0,
            "scenes": [{"nodes": list(root_node_indices)}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "textures": self.textures,
            "images": self.images,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.bin)}],
        }
        if self.skins:
            gltf["skins"] = self.skins
        if self.animations:
            gltf["animations"] = self.animations

        json_bytes = base._json_dumps(gltf).encode("utf-8")
        while len(json_bytes) % 4 != 0:
            json_bytes += b" "
        bin_bytes = bytes(self.bin)
        while len(bin_bytes) % 4 != 0:
            bin_bytes += b"\x00"

        total_length = 12 + (8 + len(json_bytes)) + (8 + len(bin_bytes))
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            f.write(struct.pack("<4sII", b"glTF", 2, total_length))
            f.write(struct.pack("<I4s", len(json_bytes), b"JSON"))
            f.write(json_bytes)
            f.write(struct.pack("<I4s", len(bin_bytes), b"BIN\x00"))
            f.write(bin_bytes)


def convert_monster(stem: str, mesh_dir: Path, tex_dir: Path, ani_dir: Path, bone_dir: Path, out_path: Path, states: list[str]) -> None:
    mesh_path = base.find_mesh_file(mesh_dir, stem)
    if mesh_path is None:
        raise MonsterConversionError(f"[MESH MISSING] {stem}: no {stem}.msh in {mesh_dir}")
    bone_path = find_bone_file(bone_dir, stem)
    if bone_path is None:
        raise MonsterConversionError(f"[BONE MISSING] {stem}: no {stem}.bn in {bone_dir}")

    bones = parse_skeleton(bone_path.read_bytes())
    if not bones:
        raise MonsterConversionError(f"[BONE EMPTY] {stem}: {bone_path} parsed to zero bones")
    name_to_index = {b.name: i for i, b in enumerate(bones)}
    local_mats = [base.Mat4.compose(b.local_pos, b.local_quat, b.local_scale) for b in bones]
    world_mats = compute_world_matrices(bones, local_mats)
    inverse_binds = [invert_mat4(w) for w in world_mats]

    objects = base.parse_mesh(mesh_path.read_bytes())
    real_objects = [o for o in objects if o.positions]
    if not real_objects:
        raise MonsterConversionError(f"[MESH EMPTY] {stem}: {mesh_path} has no renderable geometry")

    builder = MonsterGlbBuilder()
    # A monster is frequently NOT one texture for the whole model the way a
    # single equipment item is - real data confirmed (e.g. BLOODAXE) up to 4
    # distinct textures across one mesh (body, armor, teeth, held weapon).
    # Resolving one texture globally (this script's own original approach)
    # picked whichever sub-object happened to come first in file order and
    # applied ITS texture to literally everything else too - reported as
    # "looks like error texture" wherever that first object's own texture
    # was some small/unrelated detail piece (BLOODAXE's first real object is
    # its teeth, a 128x32 texture) rather than the main body skin. Resolved
    # per sub-object instead now, cached by resolved file path so re-used
    # textures (the common case - most sub-objects share the main body skin)
    # still only get decoded once.
    material_cache: dict[str, int] = {}
    untextured_material_index: int | None = None
    texture_fail_logged: set[tuple[str, ...]] = set()

    def resolve_material(obj: "base.MeshObject") -> int:
        nonlocal untextured_material_index
        candidates = base.texture_name_candidates(stem, obj.texture_path) if obj.texture_path else [stem]
        tex_path = base.find_texture_file(tex_dir, candidates)
        if tex_path is None:
            log_key = tuple(candidates)
            if log_key not in texture_fail_logged:
                texture_fail_logged.add(log_key)
                print(f"[TEXTURE FAIL] {stem} [{obj.name}]: tried {candidates} in {tex_dir} (mesh's own texturePath: {obj.texture_path!r}) - exporting untextured")
            if untextured_material_index is None:
                untextured_material_index = builder.add_untextured_material()
            return untextured_material_index
        key = str(tex_path)
        if key not in material_cache:
            width, height, rgba = base.decode_texture(tex_path.read_bytes())
            alpha_mode = base.classify_alpha(rgba)
            material_cache[key] = builder.add_material_with_texture(tex_path.stem, rgba, width, height, alpha_mode)
            print(f"[TEXTURE] {stem}: {tex_path.name} ({width}x{height}, {alpha_mode})")
        return material_cache[key]

    bone_node_indices = [builder.add_node(b.name, matrix=local_mats[i]) for i, b in enumerate(bones)]
    for i, b in enumerate(bones):
        if b.parent_id >= 0:
            builder.set_parent(bone_node_indices[i], bone_node_indices[b.parent_id])
    skin_index = builder.add_skin(inverse_binds, bone_node_indices)

    root_nodes = [bone_node_indices[i] for i, b in enumerate(bones) if b.parent_id < 0]
    unresolved_bone_names: set[str] = set()
    # Mirrors character.ts's buildObjectsFromParsedMesh siblingsByName exactly
    # (see its own doc comment): some multi-part meshes chain a rigid piece's
    # parentName to *another sub-object in this same file* instead of a real
    # bone (e.g. a weapon's muzzle-flash pivot parented to the weapon mesh
    # itself, which is in turn parented to a hand bone) - recorded here, in
    # file order, as each object is processed, so a later object can resolve
    # against an earlier sibling. Real files are consistently
    # parent-before-child, so one forward pass is enough.
    siblings_by_name: dict[str, tuple[int, "base.Mat4"]] = {}

    for obj in objects:
        parent_bone_idx = name_to_index.get(obj.parent_name)
        parent_sibling = siblings_by_name.get(obj.parent_name)

        if obj.has_weights:
            mesh_index = builder.add_skinned_mesh_primitive(obj, resolve_material(obj), name_to_index, unresolved_bone_names)
            node_idx = builder.add_node(obj.name or stem, mesh=mesh_index, skin=skin_index)
            root_nodes.append(node_idx)  # a skinned mesh's placement comes entirely from its joints, not this node
        else:
            # Rigid (unweighted) part - a real mesh if it has geometry, else
            # a bare empty node for a 0-vertex pivot/socket (e.g. a
            # muzzle-flash attach point). obj.object_matrix is bind-pose data
            # expressed in the whole skeleton's shared reference space, NOT
            # already relative to whatever it's about to be parented onto -
            # using it as-is as this node's local transform (this script's
            # own bug until this comment was added - see the "scattered
            # weapon" report that caught it) double-applies the parent's own
            # placement on top of it. Canceling that shared space out first
            # (multiplying by the parent's own inverse - bind-pose inverse
            # for a real bone, or the sibling's own objectMatrix inverse for
            # a same-file chain - exactly mirrors character.ts's
            # getCorrectedRigidBindInverse/localMatrix math, minus the
            # cross-skeleton retargeting correction that only exists there
            # because a player weapon is authored against one fixed
            # reference race skeleton regardless of who wields it; a
            # monster's own mesh and skeleton are authored together as one
            # self-contained unit, so there's no separate reference skeleton
            # to retarget from here) is what actually makes this a correct
            # local offset.
            mesh_index = builder.add_static_mesh_primitive(obj, resolve_material(obj)) if obj.positions else None
            if parent_bone_idx is not None:
                local_matrix = base.Mat4.multiply(inverse_binds[parent_bone_idx], obj.object_matrix)
                node_idx = builder.add_node(obj.name or "socket", matrix=local_matrix, mesh=mesh_index)
                builder.set_parent(node_idx, bone_node_indices[parent_bone_idx])
            elif parent_sibling is not None:
                sibling_node_idx, sibling_matrix = parent_sibling
                local_matrix = base.Mat4.multiply(invert_mat4(sibling_matrix), obj.object_matrix)
                node_idx = builder.add_node(obj.name or "socket", matrix=local_matrix, mesh=mesh_index)
                builder.set_parent(node_idx, sibling_node_idx)
            else:
                node_idx = builder.add_node(obj.name or "socket", matrix=obj.object_matrix, mesh=mesh_index)
                root_nodes.append(node_idx)

        if obj.name:
            siblings_by_name[obj.name] = (node_idx, obj.object_matrix)

    if unresolved_bone_names:
        print(f"[SKIN WARN] {stem}: {len(unresolved_bone_names)} bone name(s) referenced by mesh weights but not found in {bone_path.name}: {sorted(unresolved_bone_names)}")

    # Two passes: every real clip is parsed first (so compute_bone_
    # animation_corrections can see any clip that animates a given mirrored
    # bone, regardless of which state that happens to be), then each parsed
    # clip's channels are actually built using the now-fully-resolved
    # per-bone corrections - building channels in the same pass as parsing
    # would bake in the WRONG (identity) correction for any clip processed
    # before the one that first reveals a given bone needs one.
    parsed_clips: list[tuple[str, list["base.AniObject"], float]] = []
    for state in states:
        ani_path = find_ani_file(ani_dir, stem, state)
        if ani_path is None:
            continue
        try:
            ani_objects, duration = base.parse_animation(ani_path.read_bytes())
        except Exception as exc:  # noqa: BLE001 - one bad clip must not abort the whole conversion
            print(f"[ANI FAIL] {stem} {state}: {type(exc).__name__}: {exc}")
            continue
        parsed_clips.append((state, ani_objects, duration))

    bone_corrections = compute_bone_animation_corrections(bones, parsed_clips)

    states_found: list[str] = []
    for state, ani_objects, duration in parsed_clips:
        builder.add_skeleton_animation(state, ani_objects, bones, bone_node_indices, duration, bone_corrections)
        states_found.append(state)
    if not states_found:
        print(f"[ANI WARN] {stem}: no animation states found in {ani_dir} (tried {states}) - exporting bind pose only")

    builder.write(out_path, root_nodes)
    print(f"[OK] {stem}: {len(bones)} bones, {sum(len(o.positions) for o in real_objects)} verts, {len(states_found)}/{len(states)} states ({', '.join(states_found)}) -> {out_path}")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stem", help="Monster mesh/skeleton stem, e.g. TERRETB (matches <stem>.msh / <stem>.bn)")
    parser.add_argument("--cdn-root", type=Path, required=True, help="Root containing Mesh/Tex/Ani/Bone subfolders (e.g. a raw cdn_upload/Monster dump)")
    parser.add_argument("--mesh-dir", type=Path, default=None, help="Override: default <cdn-root>/Mesh")
    parser.add_argument("--tex-dir", type=Path, default=None, help="Override: default <cdn-root>/Tex")
    parser.add_argument("--ani-dir", type=Path, default=None, help="Override: default <cdn-root>/Ani")
    parser.add_argument("--bone-dir", type=Path, default=None, help="Override: default <cdn-root>/Bone")
    parser.add_argument("--out", type=Path, default=Path("build/gltf/monster"), help="Output directory - writes <out>/<stem>.glb")
    parser.add_argument("--states", default=",".join(DEFAULT_STATES), help=f"Comma-separated .ani state names to look for (default: {','.join(DEFAULT_STATES)})")
    args = parser.parse_args()

    mesh_dir = args.mesh_dir or (args.cdn_root / "Mesh")
    tex_dir = args.tex_dir or (args.cdn_root / "Tex")
    ani_dir = args.ani_dir or (args.cdn_root / "Ani")
    bone_dir = args.bone_dir or (args.cdn_root / "Bone")
    states = [s.strip().upper() for s in args.states.split(",") if s.strip()]

    out_path = args.out / f"{args.stem}.glb"
    try:
        convert_monster(args.stem, mesh_dir, tex_dir, ani_dir, bone_dir, out_path, states)
    except MonsterConversionError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
