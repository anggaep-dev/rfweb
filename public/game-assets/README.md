# game-assets

Drop the raw RF Online client files here. This folder is served as-is by Vite (anything under `public/` is copied straight into the build output and is fetchable at runtime), which is what we want: the game loads `.msh` / `.bn` / `.bbx` / `.ani` / `.bsp` / `.r3e` / `.dds` files directly in the browser — no conversion step, no Blender at runtime.

## How to copy things in

Preserve the client's own relative folder structure as much as possible instead of flattening everything into one folder. The original engine (and the `cbb-rf-online-addon` we're using as a format reference) resolves textures and related files using relative paths, so keeping the same layout the client shipped with means our loaders can resolve those paths the same way and we don't have to hand-fix references later.

For the first milestone we only need a small slice, not the whole client:

- One character's mesh + skeleton + animation: the relevant `.msh` file(s), its `.bn`/`.bbx` skeleton, and one or two `.ani` animation files (e.g. idle + walk).
- The textures those meshes reference (`.dds` files) — keep them alongside/relative to the meshes the same way the client does.
- Later, for the map milestone: one small `.bsp` (a starter town or small zone rather than a huge open world) plus its `.r3e` entity file and textures.

Whatever you copy in, just tell me the subfolder/file names you used so the loaders know where to look — don't feel like you need to match any naming convention beyond preserving the client's own structure.

## Why this lives under `public/`

Anything here is unprocessed, so this folder is git-ignored (see the repo's `.gitignore`) — these are the original game's copyrighted assets and shouldn't end up in version control. Only this README is tracked, so the folder's purpose survives even though its contents don't.
