# Monster/NPC pipeline

How RF Online's monster client assets (`.msh`/`.bn`/`.RFT`/`.ani`, same binary
formats `docs/rf-format-notes.md` documents) get turned into real, animated
glTF models and previewed in the debug viewer - the conversion scripts, the
runtime loader/controllers, and every non-obvious bug found (and fixed)
along the way. Written for whoever builds the next NPC-adjacent feature
(a real spawn-driven NPC/mob system, melee/ranged combat, loot, etc.) so
they don't have to re-derive any of this.

Source of truth is always the code (`scripts/monster_to_gltf.py`,
`scripts/unpack_and_convert_monsters.py`, `src/rf/monster.ts`,
`src/controllers/Monster*.ts`) - this file can drift; if something here
disagrees with the code, trust the code and fix this doc.

## Why monsters are a separate pipeline from player equipment

`scripts/msh_to_gltf.py` (player body/weapon/cloak `.glb`s) exists because
equipment has no skeleton of its own - every rigid/skinned part attaches
onto the *player's* already-loaded humanoid skeleton at runtime, so that
exporter emits a flat scene of loose nodes (`extras.parentName` instead of
real glTF hierarchy) and per-primitive local joint tables the live
`character.ts` resolves by bone *name* against whatever skeleton it already
has built.

A monster has its own standalone skeleton (`.bn`) that's never shared with
anything else. There's nothing to attach to at runtime, so the natural
shape is a normal, self-contained rigged glTF character: real
`skins`/`joints`/`inverseBindMatrices`, real node parent/child hierarchy,
and every `.ani` state embedded as a real glTF animation targeting the
skeleton's own bone nodes by name. The live side is then just a stock
`GLTFLoader` + `AnimationMixer` (see `src/rf/monster.ts`) - no bone-name-
resolution-against-a-shared-skeleton machinery needed at all. This is
`scripts/monster_to_gltf.py`, a sibling to `msh_to_gltf.py` that imports its
low-level pieces (binary reader, `.msh`/`.ani` parsing, texture decode,
coordinate conversion) rather than re-deriving them, but has its own glTF
builder (`MonsterGlbBuilder`) and skeleton parser.

## Raw asset layout and unpacking

A raw monster dump (e.g. a `cdn_upload/Monster` staging folder) has
`Mesh/`, `Tex/`, `Ani/`, `Bone/` subfolders. `Bone/` ships fully loose
(`.bn`+`.BBX` per monster); `Mesh/Tex/Ani` are a mix of already-loose files
and per-family `.RFS` archives that still need unpacking.

`scripts/unpack_and_convert_monsters.py` step 1 unpacks every `.RFS` under
each of the three folders **in place**, via `extract_rfs.py`'s own
`extract_flattened` (one call across *all* archives in a category, not one
call per archive) - same approach this project already uses for
weapons/armor/cloak, with the same accepted risk: the archive format's
32-byte name-field truncation means a genuinely different file from a
different archive can rarely collide with an identical-looking truncated
name from another; `extract_flattened` detects this (logs it, keeps the
first) rather than silently overwriting, but doesn't retry with the
untruncated name. Check the printed `[COLLISION]` lines after a fresh
unpack; re-extract just the affected archive on its own
(`extract_rfs.py archive ... --out <elsewhere>`) if a monster you actually
care about got shadowed this way.

## The real animation-state vocabulary

Monster `.ani` files are named `{stem}_{STATE}_{NN}_{NN}.ANI`. Don't assume
the small set you can see on one test monster is the full vocabulary -
`monster_to_gltf.py`'s `DEFAULT_STATES` was originally built from a single
stationary-turret test case and silently missed `PEACEWALK`/`WARWALK`
(among others) because that one monster had no walk cycle to reveal the
gap. The real, scanned-from-~6000-files vocabulary (22 states, after
dropping two confirmed-redundant typo'd duplicates - `WAREIDLE` and
`WARFORCEAUPPORT`, each verified to always sit alongside a correctly-spelled
`WARIDLE`/`WARFORCESUPPORT` for the same monster) is:

```
PEACEIDLE, PEACESTAND, PEACEWALK, PEACERUN, PEACEDAMAGE, PEACECRITICAL,
PEACEDIE, PEACECORPSE, WARIDLE, WARSTAND, WARWALK, WARRUN, WARATTACK,
WARDAMAGE, WARCRITICAL, WARPOWERUP, WARFORCEATTACK, WARFORCESUPPORT,
WARAIDSKILL, WARSKILL, WARDIE, WARCORPSE
```

Not every monster has every state - `find_ani_file` prefix-matches
case-insensitively and tolerates gaps. If a future feature needs a state
not in this list, re-scan the real `Ani/` folder rather than guessing
(`monster_to_gltf.py`'s own module docstring/`DEFAULT_STATES` comment has
the one-liner used to do this).

## Bugs found (and fixed) building this - useful to remember, not just history

Every one of these was invisible on the *first* test monster tried and
only surfaced once a wider variety of real monsters got converted - a
reminder to test against several structurally different monsters (one with
a weapon, one with a mirrored limb, one with many textures) before trusting
a monster-pipeline change, not just whichever one happens to be handy.

**Rigid parts (held weapons, sockets) need bind-pose-inverse math, not a raw
copy of `object_matrix`.** A rigid sub-object's `object_matrix` is bind-pose
data in the *whole skeleton's* shared reference space, not already relative
to whatever bone it's about to be parented onto. Using it directly as the
new child node's local transform double-applies the parent's own placement
on top of an already-absolute position - reported as weapons/sockets
scattered far from the body. Fix: `local = boneBindPoseInverse *
objectMatrix` (and the sibling-chain equivalent, `sibling.objectMatrix^-1 *
objectMatrix`, when a part is parented to another mesh sub-object instead
of a bone) - exactly the same math `character.ts`'s
`getCorrectedRigidBindInverse`/`buildObjectsFromParsedMesh` already uses for
player-equipped weapons, minus the cross-skeleton retargeting correction
that only exists there because a player weapon is authored against one
fixed reference race skeleton regardless of who wields it (a monster's own
mesh and skeleton are one self-contained unit, so there's no separate
reference skeleton to retarget from).

**One texture per monster is wrong - resolve per sub-object.** Unlike a
single equipment item, a monster mesh routinely has several distinct
textures across its sub-objects (confirmed real: `BLOODAXE` has 4 - body,
armor, teeth, held axe). Picking one texture globally (whichever sub-object
happens to come first in file order) applies that texture to the entire
model - looks like "wrong/garbled texture" wherever the first object
happens to be some small unrelated detail piece. Fix: resolve a material
per sub-object via its own embedded `texturePath`, cached by resolved file
path so repeated textures (the common case) still only decode once.

**Bone scale must go through the same `convert_matrix()` mesh objects use -
not `skeleton.ts`'s own scale handling.** `src/rf/skeleton.ts`'s
`parseSkeleton` converts a bone's position/rotation but leaves its
decomposed scale completely unconverted/unpermuted. That's never been a
real bug in the live player-skeleton code path only because every real
player `.bn` bone has scale `(1,1,1)` - an untested corner case, not a
proven reference. A monster skeleton routinely has non-trivial (including
*negative*, for a mirrored L/R limb bone) per-bone scale, which is exactly
where that shortcut breaks - reported as feet/limbs snapping to the wrong
angle. Fix (`monster_to_gltf.py`'s `parse_skeleton`): run the raw local
matrix through `msh_to_gltf.py`'s `convert_matrix()` (decompose → convert
each component including scale's axis permutation → recompose → decompose
again for the TRS fields), the same function already proven correct across
every real (frequently mirrored) mesh object matrix in the equipment
pipeline, instead of hand-converting position/rotation only.

**A mirrored bone's own `.ani` rotation keyframes use a different
convention than its `.bn` bind pose - needs a per-bone correction
quaternion.** This is the subtle one. A bone authored with negative
bind-pose scale (to mirror an entire child subtree - e.g. a dragon's wing
root, confirmed on real `DRACO` data) has its bind pose fixed correctly by
the `convert_matrix()` fix above, but its *animated* rotation keyframes
still come out wrong: converting them with the exact same
`convert_quat`+conjugate formula every ordinary bone uses produces a valid
rotation, just not the one that combines correctly with that bone's own
negative scale. Confirmed empirically, not guessed: `DRACO`'s two wings
share byte-identical relative-to-parent keyframe data in their child bones
(proving the animation was authored as true mirror images of each other),
which makes this a checkable constraint - the mirrored wing's children only
land in the correct mirrored world position once the *root* bone's every
converted rotation keyframe is additionally right-multiplied by one
constant correction quaternion, per bone.

That correction is solvable in closed form from an already-proven
invariant (`animation.ts`'s own `dropAnchorFrame` doc comment, confirmed
true for every ordinary bone): a clip's frame-0 keyframe always equals the
bone's own bind pose exactly (it's a static anchor, not real motion). So
`correction = conjugate(convertedFrame0) * bindQuat`, applied as
`corrected = rawConvertedKeyframe * correction` (right-multiply - verified
empirically; left-multiply gives a much worse, still-visibly-wrong result).
For an ordinary bone `frame0` already equals `bindQuat`, so this correction
comes out to identity automatically - nothing needs to know in advance
which bones are mirrored. See `compute_bone_animation_corrections` in
`monster_to_gltf.py`, computed once per monster (any clip that happens to
animate a given bone gives the same correction, so a two-pass structure -
parse every clip first, then build channels - is needed so the correction
is known before any channel gets built, not just for whichever clip
happens to reveal it first).

**Yaw sign convention: local forward is world `(0,0,-1)`, not `+Z`.**
`src/net/compassRotation.ts`'s `rotationToYaw`/`continuousRotationFromVector`
is the proven reference for this project's own yaw math (`facing =
(-sin(yaw), -cos(yaw))`). Steering a monster toward a point needs
`yaw = atan2(-dx, -dz)`, not the more "obvious" `atan2(dx, dz)` (which
assumes `+Z` forward and points every wandering instance exactly backwards
from its travel direction - see `MonsterController.update`'s own comment).

## Runtime: loading and controllers

`src/rf/monster.ts` - `loadMonsterManifest()` (fetches
`manifest.json`, the list of successfully-converted stems, written by
`unpack_and_convert_monsters.py`), `loadMonster(name)` (fetches+parses one
`.glb` via `GLTFLoader`, cached per name), `instantiateMonster(asset)`
(clones a fresh, independently-animatable instance via three.js's
`SkeletonUtils.clone` - **not** plain `Object3D.clone()`, which does not
correctly re-bind a `SkinnedMesh`'s skeleton).

**Important shared-resource gotcha**: `SkeletonUtils.clone()` only clones
the lightweight bone hierarchy and mesh wrappers - the underlying
geometry/material/texture stay shared with the original `MonsterAsset`
*and every other spawned instance of the same monster*. `MonsterController.
dispose()` deliberately does **not** dispose geometry/material/texture for
exactly this reason (see its own doc comment) - only `scene.remove()` +
stop the mixer. There is currently no "unload this monster asset entirely"
path; the cached `MonsterAsset`/GPU resources live for the page's lifetime
once loaded, same as this project's other pooled-resource caches (e.g.
`character.ts`'s pooled weapon textures).

`src/controllers/MonsterController.ts` - one spawned instance: mount,
`playClip(name)` (loops, for manual inspection or automatic wander-driven
idle), `moveTo(target)`/`isMoving()`/`update(delta)` (turn-then-walk
steering, speed/turn-rate/arrival-tolerance all scaled off a bounding-sphere
radius computed once at mount - same formula `CharacterController` uses for
the player, so a huge monster doesn't crawl and a tiny one doesn't overshoot
its target every step). `playIdleRandom()` picks randomly between the
current mode's `STAND`/`IDLE` clip (whichever this specific monster
actually has - not every monster has both), falling back to the other
mode's pair if this mode has neither. A monster with no walk clip at all
for either mode just idles in place forever rather than sliding around on
a frozen pose (`moveTo` is a no-op for it).

`src/controllers/MonsterBotController.ts` - owns every `%moncall`-spawned
instance: sunflower-spiral spawn placement (own anchor point, offset from
`BotController`'s own spiral so a monster spawn doesn't land on top of
player-character bots), and real wandering (home + randomized per-instance
pause, same shape as `BotController`'s bots) - each hop plays the current
mode's walk clip, arriving picks a random `STAND`/`IDLE`. `setClipForAll`/
`setModeForAll` broadcast to every currently-spawned instance regardless of
type, silently skipped per-instance if that clip doesn't exist there.

## Debug UI (`%moncall`)

`ViewerScene.runCommand`: `%moncall <count> <monsterName> [peace|war]` (mode
optional, defaults to peace) and `%clearmonsters` - same shape as
`%addbot`/`%clearbots`. `%mon 1`/`%mon 0` (handled in `RfViewer.tsx`,
alongside its other UI-only toggles) shows/hides `MonsterPanel` - a
searchable monster picker (`SearchableSelect`, same component `EquipPanel`
uses for items), a Peace/War mode select, a count field, Spawn/Clear
buttons, and a manual clip-preview dropdown that broadcasts to every
currently-spawned instance. The panel is centered on screen by default and
drag-repositionable (pointer-capture based, switches from the centered CSS
`transform` to explicit pixel `left`/`top` once dragged) rather than pinned
to a corner like the other debug panels, so it can be moved out of the way
of whatever's being inspected.

## Server-authoritative monster lifecycle (backend + real runtime)

Everything above is the asset pipeline. This section is the actual gameplay
layer built on top of it in the `rfworld` backend repo (Go) plus this repo's
real (non-debug) rendering path - as opposed to `%moncall`, which stays a
client-only preview tool for the pipeline's own output.

### Resolving a native monster Code to a model

`resources/Character.edf/MonsterCharacter.xlsx` has every gameplay stat
(HP, move speed, move distance, etc.) but **no model/mesh column at all** -
none of its 3 sheets (`MonsterCharacter`, `MonsterCharacterAI`, `moncli`) tie
a `Code` to a filename. The actual link lives in a second workbook,
`resources/Character.edf/Monster.xlsx` (copied in from this repo's
`public/game-assets/data/Monster.xlsx`), whose `Bone`/`Mesh`/`Ani` sheets key
every resource with a small sequential hex `ID` (e.g. `000F7` ->
`ABELDIGAR.MSH`).

The relationship, found empirically (not documented anywhere): **`modelId =
Code >> 8`** - i.e. drop the low byte of `Code` (which encodes a level/grade
variant - several `Code`s share one visual model) and look that up as the
`Mesh` sheet's `ID`. Verified against 397 name-matched rows: 373 exact hits,
with the 24 "misses" explained by generic reused display names (`"Archer"`,
`"Champion"`, ...) colliding in a naive name-based cross-check, not the
formula being wrong. Across the real `Elan` map, **627/627** monster spawn
entries resolve to one of the 360 converted `.glb`s this way. This lives in
`internal/monsterdb/catalog.go`'s `resolveModelStem` - the backend is the
only place that needs to know this trick; everything downstream (the
frontend, `EntitySnapshot.monster.model_stem`, a map's own
`monsterSpawns[].monsters[].model`) just gets the already-resolved stem.

One data-hygiene gotcha in the same workbook: `MonsterCharacter.xlsx` has a
trailing block of ~120 unlocalized placeholder rows (`Name == "Translation"`)
whose `Code` values coincidentally collide with real, earlier, named
templates. `Catalog.Load` keeps the **first** occurrence of a duplicate
`Code`, not the last (the usual convention, see `itemdb`) - last-wins would
silently clobber a real definition with a placeholder one.

### Backend simulation (`rfworld`)

- `internal/monsterdb`: loads both workbooks into `Definition`s (stats +
  resolved `ModelStem`), keyed by `Code`.
- `internal/entity/monster.go`: server-side `Monster` (position, HP, home
  point, patrol bounds, `MonsterState` idle/patrolling/chasing/dead,
  `MonsterMode` peace/war). Entity IDs are partitioned with the top bit
  (`monsterIDFlag = 1<<31`) so they can never collide with player IDs
  (small sequential integers from `Gateway.nextID`) without the two
  allocators needing to coordinate.
- `internal/world/monster.go`: `World.LoadMonsterSpawns` instantiates every
  monster a map's own `dmm*` spawn helpers describe (already-parsed
  `RFMapDetails.MonsterSpawns` - no new map-parsing work needed) and adds
  them to the same spatial grid players use, so they participate in AOI for
  free. Each tick: patrol (wander within
  `min/max(MinMoveDist, MaxMoveDist)` of home, clamped to the spawn helper's
  own bounds), chase (once aggroed - see below), HP regen (resumes
  `HPRecDelay` after the last hit, `HPRecUnit` per interval), and a
  dead/respawn timer with a corpse-linger window before the corpse actually
  leaves AOI and before it respawns in place.
- `AttackRequest` (new `ClientPacket` oneof case): deliberately the smallest
  possible combat stub - flat damage (`flatAttackDamage`), a fixed melee
  range check, and a flat 1-attack/sec cooldown per player
  (`entity.Player.AttackCooldownTicks`). No weapon range/skills/animus, no
  player HP/death (players can't take damage from anything yet - that's a
  separate future feature). A kill starts the respawn timer; a non-lethal
  hit sets `AggroTargetID`/`Mode = War`/`State = Chasing` so the monster
  visually closes distance and faces its attacker - it does **not** deal
  damage back (no player HP system to deal it to yet), so "retaliation" is
  visual/AI only for now.
- Combat feedback rides in `WorldDelta.combat_hits` (`CombatHitEvent`), not a
  separate `ServerPacket` case, specifically so it's automatically AOI-scoped
  by the same per-viewer loop that already builds `enters`/`updates`/`exits`.
- **Gotcha already hit once**: `clearAggroLocked` also resets `State` to
  `Idle` (it's shared by the "target left range" and "target died" paths).
  In the kill branch of `processAttackLocked`, `clearAggroLocked` must run
  **before** setting `State = Dead`, not after - otherwise it silently
  overwrites the kill back to a walking-dead "alive" 0-HP monster that never
  respawns. Caught by `TestAttackKillsAndRespawnsMonster`.
- A subtler protocol gap caught the same way: `EntityUpdate` originally had
  no way to carry a mode change. A monster that gets aggroed mid-session
  never leaves AOI (so never gets a fresh `EntityEnter` to redeliver
  `MonsterInfo.mode`), meaning an already-connected client would keep
  playing PEACE clips forever. Fixed by adding `optional uint32 mode` to
  `EntityUpdate`, set only when it actually changes (same pattern as the
  existing `optional uint32 hp`).
- Config: `MONSTER_DATABASE_PATH` (default `resources/Character.edf`) for
  the catalog; monsters are spawned into the world once at startup for
  `DEFAULT_MAP_NAME`, before `World.Start()`.
- `GET /map`/`GET /maps/{name}` now resolve each `monsterSpawns[].monsters[]`
  entry's `name`/`model` server-side (`Server.resolveMonsterModels`) so the
  frontend never needs to know the `Code >> 8` trick itself.
- **Spawn scatter**: `elanmNN.dat`'s own `Count` field (e.g. "10 of this
  code at this point") was applied correctly, but every instance of a
  `Count > 1` group - and every different monster code sharing one physical
  spawn point - landed on the exact same coordinate. Real Elan data has
  points with 10-15 monsters stacked identically. Fixed with a small
  sunflower-spiral scatter (`scatterSpawnPoint`, ~12-unit steps, clamped to
  the spawn's own bound radius) whose index continues across every group at
  one spawn point rather than resetting per monster code - the first fix
  attempt only fixed same-code stacking and missed multi-code points still
  overlapping at `i == 0`.
- **`Count`'s real meaning is still unconfirmed**: even after scattering,
  spawning `Count` instances of one entry simultaneously at one point still
  read as too crowded, so `maxSpawnCountPerEntry` (see `world/monster.go`)
  currently hardcodes every entry down to 1, regardless of its real `Count`
  - a deliberate stopgap clamp, not a reinterpretation of the parsed data.
  Leading unconfirmed theory: `Count` is a population cap ("keep up to
  `Count` of this monster alive here over time", each dying/respawning
  independently), not "spawn `Count` of them at once" - which would also
  explain why `Rate` is uniformly 100 on every real entry (a per-tick
  pool-refill chance, not a one-shot spawn probability). Not implemented;
  see that constant's own doc comment for the shape a real fix would take
  (spawn 1 up front, replace it on death instead of just respawning it in
  place, so the group settles toward `Count` alive over time).
- **Native vs. scene-space yaw** (a real shipped bug, not just a debug-scene
  regression of the earlier %moncall fix): `compassRotationFromVector`
  computes a monster's facing directly from **native RF world-space**
  deltas (`targetX - m.X`, etc. - the same space `entity.Monster.X/Z` and
  `EntityUpdate.dx/dz` already use), but was written by copying
  `compassRotation.ts`'s `continuousRotationFromVector` formula verbatim.
  That formula is calibrated for a three.js **scene**-space facing vector,
  and native/scene space differ by a Z negation (`rf/map.ts`'s
  `nativeToScene`: `sceneZ = -nativeZ`) - the debug scene's own
  `MonsterController.ts` never hit this because it works entirely in scene
  space already (see its own yaw fix earlier in this doc), so the exact
  same-looking fix does not carry over unchanged to a native-space caller.
  Concretely: `atan2(-dx, -dz)` (the scene-space formula, dz negated) needs
  to become `atan2(-dx, dz)` (dz *not* negated) when `dx, dz` are native.
  For pure-Z travel this bug was a full 180 degrees - a monster patrolling
  north/south rendered facing exactly backward, matching what "the monster
  is walking backward" looks like. Locked in by
  `TestCompassRotationFromVectorNativeSpace`, which checks each cardinal
  native direction against the compass value a player moving the same real
  direction would encode.

### Frontend runtime (this repo)

- `MapClient.ts`'s `MapMonsterEntry` gained `name`/`model` (already resolved
  by the backend). `OnlineScene.preloadMonsterModels` collects every
  distinct `model` a map's spawns reference and fires `loadMonster()` for
  each (fire-and-forget, kicked off right after `GET /map` resolves, well
  before the WebSocket/character/map-geometry loads that follow) so
  `rf/monster.ts`'s asset cache is warm by the time real monster entities
  start streaming in.
- `RemoteMonsterController` (new, alongside `RemoteEntityController`) is the
  server-driven counterpart to the locally-steered `MonsterController`:
  position/yaw are purely smoothed toward the server's latest
  `EntitySnapshot`/`EntityUpdate`, never locally simulated. Clip selection
  is deterministic (not the random STAND/IDLE pick `MonsterController`'s own
  `%moncall` preview makes) since two clients watching the same monster
  need to see the same clip: `state` maps to
  idle -> `STAND`/`IDLE`, patrolling -> `WALK`, chasing -> `RUN`/`WALK`,
  dead -> `DIE` (played once, held on last frame); `mode` (peace/war)
  selects the clip prefix.
- **Ground height went through three iterations, worth recording in full**:
  1. First version: local raycast against the full map mesh every ~0.2s per
     monster, snapping Y directly to the new sample. Visibly hopped/stepped
     on any sloped or uneven terrain - snapping instead of easing toward
     each new sample.
  2. Fixed by easing toward the sampled height (same shape as
     `RemoteEntityController`'s own `applyRemoteGroundHeight`) - but with no
     per-frame query budget, unlike the player version's own
     `REMOTE_GROUND_QUERY_BUDGET_PER_FRAME`. With many monsters in view this
     was a measured real frame-time cost, so it was removed outright next,
     on the assumption that the server's own `snapMonsterToTerrainLocked`
     already sends an authoritative Y and a second local raycast was
     redundant work.
  3. That assumption was wrong for any *real* map. `snapMonsterToTerrainLocked`
     used `w.terrain` unconditionally - a synthetic placeholder (a handful
     of hardcoded hills in a fixed `-5000..5000` box, see
     `worldmap.DefaultTerrain`) with nothing to do with a real map's actual
     shape, loaded only because no `resources/maps/default.json` exists to
     override it. Elan's real coordinates mostly fall outside that box, so
     `Walkable()` returned false and the function silently did nothing for
     most of the map - but for the coordinates that *did* fall inside it,
     monsters got snapped to a nonsense fake-hill height. Worse: unlike
     `snapPlayerToTerrainLocked`, it never checked `w.collision != nil`, so
     it didn't even defer to the real per-map native collision the way the
     player path already does. Real native RF collision (see
     `worldmap.CollisionMap`) is 2D wall lines only - no height data at all
     - so on a real map the server genuinely cannot compute accurate ground
     height past a monster's own spawn point. Final fix: (a) backend -
     `snapMonsterToTerrainLocked` now skips entirely once `w.collision != nil`,
     matching the player convention exactly, so it only ever runs against
     the placeholder terrain when there's no real map data to defer to; (b)
     frontend - the local raycast came back, this time with its own
     `GROUND_QUERY_BUDGET_PER_FRAME` cap (same shape as the player
     controller's), plus an immediate unbudgeted snap at spawn (mirroring
     `RemoteEntityController.spawn`'s own treatment) so a freshly spawned
     monster doesn't render at a stale Y for however many frames the
     budgeted sampler takes to reach it. Net result: correctness (a chasing
     monster now tracks a real slope) and bounded cost (a hard cap on
     raycasts/frame) both hold at once - the second iteration's mistake was
     treating this as an either/or.
  - `OnlineScene.handlePacket` routes `WorldSnapshot`/`WorldDelta` entries by
    `EntityKind`: enters/full-snapshot entries are split by kind (each
    controller's own resync would wrongly create/remove the wrong kind of
    renderer for an entry meant for the other one), but per-ID
    `update`/`exit` calls are simply fanned out to **both** controllers
    unconditionally - `EntityUpdate`/`EntityExit` carry no `kind`, and both
    controllers already no-op on an ID they don't track, so this is simpler
    than maintaining a separate id->kind lookup.
- Minimal click-to-attack: left-click raycasts against every loaded remote
  monster's root object (`RemoteMonsterController.getTargetableObjects`)
  and sends `AttackRequest` for the nearest hit - no dedicated
  target-selection/HP-bar UI. `CombatHitEvent` feedback reuses the existing
  chat log's `'system'` message kind rather than new UI, same
  degrade-to-existing-UI treatment inventory errors already get.

### Deliberately out of scope for this pass

- No proactive monster aggro (`OffensiveRate`/`ViewAngle` vision-cone
  scanning) - a monster only enters War/Chasing after being attacked first.
- No real player HP/death - `AttackRequest` is one-directional
  (player -> monster only).
- No weapon-derived attack range/speed - both are fixed placeholder
  constants server-side.
- Single default map only, matching how the rest of the backend is
  currently scoped.

## Known remaining gaps (as of this writing)

- 2 monsters skip conversion entirely for lack of a matching `.msh`
  (`EIZENSTRIKER`, `TURNCOATSKOUTER`) - genuinely missing from the raw
  dump, not a bug.
- 4 monsters fail to convert (`ELDERLIZARD`, `GHOST`, `LAVA`, `LIZARD`) -
  a `.bn` parse alignment error partway through their skeleton, isolated to
  those specific files (60+ bone skeletons elsewhere parse fine) but not
  yet root-caused.
- The mirrored-bone animation correction (see above) was derived and
  verified against `DRACO`'s wing rig specifically. It's a general
  per-bone fix (not a `DRACO`-specific special case), but if a future
  monster shows similar symptoms on a *different* kind of mirrored
  structure (not a simple negative-scale-root-with-positive-scale-children
  pattern), re-verify with the same empirical method: find two sub-chains
  that share byte-identical relative keyframe data (proving they're meant
  to be exact mirrors), then check world-space symmetry before and after
  any candidate fix - don't assume the same closed-form correction
  generalizes without checking.
- A real server-authoritative gameplay layer now exists (see "Server-
  authoritative monster lifecycle" above) - `%moncall` remains a separate,
  client-only debug/QA tool for previewing the conversion pipeline's raw
  output and is unaffected by any of it.
- The real lifecycle's own scope cuts (no proactive aggro, no player
  HP/death, placeholder flat damage/cooldown/range) are listed in that
  section's own "Deliberately out of scope" list, not repeated here.
