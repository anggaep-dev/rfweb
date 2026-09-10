import { useCallback, useEffect, useRef, useState } from 'react';
import BasePartPanel from '../debug/BasePartPanel';
import CommandConsole from '../debug/CommandConsole';
import DebugPanel from '../debug/DebugPanel';
import EffectEditPanel from '../debug/EffectEditPanel';
import EquipPanel from '../debug/EquipPanel';
import FullscreenButton from '../hud/FullscreenButton';
import MobileControls from '../hud/MobileControls';
import StatsPanel from '../debug/StatsPanel';
import WeaponEditPanel from '../debug/WeaponEditPanel';
import type { CamMode } from '../../controllers/CameraController';
import type { BattleMode, EffectSocketInspection, MoveMode } from '../../controllers/CharacterController';
import { useKeyboardMove } from '../../hooks/useKeyboardMove';
import { RaceGender } from '../../rf/character';
import type { GradeLiveValues } from '../../rf/gradeEffect';
import { ALL_EQUIP_SLOTS, SLOT_LABELS, loadUsableSlotItems } from '../../rf/items';
import type { ModelType, ItemDefinition } from '../../rf/items';
import type { ParticleEffect, ParticleLiveValues } from '../../rf/particleSystem';
import type { SceneManager } from '../../scenes/SceneManager';
import type { ViewerDebugStats, WeaponEditState } from '../../scenes/ViewerScene';
import { ViewerScene } from '../../scenes/ViewerScene';
import './RfViewer.css';


export interface RfViewerProps {
  sceneManager: SceneManager;
  initialRaceGender: RaceGender;
  /** Optional "back to character select" action, shown as a button when provided. */
  onExit?: () => void;
}

export default function RfViewer({ sceneManager, initialRaceGender, onExit }: RfViewerProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [clipName, setClipName] = useState<string>('stand');
  const [showBones, setShowBones] = useState(false);
  const [camMode, setCamMode] = useState<CamMode>('third');
  const [debugPaused, setDebugPaused] = useState(false);
  const [frameLabel, setFrameLabel] = useState('');
  const [debugStats, setDebugStats] = useState<ViewerDebugStats>({
    fps: 0,
    heapMB: null,
    geometries: 0,
    textures: 0,
    calls: 0,
    triangles: 0,
    particleEffects: 0,
    particleBatches: 0,
    particleInstances: 0,
    simulatedParticles: 0,
    culledParticleEffects: 0,
    particleUpdateMs: 0,
    updateMs: 0,
    renderMs: 0,
    clipKey: null,
    weapon: null,
  });

  // The original client's Peace/War battle toggle - War shows the wielded
  // weapon and switches walk/run to their combat variant, Peace hides it
  // and always plays the unarmed clips. See CharacterController.setBattleMode.
  const [battleMode, setBattleMode] = useState<BattleMode>('peace');

  // Walk/run toggle for click-to-move - independent of battleMode, which
  // only decides whether the combat variant of whichever clip this picks
  // plays. See CharacterController.setMoveMode.
  const [moveMode, setMoveMode] = useState<MoveMode>('walk');

  // Debug-only booster toggle - forces isBoosterEquipped without needing a
  // real "Booster" cloak item equipped (there's no cloak-equip UI in this
  // scene yet), so the run-speed multiplier can be verified directly. Only
  // actually changes anything while moveMode is 'run' - see getCurrentSpeed.
  const [isBoosterOn, setIsBoosterOn] = useState(false);

  // The real, player-facing Fly toggle - see CharacterController.setFlying.
  // Requires any cloak to be equipped; handleToggleFly below shows a notice
  // via commandFeedback instead of flipping this when that's not the case.
  const [isFlying, setIsFlying] = useState(false);

  // The debug/dev-tooling panel (race switcher, clip buttons, camera-mode
  // select, frame-stepping) - hidden by default and revealed only via the
  // GM console's "%debug 1"/"%debug 0" (see handleCommandSubmit below), not
  // a UI button, so it stays out of the way until someone actually wants it.
  const [showDebugPanel, setShowDebugPanel] = useState(false);

  // StatsPanel/EquipPanel spawn independently of showDebugPanel (and of each
  // other) via the GM console's "%stats 1"/"%eq 1" (see handleCommandSubmit)
  // - same "hidden until summoned" pattern as showDebugPanel. The "Debug UI"
  // button is a shortcut that flips both together.
  const [showStats, setShowStats] = useState(false);
  const [showEquip, setShowEquip] = useState(false);
  const [showBasePart, setShowBasePart] = useState(false);

  // %wpedit 1/0 - a Blender-style move/rotate gizmo on the equipped weapon,
  // for hand-tuning its placement against what CharacterController computed
  // (see ViewerScene.setWeaponEditEnabled). weaponEditState mirrors the
  // gizmo's live transform for WeaponEditPanel's readout.
  const [showWeaponEdit, setShowWeaponEdit] = useState(false);
  const [weaponEditState, setWeaponEditState] = useState<WeaponEditState | null>(null);
  // WeaponEditPanel's upgrade-level dropdown - simulates weaponItem.json's
  // real per-item upgrade level (not tracked anywhere else in this project -
  // see CharacterController.setDebugWeaponUpgradeLevel) to preview how the
  // resolved Chef/ effect changes across PatternList.txt's columns.
  const [weaponUpgradeLevel, setWeaponUpgradeLevel] = useState(0);

  // %efedit 1/0 - visual markers on the equipped weapon's own "effectN"/
  // "P0N" dummy sockets (see ViewerScene.setEffectEditEnabled). Clicking
  // one resolves its real .eff/.spt/.mst data plus whatever real particle
  // effect is currently running there, shown/live-tunable in
  // EffectEditPanel below - see ViewerScene.onEffectSocketInfo.
  const [showEffectEdit, setShowEffectEdit] = useState(false);
  const [effectSocketInspection, setEffectSocketInspection] = useState<EffectSocketInspection | null>(null);

  // %particletest 1/0 - debug/proof-of-concept only (see
  // CharacterController.setDebugSocketParticleEnabled): a real, hardcoded
  // .spt weapon-aura particle attached to the equipped weapon's first
  // effect socket, to compare against the flat billboard glow. On by
  // default (the controller's own debugSocketParticleWanted starts true and
  // auto-reattaches on every weapon equip) - no local mirror of that state
  // is kept here, the %particletest command below just forwards to it.

  const [raceGender, setRaceGender] = useState<RaceGender>(initialRaceGender);
  const raceGenderRef = useRef<RaceGender>(initialRaceGender);
  const isFirstRaceEffectRef = useRef(true);

  // Equip-slot selection: which item id (if any) is picked per ModelType
  // slot, and the race-filtered item list each slot's dropdown offers.
  // Selecting an item here does not yet change the rendered mesh - see the
  // note in the equip panel below.
  const [equippedItemId, setEquippedItemId] = useState<Partial<Record<ModelType, string>>>({});
  const [slotItems, setSlotItems] = useState<Partial<Record<ModelType, ItemDefinition[]>>>({});

  // Character-creation-time appearance (1-of-5 variant per base slot) - see
  // BasePartPanel/CharacterController.setBaseAppearance. Mirrors the
  // scene's own state purely for the UI to render selected values; the
  // scene is the source of truth.
  const [baseAppearance, setBaseAppearance] = useState<Partial<Record<ModelType, number>>>({});

  // GM command console (e.g. "%addbot 5").
  const [commandInput, setCommandInput] = useState('');
  const [commandFeedback, setCommandFeedback] = useState('');

  // Assigned by the mount effect below, so the smaller effects further down
  // (keyed on showBones/camMode/debugPaused/raceGender) and the JSX
  // handlers can reach the scene without needing it in their own dependency
  // arrays.
  const viewerSceneRef = useRef<ViewerScene | null>(null);

  useEffect(() => {
    let disposed = false;

    const viewerScene = new ViewerScene(sceneManager.renderer, raceGenderRef.current, {
      onClipChange: (name) => {
        if (!disposed) setClipName(name);
      },
      onFrameLabelChange: (label) => {
        if (!disposed) setFrameLabel(label);
      },
      onStatusChange: (nextStatus, message) => {
        if (disposed) return;
        setStatus(nextStatus);
        setErrorMessage(message ?? '');
      },
      onStatsUpdate: (stats) => {
        if (!disposed) setDebugStats(stats);
      },
      onWeaponEditChange: (state) => {
        if (!disposed) setWeaponEditState(state);
      },
      onEffectEditChange: (socketNames) => {
        if (disposed || !socketNames) return;
        setCommandFeedback(
          socketNames.length > 0 ? `Effect sockets found: ${socketNames.join(', ')}` : 'No "effectN" sockets on this weapon.',
        );
      },
      onEffectSocketInfo: (inspection) => {
        if (!disposed) setEffectSocketInspection(inspection);
      },
    });
    viewerSceneRef.current = viewerScene;
    // Resource disposal is SceneManager's job once this scene is superseded
    // (or on full app unmount) - not this cleanup's, since the replacement
    // screen's own mount effect is what calls setScene() next, and until
    // that happens this scene should keep rendering/updating undisturbed.
    void sceneManager.setScene(viewerScene);

    return () => {
      disposed = true;
      viewerSceneRef.current = null;
    };
  }, [sceneManager]);

  useEffect(() => {
    viewerSceneRef.current?.characterController.setShowBones(showBones);
  }, [showBones]);

  useEffect(() => {
    viewerSceneRef.current?.cameraController.setMode(camMode);
  }, [camMode]);

  useEffect(() => {
    viewerSceneRef.current?.characterController.setDebugPaused(debugPaused);
  }, [debugPaused]);

  useEffect(() => {
    viewerSceneRef.current?.characterController.setBattleMode(battleMode);
  }, [battleMode]);

  useEffect(() => {
    viewerSceneRef.current?.characterController.setMoveMode(moveMode);
  }, [moveMode]);

  useEffect(() => {
    viewerSceneRef.current?.setEffectEditEnabled(showEffectEdit);
    if (!showEffectEdit) setEffectSocketInspection(null);
  }, [showEffectEdit]);


  useEffect(() => {
    viewerSceneRef.current?.characterController.setDebugBoosterEnabled(isBoosterOn);
  }, [isBoosterOn]);

  useEffect(() => {
    viewerSceneRef.current?.setWeaponEditEnabled(showWeaponEdit);
  }, [showWeaponEdit]);

  useEffect(() => {
    raceGenderRef.current = raceGender;
    // The initial load is already kicked off by the mount effect above -
    // this effect only needs to react to actual switches after that.
    if (isFirstRaceEffectRef.current) {
      isFirstRaceEffectRef.current = false;
      return;
    }
    viewerSceneRef.current?.loadRace(raceGender);
  }, [raceGender]);

  // An item valid for one race's body may not be for another's, so previous
  // selections are cleared on a race switch - and CharacterController.mount()
  // resets battleMode back to 'peace' internally for the same "fresh
  // character" reason, so the toggle button needs to follow suit. Done
  // during render by comparing against a state-held "previous value" -
  // React's documented pattern for resetting state when a value changes (a
  // ref can't be used here: reading/writing ref.current during render
  // isn't allowed).
  const [prevRaceGenderForEquip, setPrevRaceGenderForEquip] = useState(raceGender);
  if (prevRaceGenderForEquip !== raceGender) {
    setPrevRaceGenderForEquip(raceGender);
    setEquippedItemId({});
    setBattleMode('peace');
    setMoveMode('walk');
    setIsBoosterOn(false);
    setIsFlying(false);
    setWeaponUpgradeLevel(0);
    // CharacterController.mount() resets baseAppearance to {} (all variant 0)
    // for the same "fresh character" reason - see its own reset block.
    setBaseAppearance({});
  }

  // Loads each slot's race-eligible item list whenever the character is
  // ready or the race changes. Item JSON files are cached per slot in
  // rf/items.ts, so a race switch only re-filters already-fetched data
  // rather than re-downloading it.
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    for (const modelType of ALL_EQUIP_SLOTS) {
      loadUsableSlotItems(modelType, raceGender)
        .then((items) => {
          if (cancelled) return;
          setSlotItems((prev) => ({ ...prev, [modelType]: items }));
        })
        .catch((err: unknown) => {
          console.warn(`Failed to load items for slot ${SLOT_LABELS[modelType]}:`, err);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [status, raceGender]);

  const logFrameState = () => {
    const result = viewerSceneRef.current?.characterController.getFrameStateRows();
    if (!result) return;
    const { rows, action } = result;
    console.log(`[anim-debug] clip="${clipName}" time=${action.time.toFixed(4)}s / ${action.getClip().duration.toFixed(4)}s`);
    console.table(rows);
  };

  const stepFrame = (deltaFrames: number) => {
    viewerSceneRef.current?.characterController.stepFrame(deltaFrames);
    logFrameState();
  };

  const handleManualClip = (name: string) => {
    viewerSceneRef.current?.characterController.setClip(name);
  };

  const handleManualCloakAniState = (state: string) => {
    viewerSceneRef.current?.characterController.playCloakAnimationState(state);
  };

  // Fly requires a cloak to be equipped (see CharacterController.setFlying) -
  // a click while none is equipped fails without changing state, so this
  // surfaces a notice instead of silently doing nothing. Turning it off
  // always succeeds.
  const handleToggleFly = () => {
    const next = !isFlying;
    const ok = viewerSceneRef.current?.characterController.setFlying(next) ?? false;
    if (ok) {
      setIsFlying(next);
      if (next) setCommandFeedback('');
    } else {
      setCommandFeedback('You must equip a cloak to fly.');
    }
  };

  // Memoized (stable identity) - MobileControls' unmount-cleanup effect used
  // to depend on this prop, so a fresh function reference on every RfViewer
  // re-render (which happens constantly while walking - see onStatsUpdate/
  // onClipChange above) fired that cleanup spuriously, repeatedly zeroing
  // the joystick input mid-hold. Fixed on both ends (see MobileControls'
  // onMoveRef), but keeping this stable is still the right call regardless.
  // Shared by the mobile joystick and WASD/arrow keys (useKeyboardMove
  // below) - both drive the same ViewerScene.setMoveInput() channel.
  const handleMoveInput = useCallback((input: { x: number; y: number } | null) => {
    viewerSceneRef.current?.setMoveInput(input);
  }, []);

  useKeyboardMove(handleMoveInput);

  const handleEquipClose = useCallback(() => setShowEquip(false), []);

  const handleWeaponEditModeChange = useCallback((mode: 'translate' | 'rotate') => {
    viewerSceneRef.current?.setWeaponEditMode(mode);
  }, []);
  const handleWeaponEditReset = useCallback(() => viewerSceneRef.current?.resetWeaponEditTransform(), []);
  const handleWeaponEditClose = useCallback(() => setShowWeaponEdit(false), []);
  const handleGradeLiveChange = useCallback((patch: Partial<GradeLiveValues>) => {
    viewerSceneRef.current?.characterController.setWeaponGradeLiveValues(patch);
  }, []);
  const handleUpgradeLevelChange = useCallback((level: number) => {
    setWeaponUpgradeLevel(level);
    viewerSceneRef.current?.characterController.setDebugWeaponUpgradeLevel(level);
  }, []);
  const handleEffectSocketClose = useCallback(() => setEffectSocketInspection(null), []);
  const handleParticleLiveChange = useCallback((effect: ParticleEffect, patch: Partial<ParticleLiveValues>) => {
    viewerSceneRef.current?.characterController.setParticleLiveValues(effect, patch);
  }, []);

  // Depends only on slotItems (needed to resolve the picked id back to an
  // ItemDefinition) - that only changes on an actual item-load/race-switch
  // event, not on every render, so this still doesn't defeat EquipPanel's memo().
  const handleEquipChange = useCallback(
    (modelType: ModelType, itemId: string) => {
      const item = itemId === '' ? null : (slotItems[modelType]?.find((i) => i.id === itemId) ?? null);

      setEquippedItemId((prev) => {
        if (itemId === '') {
          const next = { ...prev };
          delete next[modelType];
          return next;
        }
        return { ...prev, [modelType]: itemId };
      });

      // equipItem() resolves the item's mesh via playerResource.json - most
      // real (non-"Default ...") items aren't in that table yet, so
      // 'unavailable' is common; the selection is kept either way, it just
      // won't visually change the model until resource data covers it.
      viewerSceneRef.current?.characterController
        .equipItem(modelType, item)
        .then((result) => {
          if (result === 'unavailable') {
            console.warn(
              `No mesh data available for "${item?.name ?? 'this item'}" yet - selection kept, but the model won't change.`,
            );
          }
        })
        .catch((err: unknown) => {
          console.error(`Failed to equip item for slot ${SLOT_LABELS[modelType]}:`, err);
        });
    },
    [slotItems],
  );

  const handleBasePartClose = useCallback(() => setShowBasePart(false), []);

  const handleBaseAppearanceChange = useCallback((modelType: ModelType, variantIndex: number) => {
    setBaseAppearance((prev) => ({ ...prev, [modelType]: variantIndex }));
    viewerSceneRef.current?.characterController
      .setBaseAppearance(modelType, variantIndex)
      .catch((err: unknown) => {
        console.error(`Failed to set base appearance for slot ${SLOT_LABELS[modelType]}:`, err);
      });
  }, []);

  const handleCommandSubmit = () => {
    const trimmed = commandInput.trim();
    if (!trimmed) return;
    setCommandInput('');

    // Debug-panel/stats/equip visibility is pure UI state, not scene state -
    // handled here rather than round-tripping through ViewerScene.runCommand.
    const debugMatch = /^%debug\s+([01])$/.exec(trimmed);
    if (debugMatch) {
      const show = debugMatch[1] === '1';
      setShowDebugPanel(show);
      setCommandFeedback(`Debug panel ${show ? 'shown' : 'hidden'}.`);
      return;
    }

    const statsMatch = /^%stats\s+([01])$/.exec(trimmed);
    if (statsMatch) {
      const show = statsMatch[1] === '1';
      setShowStats(show);
      setCommandFeedback(`Stats panel ${show ? 'shown' : 'hidden'}.`);
      return;
    }

    const equipMatch = /^%eq\s+([01])$/.exec(trimmed);
    if (equipMatch) {
      const show = equipMatch[1] === '1';
      setShowEquip(show);
      // Base appearance is closely related to equipping (both change what's
      // rendered per body slot) - shown/hidden together so %eq is a single
      // command for "the whole appearance toolset", not two separate ones.
      setShowBasePart(show);
      setCommandFeedback(`Equip panel ${show ? 'shown' : 'hidden'}.`);
      return;
    }

    const baseMatch = /^%base\s+([01])$/.exec(trimmed);
    if (baseMatch) {
      const show = baseMatch[1] === '1';
      setShowBasePart(show);
      setCommandFeedback(`Base appearance panel ${show ? 'shown' : 'hidden'}.`);
      return;
    }

    const wpeditMatch = /^%wpedit\s+([01])$/.exec(trimmed);
    if (wpeditMatch) {
      const show = wpeditMatch[1] === '1';
      setShowWeaponEdit(show);
      setCommandFeedback(`Weapon edit gizmo ${show ? 'shown' : 'hidden'}.`);
      return;
    }

    const efeditMatch = /^%efedit\s+([01])$/.exec(trimmed);
    if (efeditMatch) {
      const show = efeditMatch[1] === '1';
      setShowEffectEdit(show);
      // onEffectEditChange (above) overwrites this with the real socket list
      // an instant later, once the showEffectEdit effect below actually
      // calls setEffectEditEnabled - not shown at all on turn-off, since
      // that fires onEffectEditChange(null), which the handler ignores.
      setCommandFeedback(show ? 'Effect edit markers on - looking for sockets...' : 'Effect edit markers hidden.');
      return;
    }

    const particletestMatch = /^%particletest\s+([01])$/.exec(trimmed);
    if (particletestMatch) {
      const on = particletestMatch[1] === '1';
      const ok = viewerSceneRef.current?.characterController.setDebugSocketParticleEnabled(on) ?? true;
      // Bots each own a separate CharacterController (see BotController) -
      // without also forwarding here, %particletest only ever reached the
      // player's own weapon and every bot's particles kept running
      // regardless, silently invalidating an "is it actually particles"
      // stress-test comparison.
      viewerSceneRef.current?.botController.setDebugSocketParticleEnabled(on);
      setCommandFeedback(
        on
          ? ok
            ? 'Particle test on - real per-weapon .eff/.spt particle data. Use %particlescale <n> to override its scale live (1 = no scaling, the real derived value - see DEBUG_SOCKET_PARTICLE_SCALE).'
            : 'Particle test armed - no effect/particle socket on the current weapon yet (or unarmed); it will attach automatically once a compatible weapon is equipped.'
          : 'Particle test off.',
      );
      return;
    }

    // %glowtest 1/0 - same reasoning/shape as %particletest above, for the
    // socket-glow billboards (see CharacterController.
    // setDebugSocketGlowEnabled) - lets a perf A/B test isolate how much of
    // the render-time gap (StatsPanel's Frame: render ms) is transparent
    // overdraw from these specifically, independent of particles.
    const glowtestMatch = /^%glowtest\s+([01])$/.exec(trimmed);
    if (glowtestMatch) {
      const on = glowtestMatch[1] === '1';
      viewerSceneRef.current?.characterController.setDebugSocketGlowEnabled(on);
      // Bots each own a separate CharacterController - same reasoning as %particletest's identical forwarding above.
      viewerSceneRef.current?.botController.setDebugSocketGlowEnabled(on);
      setCommandFeedback(on ? 'Glow billboard test on.' : 'Glow billboard test off - socket glow billboards hidden.');
      return;
    }

    const particlescaleMatch = /^%particlescale\s+([\d.]+)$/.exec(trimmed);
    if (particlescaleMatch) {
      const scale = Number.parseFloat(particlescaleMatch[1]);
      if (Number.isFinite(scale)) {
        const previous = viewerSceneRef.current?.characterController.getDebugSocketParticleScale();
        viewerSceneRef.current?.characterController.setDebugSocketParticleScale(scale);
        setCommandFeedback(`Particle test scale set to ${scale} (was ${previous ?? '?'}).`);
      }
      return;
    }

    const particleRandomMatch = /^%particlerandom\s+([01])$/.exec(trimmed);
    if (particleRandomMatch) {
      const enabled = particleRandomMatch[1] === '1';
      viewerSceneRef.current?.setParticleRandomnessEnabled(enabled);
      setCommandFeedback(`Particle randomness ${enabled ? 'on' : 'off'} - active effects rebuilt.`);
      return;
    }

    viewerSceneRef.current
      ?.runCommand(trimmed)
      .then((result) => setCommandFeedback(result))
      .catch((err: unknown) => setCommandFeedback(`Error: ${err instanceof Error ? err.message : String(err)}`));
  };

  return (
    <div className="rf-viewer">
      {status === 'loading' && <div className="rf-viewer-overlay">Loading character…</div>}
      {status === 'error' && (
        <div className="rf-viewer-overlay rf-viewer-overlay-error">
          Failed to load assets: {errorMessage}
          <br />
          Make sure the files described in public/game-assets/README.md are in place.
        </div>
      )}

      <div className="rf-viewer-toggle-bar">
        {status === 'ready' && (
          <button
            className={`rf-viewer-debug-toggle${moveMode === 'run' ? ' active' : ''}`}
            onClick={() => setMoveMode((v) => (v === 'walk' ? 'run' : 'walk'))}
          >
            {moveMode === 'run' ? 'Run' : 'Walk'}
          </button>
        )}
        {status === 'ready' && (
          <button
            className={`rf-viewer-debug-toggle${isBoosterOn ? ' active' : ''}`}
            onClick={() => setIsBoosterOn((v) => !v)}
            title="Debug-only: forces the run-speed boost without equipping a real Booster cloak (see CharacterController.setDebugBoosterEnabled)"
          >
            Booster {isBoosterOn ? 'On' : 'Off'}
          </button>
        )}
        {status === 'ready' && (
          <button
            className={`rf-viewer-debug-toggle${isFlying ? ' active' : ''}`}
            onClick={handleToggleFly}
            title="Requires a cloak to be equipped"
          >
            Fly {isFlying ? 'On' : 'Off'}
          </button>
        )}
        {status === 'ready' && (
          <button
            className={`rf-viewer-debug-toggle${battleMode === 'war' ? ' active' : ''}`}
            onClick={() => setBattleMode((v) => (v === 'peace' ? 'war' : 'peace'))}
          >
            {battleMode === 'war' ? 'War' : 'Peace'}
          </button>
        )}
        <button
          className={`rf-viewer-debug-toggle${showStats || showEquip ? ' active' : ''}`}
          onClick={() => {
            setShowStats((v) => !v);
            setShowEquip((v) => !v);
          }}
        >
          Debug UI
        </button>
      </div>

      {status === 'ready' && <MobileControls onMove={handleMoveInput} />}
      {status === 'ready' && <FullscreenButton />}

      {/* Always rendered (not gated by showDebugPanel) - it's the only way to send "%debug 1" and bring the panel back once hidden. */}
      {status === 'ready' && (
        <CommandConsole
          commandInput={commandInput}
          onCommandInputChange={setCommandInput}
          onCommandSubmit={handleCommandSubmit}
          commandFeedback={commandFeedback}
        />
      )}

      {status === 'ready' && showStats && <StatsPanel stats={debugStats} />}

      {status === 'ready' && showEquip && (
        <EquipPanel
          equippedItemId={equippedItemId}
          slotItems={slotItems}
          onEquipChange={handleEquipChange}
          onClose={handleEquipClose}
        />
      )}

      {status === 'ready' && showBasePart && (
        <BasePartPanel
          raceGender={raceGender}
          variantBySlot={baseAppearance}
          onVariantChange={handleBaseAppearanceChange}
          onClose={handleBasePartClose}
        />
      )}

      {status === 'ready' && showWeaponEdit && (
        <WeaponEditPanel
          state={weaponEditState}
          onModeChange={handleWeaponEditModeChange}
          onReset={handleWeaponEditReset}
          onClose={handleWeaponEditClose}
          onGradeLiveChange={handleGradeLiveChange}
          upgradeLevel={weaponUpgradeLevel}
          onUpgradeLevelChange={handleUpgradeLevelChange}
        />
      )}

      {status === 'ready' && showEffectEdit && effectSocketInspection && (
        <EffectEditPanel inspection={effectSocketInspection} onClose={handleEffectSocketClose} onLiveChange={handleParticleLiveChange} />
      )}

      {showDebugPanel && (
        <DebugPanel
          ready={status === 'ready'}
          raceGender={raceGender}
          onRaceGenderChange={setRaceGender}
          clipName={clipName}
          onManualClip={handleManualClip}
          cloakAniStates={viewerSceneRef.current?.characterController.getCloakAnimationStateNames() ?? []}
          onManualCloakAniState={handleManualCloakAniState}
          showBones={showBones}
          onToggleBones={() => setShowBones((v) => !v)}
          camMode={camMode}
          onCamModeChange={setCamMode}
          debugPaused={debugPaused}
          onToggleDebugPaused={() => setDebugPaused((v) => !v)}
          onStepFrame={stepFrame}
          onLogFrameState={logFrameState}
          frameLabel={frameLabel}
          onExit={onExit}
        />
      )}
    </div>
  );
}
