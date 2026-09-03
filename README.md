# rfweb

A browser-based viewer for RF Online client assets. Built with React + TypeScript + Vite, it loads the game's raw formats (`.msh`, `.bn`/`.bbx`, `.ani`, `.bsp`, `.r3e`, `.dds`) directly at runtime — no conversion step, no Blender required to view them.

[`extra/cbb-rf-online-addon-main`](extra/cbb-rf-online-addon-main) (the Blender addon this project uses as a format reference) documents how these formats are structured and how the pieces relate to each other (skeleton → mesh → animation, map → entities, etc.).

## Status

First milestone reached: BelFemale renders in-browser with three.js — skinned mesh + skeleton, textured, playing back the stand/walk/run/sit animations from `public/game-assets/ani/`. See [`src/rf/`](src/rf/) for the format parsers (`.bn` skeleton, `.msh` mesh, `.ani` animation, `.RFT` texture) and [`src/RfViewer.tsx`](src/RfViewer.tsx) for the scene/camera/animation-mixer wiring.

Next up: more animations, other characters/equipment, and eventually the map (`.bsp`/`.r3e`) milestone.

## Getting started

```bash
npm install
npm run dev
```

Other scripts: `npm run build`, `npm run lint`, `npm run preview`.

## Game assets

Raw client files live in [`public/game-assets/`](public/game-assets/) so Vite serves them as-is and the loaders can fetch them at runtime. This folder is git-ignored (the assets are the original game's copyrighted files) — only [`public/game-assets/README.md`](public/game-assets/README.md) is tracked, so its layout expectations survive even though the contents don't.

Currently populated with one character's slice, following the client's own relative folder structure:

- `ani/` — `BELFEMALE_*.ANI` animations (sit, run, stand, walk)
- `bone/` — `BelFemale.bn` skeleton
- `mesh/` — `BELFEMALE_DEFAULT_*.msh` (face, gloves, helmet, lower, shoes, upper)
- `tex/` — matching `BELFEMALE_DEFAULT_*.RFT` textures

See that folder's own README for the conventions to follow when adding more.
