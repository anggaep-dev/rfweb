# RF Online client format notes

Reverse-engineered details behind `src/rf/*` and the controllers that use
them - binary layouts, coordinate conversions, math/formulas, and gameplay
data encodings that aren't obvious just from re-reading the parser code.
Written down so a later session doesn't have to re-derive them from scratch.

Source of truth is always the code (`src/rf/`, `src/controllers/`,
`src/scenes/`) - this file can drift; if something here disagrees with the
code, trust the code and fix this doc.

## Binary file formats

### `.RFS` archive (`src/rf/rfs.ts`)

Flat, uncompressed table of fixed-size records followed by the raw payload
data for every entry, back to back in table order.

```
u32           entryCount
entryCount × {
  char[32]    name        (NUL-padded, ASCII)
  byte[24]    reserved    (unknown purpose, constant layout)
  u32         offset      (into this same buffer)
  u32         size
}
... raw entry payloads (concatenated, at the offsets above) ...
```

Lookup (`findRfsEntry`) is case-insensitive and truncates the query name to
32 chars first - filenames routinely run longer than the record's name slot
(especially `.ANI` files), and the archive itself already stores them
truncated.

### `.msh` mesh (`src/rf/mesh.ts`)

One file can hold several sub-objects (e.g. a weapon's blade + its FX
sockets as separate objects). Only the non-`MESH08` variant is supported.

```
u16   objectAmount
objectAmount × {
  char[100]  name          (EUC-KR)
  char[100]  parentName    (EUC-KR)
  mat4       objectMatrix  (bind pose, 3ds Max space -> converted)
  skip 128                 (local matrix + a third, unused matrix)

  u16  vertexAmount
  u16  triangleAmount
  u16  weightAmount

  char[100]  texturePath   (EUC-KR)
  char[100]  effectPath    (unused)
  skip 12 (bbox max) + 12 (bbox min) + 12 (unknown vec3)
  u32                       (unused)
  u32                       (unknown flags)
  u32  weightModelType
  skip 12 (unknown vec3) + 4 (unknown float) + 31

  vertexAmount × { vec3 pos, skip 4, vec3 normal }

  triangleAmount × {
    u32 a, u32 b, u32 c                    (indices into the vertex list)
    vec3 n0, vec3 n1, vec3 n2               (per-corner normals)
    { f32 u, f32 v, skip 4 } × 3            (per-corner UV, V flipped: 1-v)
    skip 4
  }

  // Weight section - see the gotcha below, this is NOT gated on weightAmount>0
  if weightModelType == 1 {
    u32 boneAmount
    boneAmount × char[100] boneName        (EUC-KR)
    weightAmount × {
      u32 vertexIndex
      u32                                   (unused)
      i32[4] boneIndex                      (-1 = unused slot)
      f32[4] weight
    }
  } else if weightAmount > 0 {
    weightAmount × {
      u32 vertexIndex
      u32                                   (unused)
      char[100][4] boneName                 (EUC-KR)
      f32[4] weight
    }
  }
}
```

Vertices are emitted **non-indexed**, per triangle corner (three verts per
triangle, duplicated as needed) - there's no shared-vertex buffer in the
three.js geometry.

If the object has any weights, its vertices/normals are baked into
bind/world space right there in `parseMesh` (via `objectMatrix` and its
normal matrix) - skinning needs bind-pose-space vertices. Unweighted
(rigid) objects are left in local space; the caller places them relative to
whatever bone `parentName` points at.

**`parentName` doesn't always name a skeleton bone** - some multi-part
meshes chain a sub-object's `parentName` to *another sub-object in the
same file* instead. Confirmed on real weapon meshes: `BELCOR_WEAPON_
TSTAFF_135.msh` has three real (non-empty) sub-objects forming a chain,
`W02` → `W00` → `W01` → `"Bip01 R Hand"`/`"Bip01 R Finger0"` - only the
last hop is an actual bone name. `buildObjectsFromParsedMesh`
(`character.ts`) resolves both: skeleton bone first, then a same-file
sibling by name (processing objects in file order, which is consistently
parent-before-child in every real example seen, so a single forward pass
suffices - no topological sort needed). See "Known bugs" below for what
skipping the sibling case looked like in practice.

**Gotcha** (fixed after real breakage across 3 race/part combos): the
`boneAmount` + bone-name table is part of the object's weight *model*
(`weightModelType == 1`), not gated on `weightAmount > 0`. It's present even
for an object with the indexed model but zero actual weighted vertices
(e.g. `ACCRETIA_DEFAULT_UPPER_000.msh`'s 3rd sub-object). Gating the read on
`weightAmount > 0` silently skips a real 4-byte `boneAmount` field on disk,
misaligning every subsequent read for the rest of the file.

### `.bn` skeleton (`src/rf/skeleton.ts`)

```
u16  boneCount
boneCount × {
  char[100]  name          (ASCII)
  char[100]  parentName    (ASCII, "NULL" = root)
  mat4       worldMatrix   (unused - hierarchy rebuilt from local matrices)
  mat4       localMatrix   (decomposed -> position/rotation/scale, converted)
  mat4       parentInverse (unused)

  u16  shapeVertexAmount
  u16  shapeFaceAmount
  u16  unknownAmount

  skip 204 + 12 (hitbox max) + 12 (hitbox min) + 67
  skip shapeVertexAmount * 28    (vec3 vertex + 4 pad + vec3 normal)
  skip 4                         (leading face index)
  skip shapeFaceAmount * 88      (2×u32 + 76 pad + trailing face index)
  if unknownAmount > 0: skip 100 + 40 * unknownAmount
}
```

Bone "shape" collision geometry is parsed-past (skipped), not used - we only
need the hierarchy + bind pose. `parentId` is resolved by name after every
bone's been read (so forward-references to a not-yet-seen parent still
work).

A weapon's own per-item `.bn` files (under `item/Weapon/Bone/`, e.g.
`COM_WEAPON_RKNIFE_001.bn`) turn out to be a full *duplicate of the entire
humanoid skeleton*, not a small pivot skeleton - and are never actually
loaded at runtime (a weapon mesh's rigid sub-objects have a `parentName`
that names a bone that exists on any character's own skeleton, e.g.
`"Bip01 R Finger0"`/`"Bip01 R Hand"`, so weapons attach onto the wielding
character's already-built skeleton via the same rigid-part-attach path
body armor uses - see `loadWeaponMeshObjects` in `character.ts`).

**But they're not useless** - comparing one against the base race
skeletons revealed a real bug (fixed): every weapon `.bn` file checked has
bone world positions that match **Accretia's** own skeleton almost to the
decimal, regardless of what race the weapon is actually for (`COM_WEAPON_*`
= usable by all races). That means every weapon mesh's `objectMatrix` is
authored/expressed relative to Accretia's skeleton specifically, not
whichever race is currently wielding it - confirmed independently by
comparing an actual weapon mesh's `objectMatrix` position against
Accretia's real hand-bone position (residual ~0.33 units, presumably the
genuine grip offset) versus Bell Male's (~1.9 units off - very visibly
wrong). Using the *wielding* character's own skeleton for the rigid-part
bind-pose-inverse math (correct for body-part items, which really are
authored per-race) silently misplaced every weapon for every race except
Accretia. Fixed by decoupling the two roles `buildObjectsFromParsedMesh`'s
rigid-part branch needs: a `rigidReference` skeleton (always Accretia's,
lazily loaded once via `loadWeaponReferenceSkeleton()`, reusing the
already-preloaded Accretia race assets) supplies the bind-pose inverse for
computing the local offset, while `built` (the actual wielding character's
skeleton) still supplies the real bone object the weapon gets parented
onto - so it correctly follows that character's own pose.

### `.ani` animation (`src/rf/animation.ts`)

```
u16  animatedObjectCount
animatedObjectCount × {
  char[100]  name              (EUC-KR, matches a bone name)
  u16        declaredFrameAmount  // see note below
  u16                          (frame count - unused)
  skip 36

  u16  rotationKeyframeCount
  rotationKeyframeCount × { quat q (conjugated!), u32 scaledFrame }

  u16  positionKeyframeCount
  positionKeyframeCount × { vec3 pos, u32 scaledFrame }

  u16  scaleKeyframeCount
  scaleKeyframeCount × { vec3Raw scale (axis-converted), u32 scaledFrame }

  u16  unknownKeyframeCount
  skip unknownKeyframeCount * 8    (f32 + u32, unused channel)
}
```

- `time = scaledFrame / FRAME_SCALE / ANI_FPS`, `FRAME_SCALE = 160`,
  `ANI_FPS = 30` (assumed source playback rate - not encoded anywhere in
  the file).
- Rotation keyframes are **conjugated** on read - the file stores the
  inverse of the true local rotation.
- `declaredFrameAmount` can exceed the last real keyframe's time (a hold
  before the clip loops) - when it does, *it*, not the keyframe data,
  defines the actual loop point (`durationSeconds`).

`buildAnimationClip` (also `animation.ts`) does two things worth
remembering:

1. **Every skeleton bone gets an explicit track**, even ones this specific
   clip doesn't animate - falling back to a single held keyframe at that
   bone's bind pose. Reason: `AnimationMixer` only writes what a track
   tells it to, so a bone missing from a clip keeps whatever a *previously
   played* clip left it at - which showed up as limbs freezing mid-pose
   across a clip switch.
2. Two cleanup passes per channel:
   - `dropAnchorFrame`: every channel's first keyframe (t=0) is a static
     reference pose, byte-identical across every clip file for a given
     bone - not real per-clip data. Left in, every clip and every loop
     restart interpolates from this anchor toward the real first frame,
     which read as a brief T-pose flicker.
   - `dedupeFrames`: the source data ends each channel with a keyframe
     pinned to the exact loop-back time, duplicating the real last
     keyframe's timestamp. Two keyframes at the same time give three.js's
     linear interpolant a 0/0 alpha - NaN for one frame, right at the loop
     point.

### `.RFT` texture (`src/rf/texture.ts`)

A DDS file whose first 128 bytes are XORed against a fixed 128-byte
password (`RFT_PASSWORD_BYTES`) - same "unlock_dds" scheme as `.r3t`
material atlases. If the magic `'DDS '` is already readable at offset 0,
it's unencrypted and passed through as-is. Pixel data after the header is
never touched either way.

Every `.RFT` sampled across the base race archives decodes to **DXT1 or
DXT5** (no DXT3 seen: 78 DXT1 / 12 DXT5 in one survey). `Chef/Tex/`'s glow
textures (glowEffect.ts) turned out to use a wider spread, though: DXT1,
**DXT3**, and even **uncompressed** DDS (24bpp and 16bpp) - `decodeRftTexture`
handles all of these now, not just DXT1/DXT5 (see below).

Most mobile GPUs (iOS Safari especially) don't expose
`WEBGL_compressed_texture_s3tc`, so uploading a `CompressedTexture` there
silently no-ops - mesh renders, but with no texture (falls back to the flat
gray material color). `texture.ts` probes support once (cached, via a
throwaway canvas/WebGL context) and, when unsupported, CPU-decompresses the
**base mip level only** into a `DataTexture` (see BC1/BC2/BC3 formulas
below), letting the GPU regenerate the rest of the mip chain. An
**uncompressed** DDS skips this decision entirely and always uploads as a
plain `DataTexture` - it works on any GPU regardless of S3TC support, and
building a `CompressedTexture` from non-compressed mip data (an actual bug
here until the Chef/ work surfaced it - see "Known bugs" below) crashes at
GPU-upload time, not at decode time.

### Coordinate conversion (`src/rf/coords.ts`)

RF's client formats store transforms in 3ds Max space (Z-up, right-handed).
three.js is Y-up, right-handed. Both are proper rotations, so:

- Vector `(x, y, z)` → `(-x, z, y)`
- Quaternion `(x, y, z, w)` → `(-x, z, y, w)` (same permutation on the
  vector part, `w` unchanged)
- Scale: **only axis-permuted**, `(x, y, z)` → `(x, z, y)` - no sign flip
  (matches the reference Blender addon, which reuses Blender's decomposed
  scale unconverted).

## Fixed math/formulas used around the codebase

**BC1/DXT1 block decode** (8 bytes / 4×4 pixel block) - `src/rf/texture.ts`:
- `color0`, `color1` = little-endian `u16` RGB565.
- RGB565 → RGB888: `r8 = (r5<<3)|(r5>>2)`, `g8 = (g6<<2)|(g6>>4)`,
  `b8 = (b5<<3)|(b5>>2)`.
- If `color0 > color1`: 4 opaque colors, `c2 = (2·c0+c1)/3`,
  `c3 = (c0+2·c1)/3`.
- Else: `c2 = (c0+c1)/2`, `c3` = transparent black (punch-through alpha).
- 2 bits/pixel index, 16 pixels packed into one little-endian `u32`.

**BC2/DXT3 block decode** (16 bytes / 4×4 block):
- First 8 bytes: **literal**, non-interpolated alpha - 4 bits/pixel, 16
  pixels, LSB nibble of byte `i>>1` for even pixel index `i`, MSB nibble
  for odd. Expand 4→8 bit by nibble replication: `a8 = (a4<<4)|a4`.
- Last 8 bytes: a color block, decoded exactly like DXT5's (see below) -
  always 4-way interpolation, no punch-through.

**BC3/DXT5 block decode** (16 bytes / 4×4 block):
- `alpha0`, `alpha1` = `u8`. If `alpha0 > alpha1`: 8-step ramp,
  `aN = ((8-N)·a0 + N·a1) / 7` for N=1..6. Else: 6-step ramp
  (`aN = ((6-N)·a0 + N·a1)/5` for N=1..4) plus `a6=0, a7=255`.
- 3 bits/pixel alpha index, 48 bits total (split as two 24-bit halves to
  stay in safe bitwise range).
- Color block (shared with DXT3 above): **always** 4-way interpolation
  (`c2=(2c0+c1)/3`, `c3=(c0+2c1)/3`) regardless of `color0` vs `color1`
  order - unlike DXT1, neither DXT3 nor DXT5 has a punch-through color
  mode, since both carry alpha separately.

**Camera 3rd-person follow** (`src/controllers/CameraController.ts`):
- Exponential smoothing: `t = 1 - exp(-rate · delta)`,
  `FOLLOW_SMOOTHING_RATE = 4`, `CAMERA_BEHIND_ROTATE_RATE = 4`.
- `OrbitControls.update()` re-derives its orbit offset from
  `camera.position - controls.target` on *every* call, then re-adds that
  offset onto the (possibly just-changed) target - so moving `target` alone
  is a no-op for `camera.position`. To actually translate the camera while
  following, apply the same delta you just added to `target` onto
  `camera.position` too (see `orbitTargetDelta` in the update loop).

**Character movement** (`src/controllers/CharacterController.ts`):
- `walkSpeed = radius * WALK_SPEED_RADIUS_PER_SEC` (0.9)
- `arriveThreshold = radius * ARRIVE_FRACTION_OF_RADIUS` (0.04)
- `radius = max(size.x, size.y, size.z) * 0.5` from the character's
  bounding box (falls back to `1` if that's `0`)
- Turning: `quaternion.rotateTowards(target, TURN_SPEED_RAD_PER_SEC * delta)`,
  `TURN_SPEED_RAD_PER_SEC = π * 2.2`
- Animation crossfade: `CROSSFADE_SECONDS = 0.25` (`fadeOut`/`fadeIn`)

**Bot placement, sunflower/golden-angle spiral** (`src/controllers/BotController.ts`):
- `angle = index * GOLDEN_ANGLE`, `GOLDEN_ANGLE = π·(3 - √5) ≈ 2.399963 rad`
  (≈137.5°)
- `radius = RADIUS_STEP * sqrt(index + 1)`, `RADIUS_STEP = 1.6`
- Scatters any number of points from the origin with no overlap and even
  radial coverage, without needing a fixed grid size decided up front.

## Gameplay data encodings

**`Civil` per-item eligibility bitmask** (`src/rf/items.ts`): one decimal
digit per race/gender, **left-to-right in `RaceGender` enum order**
(`Bell_Male=0, Bell_Female=1, Cora_Male=2, Cora_Female=3, Accretia=4`).
Left-pad to 5 chars before indexing by `RaceGender` - real data stores this
inconsistently: `faceItem.json` unpadded (`"1"` = Accretia-only),
`gauntletItem.json` zero-padded to 8 digits with 3 unused trailing digits
(`"00001000"` = Accretia-only), and `weaponItem.json` as a **bare JSON
number** (`11111000`, not a string) rather than the zero-padded string
every other slot file uses.

**`ModelType` slot numbering** (`src/rf/items.ts`):
`Helmet=0, Face=1, Upper=2, Lower=3, Gauntlet=4, Shoes=5, Weapon=6`. Weapon
isn't part of the client's own body-part `ModelType` enum (weapons have
their own `PartType`/`Fix_Part` there) - it's numbered `6` here to match
the shop/store slot layout instead (`shopByteCode`/`Store_Code`'s
`Shop_Weapon = 6`).

**Item mesh resolution** (`src/rf/resource.ts`): two different resource
tables, picked by item category:
- Body parts → `playerResource.json`'s `Mesh` **array**
  (`{ID, BoneID, PathName, FileName, TexutrePath}[]`), indexed by `ID`.
- Weapons/shields/cloaks/etc → `itemResource.json`, a **flat object**
  keyed directly by model id string, same field shape minus the array
  wrapper.

Neither table's `PathName`/`TexutrePath` reliably names which archive
actually holds the mesh - most `itemResource.json` weapon entries just say
the bare `.\ITEM\WEAPON\MESH\` directory with no archive hint at all. So
weapon mesh/texture lookup has to **search a fixed, discovered list of
archives** in order until one contains the entry (see
`WEAPON_MESH_ARCHIVE_NAMES`/`WEAPON_TEX_ARCHIVE_NAMES` in `character.ts`):
mesh in `WEM00`-`WEM12` plus `WEVM00`/`GEM00`/`NEM00`/`ELFWPM01`/`PVPWP`/
`ORI70`/`ORI70SIEG`/`SIEGEORISS`/`75siegeMesh`/`ori6770w`; texture in the
equivalent `WET00`-`WET13` set. `WEM00`/`WET00` hold the everyday
`COM_WEAPON_*` items and are checked first.

**Weapon animation token**: parsed straight out of the *resolved mesh
filename's own naming*, not from any lookup table -
`"..._WEAPON_<TOKEN>_<number>"` (e.g. `COM_WEAPON_RKNIFE_000` → `RKNIFE`)
via `/_WEAPON_([A-Z]+)_\d+$/`. This token is exactly what the per-race
combat-animation archive keys its clip names off of, so equip-time
resolution never needs a separate weapon-type → animation-token table.

**Weapon combat clips** primarily live in `character/player/Ani/{race}COA.RFS`
(plain form + `COMBAT_STAND`; see "Directional (backward/strafe) locomotion"
below for where `MOA` also comes in - the suffix table has the full split),
and cover two shapes:
- Locomotion: `"{RACE}_COMBAT_{WALK|RUN}_{TOKEN}_NONE_01_00.ANI"` on
  **Bell/Cora** (both genders) - no directional prefix, this plain form is
  their *only* combat walk/run. **Accretia** additionally has a directional
  `"{RACE}_COMBAT_{DIR}{WALK|RUN}_{TOKEN}_NONE_01_00.ANI"` form (`DIR` ∈
  `{FW, BW, LF, RT}`) alongside the same plain one. Verified by counting:
  zero `FWWALK`/`FWRUN` entries across all of `BMCOA`/`BFCOA`/`CMCOA`/
  `CFCOA`, 56 of each in `ACCOA` (with 56 plain ones too). `getWeaponClip()`
  tries `FW{WALK|RUN}` first, then falls back to the plain form - this
  fallback is load-bearing, not defensive: without it, walk/run combat
  clips silently never resolved for 4 of 5 races (only Accretia ever
  matched), quietly falling back to the unarmed clip every time. Since the
  character always faces its travel direction, the plain form is exactly
  what "forward" needs anyway.
- Idle: `"{RACE}_COMBAT_STAND_{TOKEN}_NONE_01_00.ANI"` - no directional
  variant on any race. **Every weapon token has its own idle stance**
  (confirmed present, in some combination, for all five races), including
  `TOKEN = "NONE"` for the empty-handed War idle. Easy to miss on a first
  pass: it's absent from `MOA` entirely, only `COA` carries it.

Not every race/token combination has every clip (e.g. some heavy weapons
are Accretia-only, and not every weapon is available to every gender) -
missing falls back to the unarmed clip. There's still no combat "sit"
clip anywhere in this data set, so sitting always plays the unarmed clip
regardless of what's equipped.

**Directional (backward/strafe) locomotion is implemented**
(`CharacterController`'s `LocomotionDirection` = `'bw' | 'lf' | 'rt'`,
`ViewerScene.classifyLocomotionDirection`): holding S (backward) or
A/D-only (pure strafe) with the joystick/WASD plays a real backward/strafe
clip and keeps the character facing forward, instead of turning to face
travel direction like click-to-move and forward-dominant/diagonal input
still do. Two independent data sources feed this:
- **Unarmed** - `character/player/Ani/{race}ETA.RFS`'s `PEACE_{DIR}{WALK|
  RUN}_NONE_NONE_01_00.ANI` entries, confirmed present for **every race**
  (all 5 checked directly via RFS parsing - unlike the combat case above,
  no race caveat here). Loaded eagerly in `loadCharacter()` alongside the
  base 4 clips, keyed `walk:bw`/`walk:lf`/`walk:rt`/`run:bw`/`run:lf`/
  `run:rt`.
- **Armed (War mode)** - initially assumed Accretia-only (`COA`'s own
  BW/LF/RT/FW entries really are: confirmed 0 across Bell/Cora's `COA`
  archives, 27 of each direction in `ACCOA`'s 162 directional entries) -
  but **every race actually has full directional armed coverage**, it just
  lives in `MOA` instead of `COA` for the 4 non-Accretia races (found by
  inspecting a real `CFMOA.RFS` and noticing `CORFEMALE_COMBAT_RTWALK_
  TMACE_...`/`..._LFWALK_TSWORD_...` entries - this project's own
  `RaceAssets` wasn't even fetching `MOA` at the time, since the suffix
  table below previously (wrongly) claimed `COA` was a superset of it).
  Verified by direct count: `BMMOA`/`BFMOA` have 24 of each direction,
  `CMMOA`/`CFMOA` 23, `ACMOA` 27 - and cross-checking token sets confirms
  MOA's directional tokens are the *same* set `COA`'s plain-form tokens
  cover for that race, just truncated differently in the 32-byte name
  field (`WALK_` vs `RTWALK_` shift where the cutoff lands). `MOA` has no
  `COMBAT_STAND` at all though (0 in every archive checked), so it's only
  ever tried for directional walk/run, never as a general `COA`
  substitute. `getWeaponClip()` tries `COA` first, then `MOA`, for a
  directional lookup; `weaponClipKey()` takes an optional
  `LocomotionDirection` to key the result either way.

  `resolveClipName()`'s priority order still puts the *unarmed* directional
  clip ahead of the direction-blind plain combat clip when a directional
  armed one truly isn't found for a given race/token combo (some
  weapon/direction pairs are still missing even with MOA in the mix):
  directional-armed (COA or MOA) → directional-unarmed → plain-armed →
  plain-unarmed.

**Peace/War battle toggle** (`CharacterController.setBattleMode`, matching
the original client's battle-mode button): the token used for the combat
clip lookups above isn't just "whatever's equipped" - it's gated on this
mode. Peace always plays the unarmed clip and hides any equipped weapon
mesh (`applyWeaponVisibility`); only War plays the combat variant (walk,
run, *and* stand - see `prewarmWeaponClips`) and shows the weapon.
Empty-handed War state is real too, not a missing-clip fallback: `COA` has
dedicated `"..._NONE_NONE_01_00.ANI"` walk/run/stand entries -
`"NONE"` doubles as both "no weapon" *and* a literal weapon token value
here, so `resolveClipName()` substitutes it in whenever
`currentWeaponToken` is `null` and the mode is War. New character mounts,
and switching race in the debug panel, reset the mode back to `'peace'`
(`CharacterController.mount()`), same as the equip-slot selections.

**Per-race `Ani` archive suffix taxonomy**
(`character/player/Ani/{race}{SUFFIX}.RFS`), reverse-engineered by scanning
real entry names (not documented anywhere client-side that we've found):

| Suffix | Contents |
|---|---|
| `ETA` | `PEACE` (unarmed) stand/walk/run/sit/fly + `BW/FW/LF/RT` directional variants; common/corpse/dead poses. Currently the only archive `loadCharacter()` fetches for the base `stand`/`walk`/`run`/`sit` clips. |
| `ATA` | `COMBAT_ATTACK_{weapon}_{TOP\|MIDDLE\|BOTTOM}` - melee/ranged attack swings. |
| `COA` | Non-directional `COMBAT_{WALK\|RUN}_{weapon token}_NONE_01_00` locomotion on every race, **plus** `COMBAT_STAND_{weapon token}_NONE_01_00` (per-weapon-type idle - MOA doesn't have this at all) - and, **Accretia only**, the same set again with a `BW\|FW\|LF\|RT` directional prefix. The primary archive `getWeaponClip()` fetches (plain form + STAND, always); see `MOA` for where the other 4 races' directional walk/run actually lives. |
| `MOA` | The directional walk/run counterpart for the 4 races `COA` doesn't cover directionally (Bell/Cora, both genders) - full `COMBAT_{BW\|FW\|LF\|RT}{WALK\|RUN}_{weapon token}_NONE_01_00`, token-for-token matching `COA`'s plain-form coverage for that race - **plus** 8 redundant `PEACE_{BW\|FW\|LF\|RT}{WALK\|RUN}_NONE_NONE` entries already covered by `ETA`, and **no** `COMBAT_STAND` at all. Previously assumed to be a redundant subset of `COA` and skipped entirely (wrong - see "Directional (backward/strafe) locomotion" above for how this was actually caught); `getWeaponClip()` now fetches this too and tries it as a fallback after `COA` for any directional lookup. |
| `MEA` | `MELEE_BLOW_{weapon}_00..02` - light hit reactions. |
| `MHA` | `MELEE_DEEPINJURY_{weapon}_00..02` - heavier hit reactions. |
| `RAA` | `RANGE_AIMING{SHOT\|LAUNCHER}_{weapon}_00..` - ranged aim poses. |
| `RHA` | Presumed ranged hit-reaction equivalent of `MEA`/`MHA` - not fully inspected. |
| `GEA` | `COMMON_GESTURE_{name}_NONE_01_00` - emotes (wave, sit down, salute, cheer, ...). |
| `2CA` | `ASSISTANCE_{skill name}_{weapon}_00` - skill/force cast animations. |

**Client `IWT_*` weapon-type enum vs. the discovered animation token
prefixes** - these line up directly (info from a client header the user
supplied, `GU_DLL/Character.h`/`rf_common.bt`-adjacent):

| `IWT_*` suffix | Meaning | Animation token prefix |
|---|---|---|
| `_R` | Right hand (one-handed) | `R*` (`RAXE`, `RKNIFE`, `RMACE`, ...) |
| `_B` | Both hands (two-handed) | `T*` (`TSWORD`, `TAXE`, `TSTAFF`, `TBOW`, `TGUN`, `TRIFLE`, `TLAUNCHER`, `TFAUST`, `TMACHINEGUN`, `TFLAMETHROWER`, `TBEAMGUN`, `TBEAMRIFLE`, `TPLASMAGUN`, `TSPEAR`, `TCROSSBOW`, `TMACE`, ...) |
| `_D` | Dual-wield | `D*` (`DAXE`, `DSWORD`, `DGUN`, `DBEAMGUN`) |
| `_LT` | Left hand & throw | `*THROW` (`RAXETHROW`, `RKNIFETHROW`) |

Full enum, for reference (client-side `IWT_` constants):

```
IWT_SWORD_R 0x00   IWT_KNIFE_R 0x03   IWT_AXE_R  0x06   IWT_MACE_R 0x0A
IWT_SWORD_B 0x01   IWT_KNIFE_B 0x04   IWT_AXE_B  0x07   IWT_MACE_B 0x0B
IWT_SWORD_D 0x02   IWT_KNIFE_LT 0x05 IWT_AXE_LT 0x08
                                      IWT_AXE_D  0x09
IWT_STAFF_R 0x0C   IWT_SPEAR_B 0x0E   IWT_BOW_B 0x0F   IWT_CROSSBOW_B 0x10
IWT_STAFF_B 0x0D
IWT_GUN_B 0x11   IWT_GUN_D 0x12   IWT_RIFLE_B 0x13   IWT_LAUNCHER_B 0x14
IWT_FAUST_B 0x15   IWT_MACHINEGUN_B 0x16   IWT_FLAMETHROWER_B 0x17
IWT_BEAM_GUN_B 0x18   IWT_BEAM_GUN_D 0x19   IWT_BEAM_RIFLE_B 0x1A
IWT_BEAM_PLASMA_B 0x1B   IWT_MINING_TOOL 0x1C   IWT_FIST 0xFF
```

Client race codes (unrelated numbering to this project's `RaceGender`
enum - only used inside these legacy ID/name schemes):
`1=Bellato Male, 2=Bellato Female, 3=Cora Male, 4=Cora Female, 5=any Male,
6=any Female, 7=Bellato, 8=Cora, 9=Bellato+Cora, A=All`.

**Client `MODEL_ID` encoding** (item/resource ids like `4 0 04 54`, from the
same reference) - documented here for context, but **this project doesn't
decode it directly**; items are resolved through the pre-built
`playerResource.json`/`itemResource.json` tables instead:

```
byte 1: race/gender code (0=Bellato M, 1=Bellato F, 2=Cora M, 3=Cora F, 4=Accretia; A=all races)
byte 2: resource file group (almost always 0, except default armors = 5)
byte 3: part type - 00 helmet, 01 face, 02 upper, 03 lower, 04 gloves,
        05 boots, 06 cape, 07 shield  (or a weapon-type code for weapons)
byte 4: serial number (00-FF)
```

Example: `A00600` = an all-race cape; race-specific variants of the "same"
item share the last 4 bytes across different race-code entries
(`400600`/`100600`/`800600`/...), and the client picks the one matching the
wearer's race.

## Weapon/armor glow & particle effects (the `Chef/` pipeline)

**Partially implemented** - `public/game-assets/Chef/` now has the real
lookup tables, `.eff` files, and `Chef/Tex` glow textures (the `.spt`/
`.R3E` particle-trail layer described further down is not - see
"Implementation status" at the end). Everything below was cross-checked
against those real files, not just the community tutorial
(`Texture_and_Glow_Tutorial_-_Crowik.pdf`) this was originally researched
from - several byte offsets the tutorial's own worked example implied
turned out not to generalize; where they disagree, this doc now describes
what the real files actually contain (`src/rf/glowEffect.ts`).

There are **two independent visual systems**, easy to conflate:

1. **Per-texture glow mask** - ordinary equipment texture (armor, mostly).
   A `.RFT`/DDS texture's **alpha channel** doubles as a glow mask: wherever
   alpha is painted in, that part of the surface self-illuminates in-game
   (see the "shining edges" effect on RF armor). This is just the same
   DXT5 alpha channel `texture.ts` already decodes for ordinary
   transparency - nothing new to parse, just a different *use* of it this
   project doesn't currently act on (materials are built with plain
   `MeshStandardMaterial`, no emissive channel wired to alpha yet).
2. **The `Chef/` effect pipeline** - the real particle/aura system, used
   for weapon energy-blade effects, armor auras, etc. Multi-file, multi-hop
   (see `resolveGlowEffectPath` in `src/rf/glowEffect.ts`):

```
an item's Model id, e.g. weaponItem.json's "A10300" (a dagger) or
helmetItem.json's "50200" - the same field this project already resolves
mesh stems from (resolveItemMeshStem/resolveWeaponMesh); no decoding or
byte-reversal needed, it's used exactly as-is
  ↓ look up as the first column of a line in:
Chef/ItemEffectList.txt (plain text, whitespace-separated* - "A10300  41
  0 0 0 0 0")
  → column 2 (0-indexed: 1) gives an "effect index" (e.g. 41)
  ↓ look up that index as the leading column of a line in:
Chef/PatternList.txt (plain text, 10 columns = upgrade-level buckets:
  +0, +1..+3, +4, +5..+7, ...) - this project doesn't track item upgrade
  level yet, so it always reads column 0 (+0)
  → each column holds another index (all 10 columns are frequently
    identical, e.g. all "41" for a plain dagger with no upgrade variants)
  ↓ look up that index as the leading column of a line in:
Chef/EffectFileList.txt (plain text) - NOT just a line-number lookup, the
  real file has gaps/reordering (755 of 848 lines' own leading id disagrees
  with its line number), so this has to be a real key→value lookup, not
  array indexing
  → gives the actual .eff file path, e.g. ".\Chef\EFF\BF\WPALL.EFF" (for
    A10300) - some, but not all, .eff paths embed the same weapon-token
    vocabulary used for animation clips (TSWORD, RKNIFE, TAXE, ...)
  ↓
a .eff file (binary, fixed-size records - see below) names a glow texture
  under Chef/Tex/ (plain, unencrypted DDS - no .RFT-style XOR header) and
  how it animates
```

\* Not consistently tab-separated - at least one real line
(`"A10366  265\t0\t0\t0\t0\t0"`) uses two literal spaces where every other
line uses a tab. `glowEffect.ts` splits on any whitespace run, not a
literal tab, to handle this.

Older client tools also reference a second stage after the `.eff`
(`Chef/Particle.ini` → a `.spt` particle-template file → an `.R3E` mesh,
for full animated particle trails, not just a static glow texture) - see
"`.spt` particle template" and "Implementation status" below for why
that part isn't wired up yet.

### `.eff` file structure

Binary. File size is always a multiple of a **fixed 176-byte record**
(single-part items are exactly 176 bytes; a two-handed sword with 3
attachment points is 528 = 176×3) - confirmed across all 1151 real `.eff`
files in this project's `Chef/Eff/`. Verified byte-for-byte against three
independent real records (`Eff/BF/WPALL.EFF`,
`Eff/Weapon/COM_WEAPON_RKNIFE_144_0.EFF`,
`Eff/Weapon/Unick/Unick_RKNIFElv0.EFF`) - **this disagrees with the
tutorial's own worked example on where the two filename fields start**,
so trust this over that:

```
offset 0x00..0x02  magic "B0 00 02", identical in every record checked
offset 0x03..      "surface effect" texture filename (e.g. "BLACK.DDS" or
                    "ENV-1.BMP" - both .DDS and .BMP seen), NUL-terminated
offset variable     "glow effect" texture filename (e.g. "AURAR.DDS") -
                    the actual aura/glow overlay texture, NUL-terminated;
                    null/absent (no glow, surface-shine only) is common
                    (e.g. WPALL.EFF)

  Both filenames are NUL-terminated ASCII, but their start offsets are
  NOT fixed - they float depending on the preceding field's length (a
  14-char name pushes the next field's start later than a 9-char one
  does). Between and after them, unused buffer space is filled with
  0xCD (MSVC debug-heap "clean" pattern) or occasionally zero, not real
  data - parse by scanning for the next run of ≥4 printable-ASCII bytes
  followed by NUL, not by fixed offset (see readNextString).
  A literal ".\CHEF\TEX\" (or ".\\CHEF\TEX\", a double backslash form
  also seen) path-prefix string follows both names, before offset 0x40 in
  every record checked - cosmetic, not needed (Chef/Tex/ is already known).

offset 0x4E        "speed" byte - base value 0x40 (64); the tutorial
                    claims each +1 roughly doubles the glow animation's
                    playback speed (0x41 = 2x of 0x40, 0x42 = 2x of 0x41).
                    Fixed absolute offset regardless of the variable-length
                    fields before it - confirmed identical position (0x4E)
                    across all three independently-checked real files.
offset 0x53        "movement" byte - selects how the glow texture itself
                    animates on the surface. Both real weapon examples
                    checked use movementMode 2:
                      00 = static (no movement) - e.g. WPALL.EFF
                      01 = cyclic vertical+horizontal distortion
                      02 = scrolling (the common case for weapon glows -
                           only this mode is actually animated by
                           buildGlowOverlay right now, see below)
                      03 = cyclic vertical+horizontal distortion (variant)
                      04 = strong metallic-sheen animation over the whole
                           surface
                      05+ = static
```

Some records (e.g. a monster's `CALLIANAATROC.EFF`) have **no texture
names at all** - just an internal ASCII label near the record's tail
(`EFFECT2`, `EFFECT4`, ...) naming which attachment socket the (empty, in
that file) section applies to. These match `effect1`/`effect2`-style empty
dummy sub-objects already observed in real weapon `.msh` files while
investigating the weapon-placement bug earlier in this doc - those dummies
are exactly the attachment sockets multi-record `.eff` files target, one
record per socket. `parseEffFile` (glowEffect.ts) returns a section with
both texture fields `null` for these rather than treating them as
malformed.

### `.spt` particle template - full key reference

Plain text, not binary - e.g.:

```ini
[Particle]
entity file .\Chef\Unick_up\C_W_TSPEAR\158p\Ring.R3E
num 15
pos box 0 0 0
live time 3
time speed 1
gravity -4 0 0
start_scale 0.5
start_color 213 244 208
start_alpha 0
start_zrot rand(-360,360)
alpha_type 3
z_front -0.1

time 0.5
    alpha 200
    zrot rand(-30,20)
    color 51 102 255
    scale 2.5

time 1
    alpha 150
    zrot rand(-10,10)
    color 51 102 255

time 3
    color 51 102 255
    zrot rand(-60,60)
    scale 8
    alpha 0

end
```

| Key | Meaning |
|---|---|
| `entity file` | Path to a `.R3E` file - a small 3D mesh (not a 2D sprite) used as the actual particle shape, e.g. a glowing ring/orb. `.R3E` is the same extension used for map entity files elsewhere in the client - likely a shared "placed 3D object" format, not particle-specific. |
| `num` | How many instances of the entity to spawn per emission. |
| `pos box x y z` | Spawn position offset. |
| `live time` | Lifetime multiplier - e.g. `1.2` scaled by a `2` setting elsewhere halves duration to `0.6`s (relationship is a multiplier, not literal seconds, per the tutorial's own correction). |
| `time speed` | Playback rate while visible. |
| `gravity x y z` | Force applied over the particle's life - lower magnitude = spreads/flies further, higher = falls/stops sooner. |
| `start_scale`, `start_color`, `start_alpha`, `start_zrot` | Initial size, RGB color (0-255 each), alpha, and Z-axis rotation (`rand(min,max)` for randomized start rotation). |
| `alpha_type` | Blend/alpha mode selector (enum, values not enumerated by the tutorial). |
| `z_front` | Unknown - tutorial author didn't know either. |
| `time <t>` block | A keyframe at t seconds; any of `alpha`/`zrot`/`color`/`scale` inside it overrides that attribute from that time onward (sparse - a block only needs to list the attributes it changes, per the "not exactly all commands" example: the `time 1`/`time 3` blocks above omit `scale`/others they don't touch that keyframe). |
| `end` | Terminates the particle definition - required. |

### `.R3E` particle-shape mesh (`src/rf/r3e.ts`)

Unlike everything else in this doc, this format wasn't reverse-engineered
from scratch - the user pointed at a reference Blender addon already
vendored into this repo
(`extra/cbb-rf-online-addon-main/cbb_rf_online_addon/r3e.py` +
`rf_shared.py`/`utils.py`) with a working importer. `r3e.ts` is a direct
port of its field layout and math, scoped to static geometry only (see
below) - not an independent derivation, so trust the Python source over
this summary if they ever disagree.

**Container**: `u32 version` (113 in every file seen - the parser only
warns, doesn't reject, on a mismatch) + `u32 identity` (unused) + a
**chunk table**: 10 `(u32 offset, u32 size)` pairs, each chunk
independently addressable by its own offset (not a sequential cursor read)
- `CompHeader, Vertex, VColor, UV, Face, FaceId, VertexId, MatGroup,
Object, Track`, in that order. `CompHeader` is always exactly 38 bytes;
everything else scales with mesh complexity.

- **CompHeader**: `u16 vectorDataType` (selects the Vertex chunk's packing
  - see below) + 12 reserved bytes + `vec3f refPos` (raw, **not**
  coordinate-converted - it's a decompression reference point in the same
  raw space the compressed vertex bytes are) + `f32 refScale` + `f32
  uvMin` + `f32 uvMax` (`uvScale = (uvMax-uvMin)/2`, `uvPos = uvMin +
  uvScale`, used to decompress the UV chunk below).
- **Vertex**: packing depends on `vectorDataType` - `0x8000` = 3 signed
  bytes/vertex (`v = (i8/127)*refScale + refPos[axis]`), `0x4000` = 3
  signed shorts/vertex (`v = (i16/32767)*refScale + refPos[axis]`, 6
  bytes), anything else (0 in every file seen) = plain `vec3f`, no
  decompression. Only *after* decompression does the Unity→three.js
  conversion below apply.
- **UV**: 2× `i16`/entry (4 bytes) - `u = (i16/32767)*uvScale + uvPos`,
  `v = 1 - ((i16/32767)*uvScale + uvPos)` (same top-down V-flip convention
  as `mesh.ts`).
- **Face**: `{u16 vertexAmount, u32 vertexStartId}`/entry (6 bytes) - a
  polygon (not necessarily a triangle - fan-triangulated when building the
  final mesh), whose corners are `vertexStartId .. vertexStartId+
  vertexAmount-1` **into the FaceId/VertexId indirection below**, not
  directly into Vertex/UV.
- **FaceId**: `u16`/entry (2 bytes) - one material group's face range
  (`startingFaceId .. startingFaceId+numberOfFaces-1`) indexes *this*
  array to get the real index into `Face`.
- **VertexId**: `u16`/entry (2 bytes) - a face's per-corner indices
  (`vertexStartId+j`) index *this* array to get the real index into
  `Vertex`; the *same* `vertexStartId+j` position indexes directly into
  `UV` (UV is parallel to per-face-corner slots, not per unique vertex).
- **MatGroup**: `{u16 numberOfFaces, u32 startingFaceId, i16 materialId,
  u16 animatedObjectId, i16[3] bboxMin, i16[3] bboxMax}`/entry (22 bytes).
  `materialId == -1` groups are skipped entirely (no material = not
  rendered); `animatedObjectId != 0` marks a group as belonging to a
  separately-animated sub-part rather than the static mesh.
- **Object**/**Track**: per-material-group animation (keyframed position/
  rotation/scale for a moving sub-part, e.g. an orbiting piece) - present
  in the format, **not parsed** by `r3e.ts` (see scope note above the
  format section). Skippable without misaligning anything else since every
  chunk is independently offset-addressed.

**Coordinate space**: R3E's source engine used a Y-up, left-handed
authoring space (the reference addon labels it "Unity"), not the Z-up,
right-handed 3ds Max space `coords.ts` converts for every other format in
this project. Derived (see `r3e.ts`'s own comment) by chaining the addon's
proven Unity→Blender step with the standard Blender→three.js step, which
telescopes down to a plain Z-negation for vectors - matching the
well-known "Unity ≈ three.js with Z flipped" relationship as a sanity
check on the derivation.

**Verified**: parsed 8 real files spanning every distinct shape in
`Chef/`'s particle set (a 2-triangle flat `aura.R3E` "glow quad" template,
up through a 152-triangle hammer glow mesh) - every one produced a sane
triangle count, a bounding box shaped like its name implies (the bow/
blade/spear meshes are all elongated along one axis matching the weapon's
actual long axis; `aura.R3E` is a thin ~1-unit flat quad), and UVs that
stay within `[0,1]`. No visual/rendered confirmation yet (that needs the
`.spt` spawner - see below), but the numbers check out.

### Implementation status

**Built**:
- `src/rf/glowEffect.ts` (wired into `CharacterController`): the full
  `Model id → ItemEffectList → PatternList → EffectFileList → .eff` chain,
  `.eff` parsing (both texture names + speed + movement byte), and a
  static/scrolling glow-texture overlay - `buildGlowOverlay()` clones
  every renderable in an already-equipped slot's object tree (skinned
  meshes stay bound to the same skeleton via an identity `bindMatrix`,
  same reasoning as `character.ts`'s own skinning code; rigid meshes get
  an identical local transform under the same parent bone) into an
  additively-blended sibling mesh, so it deforms identically to the part
  it's glowing on top of. Movement mode 2 (scrolling - the common case)
  animates via `material.map.offset.x` in
  `CharacterController.updateGlowAnimation()`; modes 0/1/3/4 currently
  render as a static (non-animated) glow texture - a deliberate v1
  simplification, not a parsing gap, since only mode 2 was observed in the
  real weapon files checked while building this. Applies uniformly to any
  equip slot (armor and weapons alike - Model-id lookup works the same for
  both, confirmed against real ids from both `helmetItem.json` and
  `weaponItem.json`), and a weapon's glow overlay follows the base weapon
  mesh's own Peace/War visibility (`applyWeaponVisibility`).
- `src/rf/r3e.ts`: static-geometry parsing only, verified against real
  files as described above.
- `src/rf/particleTemplate.ts`: `.spt` text parser - see the format
  section above for what real files turned out to need beyond the
  original key reference (underscored keys, `;` comments, `rand(min,max)`
  on nearly any field, the `no_billboard`/`free` flags). Verified against
  3 real files.
- `src/rf/particleSystem.ts` (`ParticleEffect`): the actual spawner -
  resolves a `.spt` + its `.R3E` entity mesh, builds `num` instances (each
  its own `MeshBasicMaterial`, additive-blended, sharing one `BufferGeometry`
  built from the parsed R3E), and each frame samples every instance's own
  independently-`rand()`-resolved keyframe curve (piecewise-linear,
  resolved once at spawn - see `resolveKeyframes` - not re-rolled every
  frame) for alpha/color/scale/zrot, drifts position by `gravity * age`,
  and loops `age = simTime % liveTime`. Billboarding (the default per
  `particleTemplate.ts`) is done via `Object3D.quaternion.copy(camera.
  quaternion)` in `update()`, which the caller must pass a camera into for
  billboarded templates to face it correctly - `null` is accepted (skips
  billboard orientation) since not every call site necessarily has one
  handy. Verified with a Node-based structural test: instance count,
  gravity-drift position, and keyframe-interpolated scale/alpha all
  hand-checked against the parsed template's own numbers across several
  simulated frames (including wrap-around past `liveTime`), matching
  exactly. One real bug caught this way: particle colors need explicit
  `SRGBColorSpace` when constructed from RF's raw 0-255 RGB bytes -
  three.js's default `Color` constructor treats components as already
  linear-workingspace, which visibly shifted the color (confirmed
  numerically: `(0,100,250)` round-tripped to hex `0064fa` only after the
  fix, `9678ff` before). No visual/rendered confirmation yet - only
  Node-level structural/numeric checks, same caveat as `.R3E` above.
  **Not yet wired into anything that equips/plays automatically** - nothing
  currently constructs a `ParticleEffect` from `CharacterController` or
  anywhere else in the live app; a caller has to build one and call
  `.load()`/`.update()` itself.

**Not built**:
- `.eff`'s reversed-hex particle-index byte pair (the field that would
  link a weapon's `.eff` to a specific `.spt`) was never actually
  confirmed against a real file's bytes, unlike everything else `.eff`
  parses. This is the missing link for automatic wiring: without it,
  there's no verified way to go from "this weapon is equipped" to "spawn
  this specific `.spt`" - a `ParticleEffect` has to be pointed at a known
  `.spt` path manually for now. Chef/'s `Entity.ini` (a similar
  `INDEX → .R3E` table, simpler than `Particle.ini`+`.spt`, no
  keyframes/spawning) was also found while researching this - real weapon
  glow shapes like `55hammer.R3E`/`blade.R3E`/`55bow.R3E` aren't referenced
  by any `.spt` in this asset drop, only by `Entity.ini`, suggesting they
  reach the screen through a different mechanism than the particle-burst
  path this section built. Unconfirmed which subsystem actually uses
  `Entity.ini` or how a `.eff` (or anything else) would pick an `INDEX`
  into it - noted for whenever that gets picked back up.
- `.R3E`'s VColor chunk and the Object/Track (animated sub-part) chunks -
  see the format section above.
- `.rpk` - the archive format some of `Chef/` ships wrapped in. This
  project's copy came already unpacked into loose files, so `.rpk` support
  has turned out to be unnecessary so far.

## Known bugs already fixed here (don't reintroduce)

- **`new THREE.Color(r, g, b)` treats its components as already in the
  linear working color space**, not sRGB - constructing a color directly
  from RF's raw 0-255 RGB bytes (`r/255, g/255, b/255`, as `particleSystem
  .ts`'s particle colors and any similar raw-byte color this project reads
  do) visibly shifts hue/brightness versus the source values. Confirmed
  numerically: `(0, 100, 250)` round-tripped through `Color` and back to
  hex came out `0064fa` (correct) only after using
  `new Color().setRGB(r/255, g/255, b/255, SRGBColorSpace)` instead of the
  plain constructor, which gave `9678ff`. Matches this project's existing
  convention of setting `texture.colorSpace = SRGBColorSpace` explicitly
  on textures (`texture.ts`) rather than relying on three.js's default.
- **A rigid mesh sub-object's `parentName` can point at another
  sub-object, not just a skeleton bone** - `buildObjectsFromParsedMesh`
  only ever checked skeleton bone names, so a part chained to a sibling
  (e.g. a staff's head parented to its own stick, not straight to the hand
  bone) fell through to the "no parent found" case: decomposed its raw
  `objectMatrix` directly and got added under the character's root instead
  of the sibling. At rest this silently placed it >2 units from where it
  should be (measured on a real file, `BELCOR_WEAPON_TSTAFF_135.msh`) -
  and since the root doesn't move while the actual wielding bone does, the
  gap only grew as the character animated, reading as the head visibly
  "breaking apart" from the stick mid-motion. Fix: also try resolving the
  parent among already-processed sub-objects from the same file (by name),
  using the parent's own raw `objectMatrix` the same way a bone's
  bind-pose inverse is used - both live in the same shared per-file
  reference space, so the relative transform cancels out correctly either
  way.
- **Hand-copied `RGBA_S3TC_DXT*_Format` numbers were wrong** (off by one
  for DXT3/DXT5 - `texture.ts` had 33776/33777/33778 for DXT1/DXT3/DXT5;
  the real three.js values are 33776/33778/33779, and DDSLoader emits
  `RGB_S3TC_DXT1_Format`=33776 for DXT1, never the also-real-but-unused
  `RGBA_S3TC_DXT1_Format`=33777). Import these from `'three'` directly,
  never hand-copy them again. Impact was silent and easy to miss: on a
  device *with* S3TC support the raw DDS format value is passed straight
  into `CompressedTexture` regardless of this constant, so desktop never
  showed a symptom - but the mobile CPU-decompression fallback's format
  check used this constant to decide whether to engage at all, so real
  DXT5 textures on an S3TC-*unsupported* device (most mobile GPUs) skipped
  the fallback and fell through to building a `CompressedTexture` anyway,
  which fails at GPU-upload time. This was a latent bug in the original
  mobile-texture-support work earlier in this project, not something the
  Chef/ work introduced - it surfaced now because Chef/'s glow textures
  happened to include a real DXT3 file, prompting a from-source check of
  what DDSLoader actually emits, and Node-based testing (used throughout
  this project to sanity-check texture decoding) can never catch this
  class of bug: it only exercises texture *construction*, not the real
  GPU upload where a wrong format actually breaks.
- **Building a `CompressedTexture` for a DDS that isn't actually
  block-compressed** (an uncompressed 24bpp/16bpp DDS, format
  `RGBAFormat`=1023) crashes three.js deep inside `WebGLTextures.
  setTexture2D`/`uploadTexture` with `Cannot read properties of undefined
  (reading 'width')` - a `CompressedTexture`'s upload path iterates
  `texture.mipmaps` expecting genuine compressed-block mip objects, which
  uncompressed DDS data isn't shaped like. Check whether
  `ddsData.format` is actually one of the known S3TC compressed formats
  before deciding between `CompressedTexture` and a plain `DataTexture` -
  don't infer "must be uncompressed" purely from "isn't DXT1/DXT5", and
  don't assume every DDS in a given asset folder uses the same handful of
  formats already verified elsewhere (character `.RFT` textures are
  DXT1/DXT5 only; `Chef/Tex/` glow textures additionally include DXT3 and
  outright uncompressed DDS).
- **`SkinnedMesh.bind(skeleton)` with no explicit `bindMatrix`** calls
  `skeleton.calculateInverses()` internally, using the bones' *current*
  world matrices - and `Skeleton` is one object shared by every body-part
  mesh, so this silently corrupts `boneInverses` for every already-equipped
  part, not just the one being bound. Harmless at initial load (nothing's
  animated yet, so "current" happens to equal bind pose), but equipping an
  item later while mid-animation overwrote `boneInverses` with garbage and
  broke the whole character. Fix: always pass an explicit identity
  `Matrix4` as `bindMatrix` - vertex data is already baked into bind/world
  space at parse time (see the `.msh` section above), so identity is
  exactly correct.
- **Rigid part placement must use `skeleton.boneInverses[parentIndex]`**
  (the fixed bind-pose inverse computed at skeleton construction), never
  the parent bone's live `matrixWorld` - equipping can happen well after
  the character started animating, by which point the bone has moved from
  its bind pose, and mixing a bind-pose `objectMatrix` with a posed bone
  matrix computes a bogus static offset that then gets carried along as the
  bone keeps animating (the part visibly flies around).
- **`OrbitControls.target` alone doesn't move the camera** - see the
  "Camera 3rd-person follow" formula above.
- **Weapon placement must use Accretia's skeleton for the rigid bind-pose
  inverse, not the wielding character's own** - every weapon mesh is
  authored against Accretia's skeleton regardless of race; see the `.bn`
  section above for the full writeup and the measured proof.
- **Combat walk/run lookup needs a non-directional filename fallback** -
  only Accretia's `COA` archive has the `FWWALK`/`FWRUN`-prefixed form;
  Bell/Cora only ever have the plain `WALK`/`RUN` form. Querying only the
  `FW`-prefixed name (as the animation's own naming convention elsewhere
  might suggest) silently finds nothing for 4 of 5 races - the walk/run
  clip just never left the unarmed one, no error, no warning. See "Weapon
  combat clips" above.
- **Rigid weapon retargeting (`getCorrectedRigidBindInverse`,
  `character.ts`) must compare the wielder's own attach bone directly
  against Accretia's same bone - not go up one level to the attach bone's
  *parent* and reconstruct from there.** A weapon's `objectMatrix` is
  authored against Accretia's bind pose, so retargeting it onto another
  race's own attach bone (e.g. "Bip01 R Finger0") needs a rotation
  correction for however that race's bind-pose arm differs from
  Accretia's - real and large (confirmed by parsing every race's `.bn`:
  20-40° at Finger0's *accumulated world* rotation vs Accretia's, though
  each race's *local* Finger0-relative-to-its-own-hand rotation is much
  closer, only 2-7° apart). The first fix version used that near-agreement
  to justify correcting via the attach bone's parent (the hand) and
  reusing Accretia's own Finger0-relative-to-hand local rotation on top -
  reducing the error a lot, but not to zero, and the *leftover* 2-7°
  residual varied by race (worse for Cora than Bell). That residual is
  what broke a from-then-derived empirical weapon-shape correction (see
  "Empirical weapon placement fixups" below): measured on one race, it
  silently absorbed that race's own leftover retargeting error along with
  the weapon's genuine authoring quirk, and came out wrong when reapplied
  to a race with a different leftover error. Comparing the attach bone
  itself directly - "substitute the wielder's own bind-pose rotation for
  this exact bone in place of Accretia's, position/scale otherwise
  unchanged" - eliminates the retarget rotation error entirely rather than
  merely reducing it: verified numerically at ~0.003° (floating-point
  noise) across Bell/Cora Male/Female, down from the 2-7° the
  parent-based version left. Simpler code, too - no grandparent bone
  lookup needed at all.
- **The `%wpedit` gizmo (`ViewerScene.syncWeaponEditTarget`) must
  re-attach every frame, not just once when `%wpedit 1` is sent** -
  equipping a *different* weapon while the gizmo is already attached to
  the previous one disposes that previous mesh object out from under it
  (see `equipWeapon`'s dispose call on the old `equippedObjects[Weapon]`).
  Without a per-frame re-check, the gizmo (and `WeaponEditPanel`'s
  readout) kept pointing at the disposed object - silently showing the
  *previous* weapon's name/token/transform while a completely different
  weapon was actually equipped and visible, which read as "the fixup
  isn't working" when the panel was actually just never looking at the
  weapon on screen. Fixed by comparing
  `characterController.getEquippedWeaponObject()` against the
  currently-attached target once per frame (cheap - a reference
  comparison, no-op unless the equipped weapon actually changed) and
  re-attaching (with a fresh "Original" capture) whenever it differs,
  rather than only on the `%wpedit 1` transition.

## Empirical weapon placement fixups

`character.ts`'s `WEAPON_PLACEMENT_FIXUPS` is a per-`weaponToken` local
position/rotation correction layered on top of
`getCorrectedRigidBindInverse`'s computed placement, for weapons whose
`.msh` data just doesn't line up with the generic retargeting math even
once that math is as exact as it can be (a genuine per-mesh authoring
quirk, not a bug this project's code can derive from first principles).
Found via the in-app `%wpedit 1` gizmo (`ViewerScene`/`WeaponEditPanel`,
Blender-style move/rotate handles on the equipped weapon): drag to the
visually-correct placement, read the panel's "Original"/"Edited"
Euler-degree transforms, and convert to a *quaternion* delta -
`fixupQuat = originalQuat⁻¹ · editedQuat` - not a bare per-axis degree
subtraction, which stops being accurate once the correction is more than
a few degrees.

Keyed by `weaponToken` alone, not by race - a correction found this way is
expected to hold across every race now that the underlying retargeting
leaves no race-dependent residual for it to accidentally absorb (see the
bug entry above for the incident that first suggested otherwise, and the
actual root cause it turned out to trace back to).
