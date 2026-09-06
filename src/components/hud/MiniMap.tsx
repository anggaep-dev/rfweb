import { forwardRef, useImperativeHandle, useRef } from 'react';
import './MiniMap.css';

/** How far (raw server world-units - see RemoteEntityController.setScale's own doc comment on what those are) the radar's edge represents - tuned by eye, not derived from any known real-world map distance. */
const RADAR_RANGE_WORLD_UNITS = 300;
/** Slightly less than minimap-face's own half-diameter (68px) so a blip at max range doesn't visually clip the ring border. */
const USABLE_RADIUS_PX = 60;
/** Fixed DOM pool size, reused/hidden rather than created per entity - the handful of nearby players this will ever realistically need to show doesn't justify dynamic mount/unmount churn on every radar frame. */
const MAX_BLIPS = 12;

export interface RadarBlip {
  /** World-unit offset from the local player - see OnlineScene's RadarFrame. */
  dx: number;
  dz: number;
}

export interface MiniMapHandle {
  /** Called once per rendered frame (see OnlineScene's onRadarFrame) - writes straight to the DOM instead of through React state/props, same reasoning as MobileControls' joystick knob (this fires at render framerate; a re-render per frame for a handful of transform updates would be pure waste). */
  update(facingRad: number, blips: RadarBlip[]): void;
}

/**
 * Radar-style minimap frame, top-left - real (not mocked) local-facing and
 * nearby-entity data, fed every frame via the imperative `update()` handle
 * rather than props, since OnlineScene calls it once per render frame.
 * There's still no real terrain/map data, so this only ever plots relative
 * positions on a blank grid, not an actual world map.
 */
const MiniMap = forwardRef<MiniMapHandle>(function MiniMap(_props, ref) {
  const playerMarkerRef = useRef<HTMLDivElement>(null);
  const blipRefs = useRef<(HTMLDivElement | null)[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      update(facingRad, blips) {
        const marker = playerMarkerRef.current;
        if (marker) marker.style.transform = `rotate(${(facingRad * 180) / Math.PI}deg)`;

        const pxPerUnit = USABLE_RADIUS_PX / RADAR_RANGE_WORLD_UNITS;
        for (let i = 0; i < MAX_BLIPS; i++) {
          const el = blipRefs.current[i];
          if (!el) continue;
          const blip = blips[i];
          if (!blip || Math.hypot(blip.dx, blip.dz) > RADAR_RANGE_WORLD_UNITS) {
            el.hidden = true;
            continue;
          }
          el.hidden = false;
          el.style.transform = `translate(${blip.dx * pxPerUnit}px, ${blip.dz * pxPerUnit}px)`;
        }
      },
    }),
    [],
  );

  return (
    <div className="minimap">
      <div className="minimap-compass">N</div>
      <div className="minimap-face">
        <div className="minimap-sweep" />
        <div className="minimap-grid" />
        {Array.from({ length: MAX_BLIPS }, (_, i) => (
          <div
            key={i}
            className="minimap-blip"
            ref={(el) => {
              blipRefs.current[i] = el;
            }}
            hidden
          />
        ))}
        <div ref={playerMarkerRef} className="minimap-player" />
      </div>
      <div className="minimap-corner minimap-corner-tl" />
      <div className="minimap-corner minimap-corner-tr" />
      <div className="minimap-corner minimap-corner-bl" />
      <div className="minimap-corner minimap-corner-br" />
    </div>
  );
});

export default MiniMap;
