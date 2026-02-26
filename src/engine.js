import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─── World constants ──────────────────────────────────────────────────────────
const LANE_W  = 3.5;   // one lane width
const ROAD_W  = 14;    // arm total (2 in + 2 out = 4 × 3.5)
const RB_IN   = 12;    // island outer radius
const RB_MID  = 17;    // ring lane divider radius
const RB_OUT  = 22;    // outer ring kerb radius
const ROAD_L  = 110;   // road length from roundabout edge (game logic)
const ROAD_VEXT = 180; // extra visual extension so roads fade into fog

// ─── Mission / state-machine constants ────────────────────────────────────────
// Ring angle: atan2(-z, x).  South entry = 3π/2.
// UK clockwise traffic → angle DECREASES as car travels (South→West→North→East).
// traveledAngle accumulates positively by NEGATING the atan2 delta each frame.
const SOUTH_ENTRY_ANGLE = 3 * Math.PI / 2;
const EXITS = [
  // 1st exit = West  (left turn):  outer approach lane, left indicator on approach
  { name: 'west',  num: 1, travelAngle: Math.PI / 2,     requiredLane: 'outer', requiredRingLane: 'outer' },
  // 2nd exit = North (straight):   either approach lane, no indicator; maintain lane through ring
  { name: 'north', num: 2, travelAngle: Math.PI,          requiredLane: 'either', requiredRingLane: 'match' },
  // 3rd exit = East  (right turn): inner approach lane, right indicator on approach
  { name: 'east',  num: 3, travelAngle: 3 * Math.PI / 2, requiredLane: 'inner', requiredRingLane: 'inner' },
];
// Indicator check required at each checkpoint per exit number
const ENTRY_IND = { 1: 'left', 2: 'none', 3: 'right' };

// ─── NPC traffic constants ────────────────────────────────────────────────────
const NPC_SPEED   = 0.22;                      // units/frame along path
const NPC_INNER_R = (RB_IN  + RB_MID) / 2;    // 14.5 — inner ring lane centre
const NPC_OUTER_R = (RB_MID + RB_OUT) / 2;    // 19.5 — outer ring lane centre
// Advance ring entry CW past geometric intersection so bezierArc makes a C-curve (not S-curve).
// Advance ring exit trigger early for the same reason on the exit side.
const ENTRY_ADVANCE = 0.4;   // radians CW past lane–ring intersection for entry arc target
const EXIT_ADVANCE  = 0.4;   // radians before lane–ring intersection to start exit arc

// Ring angle convention:  x = r·sin(θ),  z = −r·cos(θ)
//   θ: north = 0,  east = π/2,  south = π,  west = 3π/2
//   UK clockwise travel → θ INCREASES each frame
const ARM_NAMES = ['south', 'north', 'east', 'west'];
const ARM_CFG = {
  south: {
    ringAngle:       Math.PI,
    approachHeading: 0,           // heading north (−z)
    departHeading:   Math.PI,     // heading south (+z)
    // UK near-side (x < 0) approach lanes; [x, z] spawn point
    approachLanePos: (outer) => [outer ? -LANE_W * 1.5 : -LANE_W * 0.5,  RB_OUT + ROAD_L * 0.65],
    // UK departure lanes (x > 0); snap x when exiting ring
    snapDepart:      (pos, outer) => { pos.x = outer ?  LANE_W * 1.5 :  LANE_W * 0.5; },
    despawnCheck:    (pos) => pos.z >  RB_OUT + ROAD_L * 0.6,
  },
  north: {
    ringAngle:       0,
    approachHeading: Math.PI,     // heading south (+z)
    departHeading:   0,           // heading north (−z)
    // UK near-side (x > 0) approach lanes
    approachLanePos: (outer) => [outer ?  LANE_W * 1.5 :  LANE_W * 0.5, -(RB_OUT + ROAD_L * 0.65)],
    snapDepart:      (pos, outer) => { pos.x = outer ? -LANE_W * 1.5 : -LANE_W * 0.5; },
    despawnCheck:    (pos) => pos.z < -(RB_OUT + ROAD_L * 0.6),
  },
  east: {
    ringAngle:       Math.PI / 2,
    approachHeading: -Math.PI / 2, // heading west (−x)
    departHeading:    Math.PI / 2, // heading east (+x)
    // UK near-side (z > 0) approach lanes
    approachLanePos: (outer) => [ RB_OUT + ROAD_L * 0.65, outer ?  LANE_W * 1.5 :  LANE_W * 0.5],
    snapDepart:      (pos, outer) => { pos.z = outer ? -LANE_W * 1.5 : -LANE_W * 0.5; },
    despawnCheck:    (pos) => pos.x >  RB_OUT + ROAD_L * 0.6,
  },
  west: {
    ringAngle:       3 * Math.PI / 2,
    approachHeading:  Math.PI / 2, // heading east (+x)
    departHeading:   -Math.PI / 2, // heading west (−x)
    // UK near-side (z < 0) approach lanes
    approachLanePos: (outer) => [-(RB_OUT + ROAD_L * 0.65), outer ? -LANE_W * 1.5 : -LANE_W * 0.5],
    snapDepart:      (pos, outer) => { pos.z = outer ?  LANE_W * 1.5 :  LANE_W * 0.5; },
    despawnCheck:    (pos) => pos.x < -(RB_OUT + ROAD_L * 0.6),
  },
};

// ─── Car physics constants ────────────────────────────────────────────────────
const MAX_SPEED   = 0.55;
const MAX_REV     = 0.18;
const ACCEL       = 0.009;
const BRAKE       = 0.018;
const FRICTION    = 0.965;
const MAX_STEER   = 0.062;  // radians/frame max heading change
const CAM_BACK    = 12;     // third-person camera: units behind car
const CAM_H       = 7.5;    // third-person camera: height above ground

// ─── Helpers ──────────────────────────────────────────────────────────────────
function canvasTex(size, drawFn, repeatX = 4, repeatY = 4) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  drawFn(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  return t;
}

function asphaltTex(rx = 3, ry = 3) {
  return canvasTex(512, (ctx, S) => {
    ctx.fillStyle = '#2e2e2e';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 6000; i++) {
      const v = 32 + (Math.random() * 28 | 0);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.beginPath();
      ctx.arc(Math.random() * S, Math.random() * S, Math.random() * 1.6 + 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 800; i++) {
      const v = 60 + (Math.random() * 20 | 0);
      ctx.fillStyle = `rgba(${v},${v},${v},0.4)`;
      ctx.fillRect(Math.random() * S, Math.random() * S, 2, 2);
    }
  }, rx, ry);
}


// ─── Main game class ──────────────────────────────────────────────────────────
export class RoundaboutGame {
  constructor(canvas, onHUD) {
    this.canvas  = canvas;
    this.onHUD   = onHUD;
    this.keys    = new Set();
    this.running     = false;
    this.clock       = new THREE.Clock();
    this.elapsed     = 0;
    this._blinkTimer  = 0;
    this._blinkOn     = false;
    this._prevBlinkOn = false;
    this._audioCtx    = null;
    this._muted       = false;

    // Debug offset refs — populated by _buildLamps / _buildProps / _loadBuildings
    this._lampRefs  = [];
    this._treeRefs  = [];
    this._houseRefs = [];

    // Camera debug config (mirrors CAM_BACK / CAM_H constants but runtime-editable)
    this._camCfg = { back: 12, h: 6, lookY: 1.5, lookFwd: 3, fov: 65 };

    // Indicator debug — populated by _buildPlayerCar / _buildNPCs
    this._indTypes = {};   // { typeName: { hw, hl, y, inds: [{mesh,sx,sz}] } }
    this._indDebug = false;
    this._indOrbit      = { az: Math.PI, el: 0.30, r: 11 }; // azimuth, elevation, radius
    this._indDragActive = false;
    this._indDragLast   = { x: 0, y: 0 };
    this._indOnMouseDown = null;
    this._indOnMouseMove = null;
    this._indOnMouseUp   = null;
    this._defaultIndOff = {
      'front-left':  { hw: -0.35, y: 0.15, hl:  0.20 },
      'front-right': { hw: -0.25, y: 0.15, hl:  0.20 },
      'rear':        { hw: -0.30, y: 0.30, hl: -0.15 },
    };

    // Start in outer approaching lane of south arm
    // UK left-hand: approaching traffic uses x < 0 (left/near-side)
    // outer approach lane centre = -LANE_W * 1.5 = -5.25
    this.car = {
      pos:    new THREE.Vector3(-LANE_W * 1.5, 0, RB_OUT + ROAD_L * 0.55),
      heading: 0,   // 0 = facing −Z (north)
      speed:   0,
      steer:   0,
      yawRate: 0,   // current angular velocity (rad/frame) — smooths heading changes
      // ── State machine ──
      phase:            'approaching',   // approaching | on_roundabout | exiting | completed
      targetExit:       null,            // 'west' | 'north' | 'east'
      targetExitNum:    null,            // 1 | 2 | 3
      exitTravelTarget: 0,              // required traveledAngle (radians) to reach exit
      requiredLane:     'outer',        // 'outer' | 'inner' (approach arm)
      requiredRingLane: 'outer',        // 'outer' | 'inner' (ring)
      // ── Indicators (player-controlled via Q/E) ──
      leftIndicator:    false,
      rightIndicator:   false,
      entryAngle:       SOUTH_ENTRY_ANGLE,
      traveledAngle:    0,              // accumulated CW angle while on ring (positive)
      approachLane:     'outer',        // detected approach lane
      ringLane:         'outer',        // detected ring lane
      // ── Grace period / failure ──
      graceActive:      false,
      graceTimer:       0,              // seconds remaining in grace period
      graceRequired:    null,           // 'left' | 'right' | 'none'
      failed:           false,
      failReason:       null,           // string shown on fail overlay
    };
    this._prevRingAngle       = null;   // for incremental traveledAngle tracking
    this._prevDistFromCenter  = null;   // for radial lane-change detection
    this._checkADone          = false;  // (a) entry indicator check fired
    this._checkBDone          = false;  // (b) 12-o-clock check fired
    this._checkCDone          = false;  // (c) near-exit indicator check fired
    this._checkDDone          = false;  // (d) exit-2: left indicator after passing exit 1
    this._checkLaneApproachDone = false; // approach-lane discipline check fired
    this._missionIndex        = 0;      // cycles through EXITS in order
    this._completeTimer       = 0;      // counts down after successful exit
    this._preview             = true;   // cinematic orbit until player clicks Drive
    this._previewCfg          = { r: 60, h: 32, spd: 0.02, fov: 36 };
    this._stationaryTimer     = 0;      // how long player has been stopped
    this._hornCooldown        = 0;      // time until next beep is allowed
    this._assignMission();

    this._onKeyDown = e => {
      if (this._preview) return;
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow')) e.preventDefault();
      // Q = toggle left indicator (cancels right)
      if (e.code === 'KeyQ') this._toggleIndicator('left');
      // E = toggle right indicator (cancels left)
      if (e.code === 'KeyE') this._toggleIndicator('right');
    };
    this._onKeyUp   = e => { if (!this._preview) this.keys.delete(e.code); };
    this._onResize  = () => this._resize();

    this._setup();
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  _setup() {
    this._initRenderer();
    this._initScene();
    this._initLights();
    this._buildWorld();
    this._buildNPCs();
    this._buildPlayerCar();
    this._initCamera();
    this._initDashboard();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
    window.addEventListener('resize',  this._onResize);
    this.start();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace    = THREE.SRGBColorSpace;
    this.renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xc2d0da);
    this.scene.fog = new THREE.FogExp2(0xb4c4ce, 0.004);
  }

  _initLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.90));

    const sun = new THREE.DirectionalLight(0xfff3d0, 1.6);
    sun.position.set(80, 130, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { near: 1, far: 500, left: -160, right: 160, top: 160, bottom: -160 });
    this.scene.add(sun);

    this.scene.add(new THREE.HemisphereLight(0x87ceeb, 0x2d5e22, 0.55));
  }

  // ── World building ─────────────────────────────────────────────────────────
  _buildWorld() {
    // Grass texture ground plane
    const grassTex = new THREE.TextureLoader().load('/grass.png');
    grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(100, 100);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshLambertMaterial({ map: grassTex }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this._buildRoundabout();
    this._buildRoads();
    this._buildMarkings();
    this._loadBuildings();
    this._buildProps();
    this._buildClouds();
    this._buildSkyDome();
  }

  // ── Roundabout: 2-lane ring (inner r12–17, outer r17–22) ──────────────────
  _buildRoundabout() {
    const asMat    = new THREE.MeshLambertMaterial({ map: asphaltTex(4, 4) });
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const islandGrassTex = new THREE.TextureLoader().load('/grass.png');
    islandGrassTex.wrapS = islandGrassTex.wrapT = THREE.RepeatWrapping;
    islandGrassTex.repeat.set(6, 6);
    const islandMat = new THREE.MeshLambertMaterial({ map: islandGrassTex });
    const curbMat   = new THREE.MeshLambertMaterial({ color: 0xd0d0d0 });

    // Full ring asphalt surface (RB_IN → RB_OUT)
    const ring = new THREE.Mesh(new THREE.RingGeometry(RB_IN, RB_OUT, 80), asMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y  = 0.02;
    ring.receiveShadow = true;
    this.scene.add(ring);

    // White solid inner edge (at RB_IN)
    const innerEdge = new THREE.Mesh(
      new THREE.RingGeometry(RB_IN, RB_IN + 0.28, 80),
      whiteMat,
    );
    innerEdge.rotation.x = -Math.PI / 2;
    innerEdge.position.y  = 0.03;
    this.scene.add(innerEdge);

    // White solid outer edge (at RB_OUT)
    const outerEdge = new THREE.Mesh(
      new THREE.RingGeometry(RB_OUT - 0.28, RB_OUT, 80),
      whiteMat,
    );
    outerEdge.rotation.x = -Math.PI / 2;
    outerEdge.position.y  = 0.03;
    this.scene.add(outerEdge);

    // Dashed white ring lane divider at RB_MID (40 segs, every other = dash)
    const numSegs = 40;
    const segA    = (Math.PI * 2) / numSegs;
    for (let i = 0; i < numSegs; i += 2) {
      const dashMesh = new THREE.Mesh(
        new THREE.RingGeometry(RB_MID - 0.15, RB_MID + 0.15, 6, 1, i * segA, segA),
        whiteMat,
      );
      dashMesh.rotation.x = -Math.PI / 2;
      dashMesh.position.y  = 0.035;
      this.scene.add(dashMesh);
    }

    // Centre island flat
    const isl = new THREE.Mesh(new THREE.CircleGeometry(RB_IN, 72), islandMat);
    isl.rotation.x = -Math.PI / 2;
    isl.position.y  = 0.02;
    this.scene.add(isl);

    // Mound
    const mound = new THREE.Mesh(
      new THREE.CylinderGeometry(RB_IN * 0.65, RB_IN - 0.3, 1.4, 40),
      islandMat,
    );
    mound.position.y = 0.7;
    this.scene.add(mound);

    // Inner kerb ring
    const iCurb = new THREE.Mesh(new THREE.TorusGeometry(RB_IN, 0.22, 8, 80), curbMat);
    iCurb.rotation.x = Math.PI / 2;
    iCurb.position.y = 0.13;
    this.scene.add(iCurb);
  }

  // ── Arms: 4-lane roads (2 approaching + 2 departing) ──────────────────────
  _buildRoads() {
    const mkMat = () => new THREE.MeshLambertMaterial({ map: asphaltTex(2, 10) });

    // Extend arms 3 units into the ring to eliminate the corner gap
    const EXT  = 3;
    const VEXT = ROAD_VEXT;
    const totalL = ROAD_L + EXT + VEXT;
    const armC   = RB_OUT + (ROAD_L + VEXT) / 2 - EXT / 2;

    // N/S arms
    this._road(mkMat(), ROAD_W, totalL, 0, 0, -armC);   // North arm
    this._road(mkMat(), ROAD_W, totalL, 0, 0,  armC);    // South arm

    // E/W arms
    this._road(mkMat(), totalL, ROAD_W,  armC, 0, 0);    // East arm
    this._road(mkMat(), totalL, ROAD_W, -armC, 0, 0);    // West arm

    // White outer edge lines extended to match visual road length
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const ew   = 0.25;
    const halfW = ROAD_W / 2;
    const edgeL = ROAD_L + VEXT;
    const edgeC = RB_OUT + edgeL / 2;
    // N/S edges
    [-edgeC, edgeC].forEach(cz => {
      this._road(whiteMat, ew, edgeL, -halfW + ew / 2, 0.03, cz);
      this._road(whiteMat, ew, edgeL,  halfW - ew / 2, 0.03, cz);
    });
    // E/W edges
    [edgeC, -edgeC].forEach(cx => {
      this._road(whiteMat, edgeL, ew, cx, 0.03, -halfW + ew / 2);
      this._road(whiteMat, edgeL, ew, cx, 0.03,  halfW - ew / 2);
    });
  }

  _road(mat, w, l, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + 0.01, z);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  // ── Road markings ──────────────────────────────────────────────────────────
  _buildMarkings() {
    const whiteMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });

    const halfW  = ROAD_W / 2;  // 7
    const ew     = 0.25;         // edge line width
    const triLen = 18;           // length of hatched give-way triangle

    // Flat marking helper
    const mark = (mat, w, l, x, y, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      this.scene.add(m);
    };

    const fullL = ROAD_L + ROAD_VEXT;  // full visual road length

    // ── N/S arm markings ────────────────────────────────────────────────────
    [-(RB_OUT + fullL / 2), RB_OUT + fullL / 2].forEach(cz => {
      // White solid centre line — from triangle tip to far end of visual arm
      const sign       = Math.sign(cz);
      const lineStart  = sign * (RB_OUT + triLen);
      const lineEnd    = cz + (fullL / 2) * sign;
      const lineCenter = (lineStart + lineEnd) / 2;
      const lineLen    = Math.abs(lineEnd - lineStart);
      mark(whiteMat, 0.3, lineLen, 0, 0.04, lineCenter);

      // White dashes between same-direction lanes (at x = ±LANE_W = ±3.5)
      const dashL = 2.5, dashGap = 4.0;
      for (let d = -(fullL / 2) + 3; d < fullL / 2 - 2; d += dashL + dashGap) {
        mark(whiteMat, 0.2, dashL, -LANE_W, 0.04, cz + d);
        mark(whiteMat, 0.2, dashL,  LANE_W, 0.04, cz + d);
      }
    });

    // ── E/W arm markings ────────────────────────────────────────────────────
    [RB_OUT + fullL / 2, -(RB_OUT + fullL / 2)].forEach(cx => {
      // White solid centre line — from triangle tip to far end of visual arm
      const sign       = Math.sign(cx);
      const lineStart  = sign * (RB_OUT + triLen);
      const lineEnd    = cx + (fullL / 2) * sign;
      const lineCenter = (lineStart + lineEnd) / 2;
      const lineLen    = Math.abs(lineEnd - lineStart);
      mark(whiteMat, lineLen, 0.3, lineCenter, 0.04, 0);

      // White dashes between same-direction lanes (at z = ±LANE_W = ±3.5)
      const dashL = 2.5, dashGap = 4.0;
      for (let d = -(fullL / 2) + 3; d < fullL / 2 - 2; d += dashL + dashGap) {
        mark(whiteMat, dashL, 0.2, cx + d, 0.04, -LANE_W);
        mark(whiteMat, dashL, 0.2, cx + d, 0.04,  LANE_W);
      }
    });

    // ── Give-way dashed double lines at roundabout entries ──────────────────
    const gwDash = 1.0, gwGap = 0.65, gwThick = 0.3;

    // South arm entry (z = +RB_OUT): approaching lanes x = -halfW → 0
    for (let x = -halfW + gwDash / 2; x < 0; x += gwDash + gwGap) {
      mark(whiteMat, gwDash, gwThick, x, 0.05, RB_OUT + 0.45);
      mark(whiteMat, gwDash, gwThick, x, 0.05, RB_OUT + 0.9);
    }

    // North arm entry (z = -RB_OUT): approaching lanes x = 0 → +halfW
    for (let x = gwDash / 2; x < halfW; x += gwDash + gwGap) {
      mark(whiteMat, gwDash, gwThick, x, 0.05, -(RB_OUT + 0.45));
      mark(whiteMat, gwDash, gwThick, x, 0.05, -(RB_OUT + 0.9));
    }

    // East arm entry (x = +RB_OUT): approaching lanes z = 0 → +halfW
    for (let z = gwDash / 2; z < halfW; z += gwDash + gwGap) {
      mark(whiteMat, gwThick, gwDash, RB_OUT + 0.45, 0.05, z);
      mark(whiteMat, gwThick, gwDash, RB_OUT + 0.9,  0.05, z);
    }

    // West arm entry (x = -RB_OUT): approaching lanes z = -halfW → 0
    for (let z = -halfW + gwDash / 2; z < 0; z += gwDash + gwGap) {
      mark(whiteMat, gwThick, gwDash, -(RB_OUT + 0.45), 0.05, z);
      mark(whiteMat, gwThick, gwDash, -(RB_OUT + 0.9),  0.05, z);
    }

    // ── Hatched give-way triangles ──────────────────────────────────────────
    // Canvas: triangle with base at top (V=0) and tip at bottom (V=1).
    // Diagonal white stripes clipped inside the triangle.
    const HATCH_W = 128, HATCH_H = 256;
    const hatchCanvas = document.createElement('canvas');
    hatchCanvas.width  = HATCH_W;
    hatchCanvas.height = HATCH_H;
    const hctx = hatchCanvas.getContext('2d');

    hctx.clearRect(0, 0, HATCH_W, HATCH_H);
    hctx.save();
    hctx.beginPath();
    hctx.moveTo(0, 0);
    hctx.lineTo(HATCH_W, 0);
    hctx.lineTo(HATCH_W / 2, HATCH_H);
    hctx.closePath();
    hctx.clip();
    hctx.strokeStyle = 'white';
    hctx.lineWidth   = 9;
    for (let i = -HATCH_H; i < HATCH_W + HATCH_H; i += 24) {
      hctx.beginPath();
      hctx.moveTo(i, 0);
      hctx.lineTo(i + HATCH_H, HATCH_H);
      hctx.stroke();
    }
    hctx.restore();

    // White border outline around the triangle
    hctx.beginPath();
    hctx.moveTo(0, 0);
    hctx.lineTo(HATCH_W, 0);
    hctx.lineTo(HATCH_W / 2, HATCH_H);
    hctx.closePath();
    hctx.strokeStyle = 'white';
    hctx.lineWidth   = 10;
    hctx.lineJoin    = 'miter';
    hctx.stroke();

    const hatchMat = new THREE.MeshBasicMaterial({
      map:         new THREE.CanvasTexture(hatchCanvas),
      transparent: true,
      depthWrite:  false,
      alphaTest:   0.01,
      side:        THREE.DoubleSide,
    });

    const triWidth = 2.5;
    // Each arm: PlaneGeometry(triWidth, triLen) rotated flat.
    // Rotation.x = -PI/2 maps local Y → world -Z. V=0 (localY=+triLen/2) → world z = -triLen/2 + centerZ.
    // South arm: V=0 at z=RB_OUT  → center at z = RB_OUT + triLen/2.
    // North arm: rotation.x = +PI/2 flips Y→Z mapping → V=0 at z=-RB_OUT → center at z = -(RB_OUT+triLen/2).
    // East arm:  rotation.x=-PI/2, rotation.z=PI/2  → V=0 at x=RB_OUT  → center at x = RB_OUT+triLen/2.
    // West arm:  rotation.x=-PI/2, rotation.z=-PI/2 → V=0 at x=-RB_OUT → center at x = -(RB_OUT+triLen/2).
    const addTri = (rx, ry, rz, px, pz) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(triWidth, triLen), hatchMat);
      m.rotation.x = rx;
      m.rotation.y = ry;
      m.rotation.z = rz;
      m.position.set(px, 0.05, pz);
      this.scene.add(m);
    };

    addTri(-Math.PI / 2,  0,              0,              0,                          RB_OUT + triLen / 2);   // South
    addTri(+Math.PI / 2,  0,              0,              0,                         -(RB_OUT + triLen / 2)); // North
    addTri(-Math.PI / 2,  0,  Math.PI / 2, RB_OUT + triLen / 2,  0);                                         // East
    addTri(-Math.PI / 2,  0, -Math.PI / 2, -(RB_OUT + triLen / 2), 0);                                       // West
  }

  // ── Props: trees, kerbs, lamps ─────────────────────────────────────────────
  _buildProps() {
    const halfW = ROAD_W / 2;          // 7
    const treeX = halfW + 4;           // 11 — initial offset from road edge

    // Island trees — inside the central island
    const islandPos = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const r = 4.5 + Math.random() * 1.5;
      islandPos.push([Math.cos(a) * r, Math.sin(a) * r, 0.7]);
    }

    // Corner trees — clusters in the 4 gaps between road arms (outside the ring)
    [45, 135, 225, 315].forEach(deg => {
      const base = deg * Math.PI / 180;
      for (let j = -1; j <= 1; j++) {
        const a = base + j * 0.28;
        const r = 27 + Math.random() * 6;
        islandPos.push([Math.sin(a) * r, -Math.cos(a) * r, 0.9 + Math.random() * 0.2]);
      }
    });

    // Road-side trees — stored with side metadata for debug slider
    // {x, z, s, isEW, sign}  isEW=false → N/S road (offset adjusts x)
    //                         isEW=true  → E/W road (offset adjusts z)
    const roadPos = [];
    // Trees sit between houses (house centres every 14 units from 30–128)
    const treeD = [37, 51, 65, 79, 93, 107, 121];
    treeD.forEach(d => {
      // South / North roads (N-S): offset is in x
      roadPos.push({ x:  treeX, z:  d, s: 1.0, isEW: false, sign:  1 });
      roadPos.push({ x: -treeX, z:  d, s: 1.0, isEW: false, sign: -1 });
      roadPos.push({ x:  treeX, z: -d, s: 1.0, isEW: false, sign:  1 });
      roadPos.push({ x: -treeX, z: -d, s: 1.0, isEW: false, sign: -1 });
      // East / West roads (E-W): offset is in z
      roadPos.push({ x:  d, z:  treeX, s: 1.0, isEW: true, sign:  1 });
      roadPos.push({ x:  d, z: -treeX, s: 1.0, isEW: true, sign: -1 });
      roadPos.push({ x: -d, z:  treeX, s: 1.0, isEW: true, sign:  1 });
      roadPos.push({ x: -d, z: -treeX, s: 1.0, isEW: true, sign: -1 });
    });

    // Load GLB and place all trees
    const loader = new GLTFLoader();
    loader.load('/trees_low_poly.glb', (gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const baseScale = 7 / size.y;
      const yOffset   = -box.min.y * baseScale;

      // Island trees (no refs needed)
      islandPos.forEach(([x, z, s]) => {
        const inst = gltf.scene.clone(true);
        inst.scale.setScalar(baseScale * s);
        inst.position.set(x, yOffset * s, z);
        inst.rotation.y = Math.random() * Math.PI * 2;
        this.scene.add(inst);
      });

      // Road-side trees — store refs for debug slider
      roadPos.forEach(({ x, z, s, isEW, sign }) => {
        const inst = gltf.scene.clone(true);
        inst.scale.setScalar(baseScale * s);
        inst.position.set(x, yOffset * s, z);
        inst.rotation.y = Math.random() * Math.PI * 2;
        this.scene.add(inst);
        this._treeRefs.push({ group: inst, isEW, sign });
      });
    });

    this._buildLamps();
  }

  _buildLamps() {
    const loader = new GLTFLoader();
    loader.load('/lamp_post.glb', (gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });

      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale   = 5 / size.y;          // target ~5 units tall
      const yOffset = -box.min.y * scale;

      // isEW=false → N/S road (offset adjusts x), isEW=true → E/W road (offset adjusts z)
      const addLamp = (x, z, ry = 0, isEW = false, sign = 1) => {
        const inst = gltf.scene.clone(true);
        inst.scale.setScalar(scale);
        inst.position.set(x, yOffset, z);
        inst.rotation.y = ry;
        this.scene.add(inst);
        this._lampRefs.push({ group: inst, isEW, sign });
      };

      const halfW = ROAD_W / 2;
      const step  = 20;
      for (let d = RB_OUT + 8; d < RB_OUT + ROAD_L - 5; d += step) {
        addLamp(-halfW - 0.5,  d,  0,            false, -1); // South road, left edge
        addLamp( halfW + 0.5,  d,  Math.PI,      false,  1); // South road, right edge
        addLamp(-halfW - 0.5, -d,  0,            false, -1); // North road, left edge
        addLamp( halfW + 0.5, -d,  Math.PI,      false,  1); // North road, right edge
        addLamp( d, -halfW - 0.5,  Math.PI / 2,  true,  -1); // East road, near edge
        addLamp( d,  halfW + 0.5, -Math.PI / 2,  true,   1); // East road, far edge
        addLamp(-d, -halfW - 0.5,  Math.PI / 2,  true,  -1); // West road, near edge
        addLamp(-d,  halfW + 0.5, -Math.PI / 2,  true,   1); // West road, far edge
      }
    });
  }

  // ── Player car (Trabant GLB) ───────────────────────────────────────────────
  _buildPlayerCar() {
    this._playerCarMesh    = null;
    this._frontWheelGroups = null;
    this._playerIndMeshes  = { left: [], right: [] };

    const loader = new GLTFLoader();
    loader.load('/car_white.glb', (gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale   = 4.5 / Math.max(size.x, size.z);
      const yOffset = -box.min.y * scale;
      gltf.scene.scale.setScalar(scale);
      gltf.scene.position.y = yOffset;
      gltf.scene.rotation.y = Math.PI;

      const hw = size.x * scale * 0.48;
      const hl = size.z * scale * 0.48;
      const g  = new THREE.Group();
      g.add(gltf.scene);

      const mat    = new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide });
      const frontGeo = new THREE.CircleGeometry(0.102, 16);
      const rearGeo  = new THREE.BoxGeometry(0.18, 0.14, 0.1);
      const flInds = [], frInds = [], rearInds = [];
      [
        { side: 'left',  x: -hw, z: -hl, part: 'front-left'  },
        { side: 'left',  x: -hw, z:  hl, part: 'rear'        },
        { side: 'right', x:  hw, z: -hl, part: 'front-right' },
        { side: 'right', x:  hw, z:  hl, part: 'rear'        },
      ].forEach(({ side, x, z, part }) => {
        const geo = part === 'rear' ? rearGeo : frontGeo;
        const ind = new THREE.Mesh(geo, mat);
        ind.position.set(x, 0.5, z); ind.visible = false;
        g.add(ind); this._playerIndMeshes[side].push(ind);
        if (part === 'front-left')  flInds.push({ mesh: ind, sx: -1 });
        else if (part === 'front-right') frInds.push({ mesh: ind, sx:  1 });
        else rearInds.push({ mesh: ind, sx: x < 0 ? -1 : 1 });
      });

      this._indTypes['player'] = {
        'front-left':  { hw, hl, y: 0.5, inds: flInds    },
        'front-right': { hw, hl, y: 0.5, inds: frInds    },
        'rear':        { hw, hl, y: 0.5, inds: rearInds  },
      };
      for (const part of ['front-left', 'front-right', 'rear']) {
        const d = this._defaultIndOff[part];
        this.setIndOffset(part, d.hw, d.y, d.hl);
      }

      this._playerCarMesh = g;
      this.scene.add(g);
    });
  }

  // ── Suburban buildings ──────────────────────────────────────────────────────
  _buildBuildings() {
    // Dublin suburban palette
    const SLATE_ROOF  = 0x46464e;  // dark slate grey
    const DOOR_COLORS = [0x2244cc, 0xd4aa00, 0x1e6622, 0xcc2020, 0x883399, 0x006655, 0x113388, 0x552200];
    const BRICK_WALLS = [0x8b3822, 0x963f28, 0x7c2e1a, 0x904030]; // Dublin red brick shades
    const RENDER_WALLS= [0xe0dcd0, 0xd6d0c4, 0xe8e4d8, 0xdad6ca]; // cream/grey pebble-dash

    // wallType 0 = red brick, 1 = cream render
    const addHouse = (x, z, w, d, h, doorIdx, wallType, ry = 0) => {
      const g        = new THREE.Group();
      const wc       = wallType === 0 ? BRICK_WALLS[doorIdx % BRICK_WALLS.length]
                                      : RENDER_WALLS[doorIdx % RENDER_WALLS.length];
      const wallMat  = new THREE.MeshLambertMaterial({ color: wc });
      const roofMat  = new THREE.MeshLambertMaterial({ color: SLATE_ROOF });
      const frameMat = new THREE.MeshLambertMaterial({ color: 0xf2ede6 }); // white window surround
      const winMat   = new THREE.MeshLambertMaterial({ color: 0x6688aa, transparent: true, opacity: 0.78 });
      const doorMat  = new THREE.MeshLambertMaterial({ color: DOOR_COLORS[doorIdx % DOOR_COLORS.length] });
      // Chimneys are always red brick even on rendered houses
      const chimMat  = new THREE.MeshLambertMaterial({ color: 0x8b3822 });
      const potMat   = new THREE.MeshLambertMaterial({ color: 0x6a2a14 });

      // Walls
      const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      walls.position.y = h / 2; walls.castShadow = true; walls.receiveShadow = true;
      g.add(walls);

      // Slate pitched roof
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.72, h * 0.55, 4), roofMat);
      roof.position.y = h + h * 0.27;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      g.add(roof);

      // Chimney stack (typical Dublin position — slightly off-centre on ridge)
      const chimneyH = h * 0.40;
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.52, chimneyH, 0.52), chimMat);
      chimney.position.set(w * 0.27, h + h * 0.27 + chimneyH * 0.3, 0);
      chimney.castShadow = true;
      g.add(chimney);
      // Chimney pot (terracotta cylinder)
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.38, 6), potMat);
      pot.position.set(w * 0.27, h + h * 0.27 + chimneyH * 0.62 + 0.19, 0);
      g.add(pot);

      // Windows — white painted surround (plane behind) + blue-grey glass (plane in front)
      [-w * 0.22, w * 0.22].forEach(wx => {
        const frame = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.3), frameMat);
        frame.position.set(wx, h * 0.62, -d / 2 - 0.05); g.add(frame);
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 1.12), winMat);
        win.position.set(wx, h * 0.62, -d / 2 - 0.08); g.add(win);
      });

      // Colourful front door (taller, narrower — Georgian proportion)
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.4), doorMat);
      door.position.set(0, h * 0.30, -d / 2 - 0.05); g.add(door);

      // Fanlight above door — classic Dublin Georgian detail
      const fanMat = new THREE.MeshLambertMaterial({ color: 0x88bbcc, transparent: true, opacity: 0.75 });
      const fan = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.3), fanMat);
      fan.position.set(0, h * 0.30 + 0.88, -d / 2 - 0.05); g.add(fan);

      g.position.set(x, 0, z);
      g.rotation.y = ry;
      this.scene.add(g);
    };

    const halfW = ROAD_W / 2;
    const sg    = halfW + 5;

    // ── South road — alternating brick / render pairs ────────────────────────
    [50, 65, 80, 95].forEach((z, i) => {
      const jitter = (Math.random() - 0.5) * 4;
      addHouse( sg + 4 + (i % 2) * 3, z + jitter, 8, 7, 5.5, i,     i % 2);
      addHouse(-sg - 4 - (i % 2) * 3, z + jitter, 8, 7, 5.0, i + 3, 1 - i % 2);
    });

    // ── North road ────────────────────────────────────────────────────────────
    [-50, -65, -80, -95].forEach((z, i) => {
      const jitter = (Math.random() - 0.5) * 4;
      addHouse( sg + 4, z + jitter, 7, 6, 5.0, i + 1, i % 2);
      addHouse(-sg - 4, z + jitter, 7, 6, 4.5, i + 5, 1 - i % 2);
    });

    // ── East road ─────────────────────────────────────────────────────────────
    [50, 65, 80].forEach((x, i) => {
      addHouse(x,  sg + 4, 7, 6, 5.0, i + 2, i % 2,       Math.PI / 2);
      addHouse(x, -sg - 4, 7, 6, 4.5, i + 6, 1 - i % 2,   Math.PI / 2);
    });

    // ── West road ─────────────────────────────────────────────────────────────
    [-50, -65, -80].forEach((x, i) => {
      addHouse(x,  sg + 4, 7, 6, 5.0, i + 4, 1 - i % 2,   Math.PI / 2);
      addHouse(x, -sg - 4, 7, 6, 4.5, i + 7, i % 2,        Math.PI / 2);
    });
  }

  _loadBuildings() {
    const loader = new GLTFLoader();
    const loadGLB = (url) => new Promise((resolve, reject) =>
      loader.load(url, resolve, undefined, reject));

    loadGLB('/building.glb').then((gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale   = 8 / Math.max(size.x, size.z);
      const yOffset = -box.min.y * scale;

      const off = ROAD_W / 2 + 4;
      const place = (x, z, ry, isEW, sign) => {
        const inst = gltf.scene.clone(true);
        inst.scale.setScalar(scale);
        inst.position.set(x, yOffset, z);
        inst.rotation.y = ry;
        this.scene.add(inst);
        this._houseRefs.push({ group: inst, isEW, sign });
      };

      [30, 44, 58, 72, 86, 100, 114, 128].forEach(d => {
        place( off,  d, -Math.PI / 2, false,  1);  place(-off,  d,  Math.PI / 2, false, -1);
        place( off, -d, -Math.PI / 2, false,  1);  place(-off, -d,  Math.PI / 2, false, -1);
        place( d,  off,  Math.PI,     true,   1);  place( d, -off,  0,           true,  -1);
        place(-d,  off,  Math.PI,     true,   1);  place(-d, -off,  0,           true,  -1);
      });
    }).catch(err => console.error('Building load failed:', err));

    // Yield signs — left side of each arm entrance (give-way line)
    loadGLB('/yield.glb').then((gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale   = 2.5 / Math.max(size.x, size.y, size.z);
      const yOffset = -box.min.y * scale;

      const place = (x, z, ry) => {
        const inst = gltf.scene.clone(true);
        inst.scale.setScalar(scale);
        inst.position.set(x, yOffset, z);
        inst.rotation.y = ry;
        this.scene.add(inst);
      };

      const E = RB_OUT + 1.5;  // just outside give-way line
      const L = ROAD_W / 2 + 0.8; // left edge of road from driver's view

      // South entrance: approaching from +z, left side is -x
      place(-L,  E,  0);
      // North entrance: approaching from -z, left side is +x
      place( L, -E,  Math.PI);
      // East entrance: approaching from +x, left side is +z
      place( E,  L,  Math.PI / 2);
      // West entrance: approaching from -x, left side is -z
      place(-E, -L, -Math.PI / 2);
    }).catch(err => console.error('Yield sign load failed:', err));
  }

  // ── Debug: real-time offset adjustment (called by UI sliders) ───────────────
  setOffsets(lampOff, treeOff, houseOff) {
    const halfW = ROAD_W / 2;
    this._lampRefs.forEach(({ group, isEW, sign }) => {
      if (isEW) group.position.z = sign * (halfW + lampOff);
      else      group.position.x = sign * (halfW + lampOff);
    });
    this._treeRefs.forEach(({ group, isEW, sign }) => {
      if (isEW) group.position.z = sign * (halfW + treeOff);
      else      group.position.x = sign * (halfW + treeOff);
    });
    this._houseRefs.forEach(({ group, isEW, sign }) => {
      if (isEW) group.position.z = sign * (halfW + houseOff);
      else      group.position.x = sign * (halfW + houseOff);
    });
  }

  _buildClouds() {
    const loader = new GLTFLoader();
    loader.load('/cloud.glb', (gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = false; child.receiveShadow = false; }
      });

      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      // normalise so the model's longest axis = 1 unit; user scale drives final size
      const norm = 1 / Math.max(size.x, size.y, size.z);

      // fractional positions — multiplied by spread at placement / update time
      const pts = [
        [-0.82, -0.64], [ 0.82, -0.82], [-0.64,  0.64], [ 1.00,  0.23],
        [ 0.00, -1.00], [-1.00,  0.09], [ 0.64,  0.82], [-0.36, -1.09],
        [ 1.09,  0.55], [ 0.00,  0.73], [-0.55,  0.36], [ 0.73, -0.36],
        [-0.73,  0.73], [ 0.36, -0.55],
      ];

      const y = 40, scale = 16, spread = 140;
      pts.forEach(([nx, nz]) => {
        const inst = gltf.scene.clone(true);
        inst.rotation.y = Math.random() * Math.PI * 2;
        inst.scale.setScalar(norm * scale);
        inst.position.set(nx * spread, y, nz * spread);
        this.scene.add(inst);
      });
    });
  }


  _buildSkyDome() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(400, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xc2d0da, side: THREE.BackSide }),
    );
    this.scene.add(sky);
  }

  // ── NPC traffic (state-machine path-following) ────────────────────────────
  _buildNPCs() {
    this.npcs = [];

    // Create NPC state with empty Group placeholders — GLB populated after load
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Group();
      mesh.visible = false;
      this.scene.add(mesh);
      this.npcs.push({
        mesh, indMeshes: { left: [], right: [] },
        state:            'despawned',
        respawnTimer:     i * 2.5,
        entryArm:         null,
        exitArm:          null,
        heading:          0,
        ringAngle:        0,
        ringRadius:       NPC_OUTER_R,
        ringTravelNeeded: 0,
        ringTravelDone:   0,
        speed:            NPC_SPEED,
        leftIndicator:    false,
        rightIndicator:   false,
        nearExitSignaled: false,
        transProgress: 0, transDuration: 0.5,
        transFromX: 0, transFromZ: 0, transFromH: 0,
        transToX:   0, transToZ:   0, transToH:   0,
      });
    }

    // Load all NPC car GLBs then populate NPCs
    const loader = new GLTFLoader();
    const loadGLB = (url) => new Promise(resolve => loader.load(url, resolve));
    Promise.all([loadGLB('/car_blue.glb'), loadGLB('/car_green.glb'), loadGLB('/car_orange.glb'), loadGLB('/car_purple.glb')]).then(([g1, g2, g3, g4]) => {
      // NPC 0=blue, 1=green, 2=orange, 3=purple, 4=blue (cycles)
      const carDefs = [
        { scene: g1.scene, rot: Math.PI, type: 'blue'   },
        { scene: g2.scene, rot: Math.PI, type: 'green'  },
        { scene: g3.scene, rot: Math.PI, type: 'orange' },
        { scene: g4.scene, rot: Math.PI, type: 'purple' },
        { scene: g1.scene, rot: Math.PI, type: 'blue'   },
      ];

      const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide });
      this.npcs.forEach((npc, i) => {
        const { scene, rot, type } = carDefs[i];
        const model = scene.clone(true);
        model.traverse(child => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = false;
          }
        });
        const box  = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const scale   = 4.2 / Math.max(size.x, size.z);
        const yOffset = -box.min.y * scale;
        const hw      = size.x * scale * 0.48;
        const hl      = size.z * scale * 0.48;
        model.scale.setScalar(scale);
        model.position.y = yOffset;
        model.rotation.y = rot;
        npc.mesh.add(model);

        if (!this._indTypes[type]) this._indTypes[type] = {
          'front-left':  { hw, hl, y: 0.5, inds: [] },
          'front-right': { hw, hl, y: 0.5, inds: [] },
          'rear':        { hw, hl, y: 0.5, inds: [] },
        };
        const frontGeoN = new THREE.CircleGeometry(0.102, 16);
        const rearGeoN  = new THREE.BoxGeometry(0.18, 0.14, 0.1);
        [
          { side: 'left',  x: -hw, z: -hl, part: 'front-left'  },
          { side: 'left',  x: -hw, z:  hl, part: 'rear'        },
          { side: 'right', x:  hw, z: -hl, part: 'front-right' },
          { side: 'right', x:  hw, z:  hl, part: 'rear'        },
        ].forEach(({ side, x, z, part }) => {
          const geo = part === 'rear' ? rearGeoN : frontGeoN;
          const ind = new THREE.Mesh(geo, mat);
          ind.position.set(x, 0.5, z); ind.visible = false;
          npc.mesh.add(ind); npc.indMeshes[side].push(ind);
          const sx = x < 0 ? -1 : 1;
          this._indTypes[type][part].inds.push({ mesh: ind, sx });
        });

      });
      for (const part of ['front-left', 'front-right', 'rear']) {
        const d = this._defaultIndOff[part];
        this.setIndOffset(part, d.hw, d.y, d.hl);
      }
    });
  }

  // ── Indicator debug API ────────────────────────────────────────────────────
  // part = 'front-left' | 'front-right' | 'rear'
  setIndOffset(part, hwOff, yOff, hlOff) {
    const zSign = part.startsWith('front') ? -1 : 1;
    Object.values(this._indTypes).forEach(t => {
      const g = t[part];
      if (!g) return;
      g.inds.forEach(({ mesh, sx }) => {
        mesh.position.set(sx * (g.hw + hwOff), g.y + yOff, zSign * (g.hl + hlOff));
      });
    });
  }

  setIndDebugView(view) {
    this._indDebugView = view;
    if      (view === 'front') { this._indOrbit.az = 0;           this._indOrbit.el = 0.30; this._indOrbit.r = 11; }
    else if (view === 'side')  { this._indOrbit.az = Math.PI / 2; this._indOrbit.el = 0.35; this._indOrbit.r = 22; }
    else                       { this._indOrbit.az = Math.PI;     this._indOrbit.el = 0.30; this._indOrbit.r = 11; }
  }

  setIndDebugMode(on) {
    this._indDebug     = on;
    this._indDebugView = 'back';
    this._indOrbit     = { az: Math.PI, el: 0.30, r: 11 };
    if (on) {
      // Show only the player car, freeze it in the middle of the south arm
      this.car.speed   = 0;
      this.car.yawRate = 0;
      this.car.heading = 0;
      this.car.pos.set(0, 0, 72);

      // Hide all NPCs
      this.npcs.forEach(npc => {
        npc.state        = 'debug';
        npc.mesh.visible = false;
        [...npc.indMeshes.left, ...npc.indMeshes.right].forEach(m => { m.visible = false; });
      });

      // Force-show player indicators
      if (this._playerIndMeshes) {
        [...this._playerIndMeshes.left, ...this._playerIndMeshes.right].forEach(m => { m.visible = true; });
      }

      // Orbit drag listeners
      const canvas = this.renderer.domElement;
      this._indOnMouseDown = (e) => {
        this._indDragActive = true;
        this._indDragLast   = { x: e.clientX, y: e.clientY };
      };
      this._indOnMouseMove = (e) => {
        if (!this._indDragActive) return;
        const dx = e.clientX - this._indDragLast.x;
        const dy = e.clientY - this._indDragLast.y;
        this._indOrbit.az -= dx * 0.008;
        this._indOrbit.el  = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, this._indOrbit.el - dy * 0.008));
        this._indDragLast  = { x: e.clientX, y: e.clientY };
      };
      this._indOnMouseUp = () => { this._indDragActive = false; };
      canvas.addEventListener('mousedown', this._indOnMouseDown);
      window.addEventListener('mousemove', this._indOnMouseMove);
      window.addEventListener('mouseup',   this._indOnMouseUp);
    } else {
      this.npcs.forEach(npc => {
        npc.state        = 'despawned';
        npc.respawnTimer = 2 + Math.random() * 3;
        npc.mesh.visible = false;
        [...npc.indMeshes.left, ...npc.indMeshes.right].forEach(m => { m.visible = false; });
      });
      if (this._playerIndMeshes) {
        [...this._playerIndMeshes.left, ...this._playerIndMeshes.right].forEach(m => { m.visible = false; });
      }

      // Remove drag listeners
      if (this._indOnMouseMove) {
        this.renderer.domElement.removeEventListener('mousedown', this._indOnMouseDown);
        window.removeEventListener('mousemove', this._indOnMouseMove);
        window.removeEventListener('mouseup',   this._indOnMouseUp);
        this._indOnMouseDown = this._indOnMouseMove = this._indOnMouseUp = null;
      }
    }
  }

  _spawnNPC(npc) {
    const TWO_PI    = Math.PI * 2;
    const entryName = ARM_NAMES[Math.floor(Math.random() * ARM_NAMES.length)];
    const exitCands = ARM_NAMES.filter(a => a !== entryName);
    const exitName  = exitCands[Math.floor(Math.random() * exitCands.length)];
    const entryCfg  = ARM_CFG[entryName];

    npc.entryArm   = entryName;
    npc.exitArm    = exitName;
    npc.heading    = entryCfg.approachHeading;

    // Determine outer/inner lane by first estimating travel angle using outer radius,
    // then applying the same rules the player must follow:
    //   exit 1 (~π/2 travel)  → outer approach lane + left indicator
    //   exit 2 (~π travel)    → either lane, no indicator
    //   exit 3 (~3π/2 travel) → inner approach lane + right indicator
    const tempEntry = this._ringIntersect(entryName, NPC_OUTER_R, true, true);
    const tempExit  = this._ringIntersect(exitName,  NPC_OUTER_R, true, false);
    const tempAdv   = (tempEntry.ringAngle + ENTRY_ADVANCE + TWO_PI) % TWO_PI;
    const tempAdvX  = (tempExit.ringAngle  - EXIT_ADVANCE  + TWO_PI) % TWO_PI;
    let approxTravel = (tempAdvX - tempAdv + TWO_PI) % TWO_PI;
    if (approxTravel < 0.2) approxTravel += TWO_PI;

    const outer = approxTravel < Math.PI * 0.65 ? true          // exit 1: outer lane
                : approxTravel > Math.PI * 1.35 ? false         // exit 3: inner lane
                : Math.random() < 0.5;                          // exit 2: either

    npc.ringRadius = outer ? NPC_OUTER_R : NPC_INNER_R;

    // Compute lane-specific ring intersection angles so ringTravelNeeded is accurate
    const entryInt = this._ringIntersect(entryName, npc.ringRadius, outer, true);
    const exitInt  = this._ringIntersect(exitName,  npc.ringRadius, outer, false);
    // Advance the effective ring entry/exit angles so bezierArc produces C-curves
    const advEntryAngle = (entryInt.ringAngle + ENTRY_ADVANCE + TWO_PI) % TWO_PI;
    const advExitAngle  = (exitInt.ringAngle  - EXIT_ADVANCE  + TWO_PI) % TWO_PI;
    npc.ringTravelNeeded = (advExitAngle - advEntryAngle + TWO_PI) % TWO_PI;
    if (npc.ringTravelNeeded < 0.2) npc.ringTravelNeeded += TWO_PI; // safety: avoid near-zero
    npc.ringTravelDone   = 0;
    npc.state            = 'approaching';

    // Approach indicator mirrors player rules
    npc.leftIndicator    = approxTravel < Math.PI * 0.65;  // exit 1 → left
    npc.rightIndicator   = approxTravel > Math.PI * 1.35;  // exit 3 → right
    npc.nearExitSignaled = false;

    const [sx, sz] = entryCfg.approachLanePos(outer);
    npc.mesh.position.set(sx, 0, sz);
    npc.mesh.rotation.y = -npc.heading;
    npc.mesh.visible    = true;
  }

  // Returns the ring intersection point for an NPC lane on the given arm.
  // isEntry=true  → approaching lane (NPC enters ring from this arm)
  // isEntry=false → departure lane  (NPC exits  ring to  this arm)
  // Returns { x, z, ringAngle, tangentH }
  // Ring angle convention: x = r·sin(θ), z = −r·cos(θ), θ = atan2(x, −z)
  _ringIntersect(arm, r, outer, isEntry) {
    const TWO_PI = Math.PI * 2;
    const w = outer ? LANE_W * 1.5 : LANE_W * 0.5; // lane-centre offset from road centre
    const h = Math.sqrt(r * r - w * w);              // perpendicular distance along ring

    // Each arm's near-side approach lanes and far-side departure lanes:
    //   south: approach x<0 (west/near-side), depart x>0
    //   north: approach x>0 (east/near-side), depart x<0
    //   east:  approach z>0 (south/near-side), depart z<0
    //   west:  approach z<0 (north/near-side), depart z>0
    let x, z;
    switch (arm) {
      case 'south': x = isEntry ? -w :  w;  z =  h; break; // south side (z > 0)
      case 'north': x = isEntry ?  w : -w;  z = -h; break; // north side (z < 0)
      case 'east':  x =  h;  z = isEntry ?  w : -w; break; // east side  (x > 0)
      case 'west':  x = -h;  z = isEntry ? -w :  w; break; // west side  (x < 0)
    }

    const rawAngle  = Math.atan2(x, -z);
    const ringAngle = ((rawAngle % TWO_PI) + TWO_PI) % TWO_PI;
    // Tangent heading for CW ring travel at this angle
    const tangentH  = Math.atan2(Math.cos(ringAngle), -Math.sin(ringAngle));
    return { x, z, ringAngle, tangentH };
  }

  // Returns the speed this NPC should travel given obstacles directly ahead.
  // Checks the player car and every other active NPC.
  // Returns a 0–1 speed scale for arc transitions based on player proximity.
  // Mirrors the ramp logic in _npcFollowSpeed: smooth deceleration → full stop.
  _arcSpeedScale(npcPos) {
    if (this.car.failed) return 1;
    const SLOW_START = 10, STOP_DIST = 4;
    const dx = this.car.pos.x - npcPos.x;
    const dz = this.car.pos.z - npcPos.z;
    const d  = Math.sqrt(dx * dx + dz * dz);
    if (d >= SLOW_START) return 1;
    if (d <= STOP_DIST)  return 0;
    return (d - STOP_DIST) / (SLOW_START - STOP_DIST);
  }

  _npcFollowSpeed(npc) {
    const LOOK_AHEAD  = 12;   // start braking when obstacle is this far ahead
    const STOP_DIST   =  4;   // full stop at this gap
    const LANE_HALF   =  2.2; // lateral tolerance — must be in roughly the same lane
    const TWO_PI      = Math.PI * 2;

    // ── Roundabout entry yield ────────────────────────────────────────────────
    // Give way to traffic already on the ring. Ring cars approach from the side,
    // so the forward-follow check below can't see them — we need a dedicated
    // angular sweep of the ring near the entry point.
    if (npc.state === 'approaching') {
      const pos  = npc.mesh.position;
      const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
      if (dist < RB_OUT + 14) {
        const isOuter    = npc.ringRadius === NPC_OUTER_R;
        const entryInt   = this._ringIntersect(npc.entryArm, npc.ringRadius, isOuter, true);
        const entryAngle = entryInt.ringAngle;

        // Yield to the player car only if they are actually on the ring
        if (!this.car.failed && this.car.phase === 'on_roundabout') {
          const px = this.car.pos.x, pz = this.car.pos.z;
          const playerAngle = ((Math.atan2(px, -pz) % TWO_PI) + TWO_PI) % TWO_PI;
          const gap = (entryAngle - playerAngle + TWO_PI) % TWO_PI;
          if (gap < 0.9) return 0;
        }

        for (const other of this.npcs) {
          if (other === npc) continue;
          if (other.state === 'despawned' || other.state === 'approaching') continue;

          const ox = other.mesh.position.x;
          const oz = other.mesh.position.z;

          if (other.state === 'on_roundabout') {
            // Yield if ring car is within CONFLICT_ARC radians before our entry (CW)
            const otherAngle = ((Math.atan2(ox, -oz) % TWO_PI) + TWO_PI) % TWO_PI;
            const gap = (entryAngle - otherAngle + TWO_PI) % TWO_PI;
            if (gap < 0.9) return 0; // stop — ring car hasn't passed yet
          } else {
            // entering_ring / leaving_ring: yield if they're physically near the entry zone
            const dx = ox - entryInt.x, dz = oz - entryInt.z;
            if (dx * dx + dz * dz < 10 * 10) return 0; // entry zone occupied
          }
        }
      }
    }

    // Current forward direction in world XZ
    let dirX, dirZ;
    if (npc.state === 'on_roundabout') {
      // Tangent of clockwise ring travel: d/dθ (r·sinθ, −r·cosθ) = (cosθ, sinθ)
      dirX =  Math.cos(npc.ringAngle);
      dirZ =  Math.sin(npc.ringAngle);
    } else {
      dirX =  Math.sin(npc.heading);
      dirZ = -Math.cos(npc.heading);
    }

    // Gather obstacles: player + other active NPCs
    const obstacles = [];
    if (!this.car.failed) obstacles.push(this.car.pos);
    for (const other of this.npcs) {
      if (other === npc || other.state === 'despawned') continue;
      obstacles.push(other.mesh.position);
    }

    let closestFwd = Infinity;
    for (const obs of obstacles) {
      const dx  = obs.x - npc.mesh.position.x;
      const dz  = obs.z - npc.mesh.position.z;
      const fwd = dx * dirX + dz * dirZ;          // signed forward distance
      const lat = Math.abs(dx * dirZ - dz * dirX); // lateral distance (cross product)
      if (fwd > 0 && fwd < LOOK_AHEAD && lat < LANE_HALF) {
        closestFwd = Math.min(closestFwd, fwd);
      }
    }

    if (closestFwd === Infinity)   return NPC_SPEED;
    if (closestFwd <= STOP_DIST)   return 0;
    // Linear ramp: full speed at LOOK_AHEAD, zero at STOP_DIST
    return NPC_SPEED * (closestFwd - STOP_DIST) / (LOOK_AHEAD - STOP_DIST);
  }

  _updateNPCs(dt, dtScale) {
    const TWO_PI = Math.PI * 2;

    // Estimates the arc length of a Hermite bezier by sampling 12 segments.
    // Used so transDuration matches actual path length, not chord length.
    const bezierArcLen = (fx, fz, fh, tx, tz, th) => {
      const d   = Math.sqrt((tx - fx) ** 2 + (tz - fz) ** 2);
      const sc  = d / 3;
      const p1x = fx + Math.sin(fh) * sc,  p1z = fz - Math.cos(fh) * sc;
      const p2x = tx - Math.sin(th) * sc,  p2z = tz + Math.cos(th) * sc;
      let len = 0, px = fx, pz = fz;
      for (let i = 1; i <= 12; i++) {
        const t = i / 12, mt = 1 - t;
        const x = mt*mt*mt*fx + 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t*tx;
        const z = mt*mt*mt*fz + 3*mt*mt*t*p1z + 3*mt*t*t*p2z + t*t*t*tz;
        len += Math.sqrt((x - px) ** 2 + (z - pz) ** 2);
        px = x; pz = z;
      }
      return len;
    };

    // Cubic Hermite-bezier: given two endpoints with heading tangents,
    // returns { x, z, h } along the arc at parameter t ∈ [0,1].
    // The car follows a curved road-like path and always points along it.
    const bezierArc = (fx, fz, fh, tx, tz, th, t) => {
      const d   = Math.sqrt((tx - fx) ** 2 + (tz - fz) ** 2);
      const sc  = d / 3;                                  // control-point reach
      // Control points: extend in the direction of each endpoint's heading
      const p1x = fx + Math.sin(fh) * sc,  p1z = fz - Math.cos(fh) * sc;
      const p2x = tx - Math.sin(th) * sc,  p2z = tz + Math.cos(th) * sc;
      const mt  = 1 - t;
      // Position on cubic bezier
      const x = mt*mt*mt*fx + 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t*tx;
      const z = mt*mt*mt*fz + 3*mt*mt*t*p1z + 3*mt*t*t*p2z + t*t*t*tz;
      // Tangent of bezier → heading (forward = (sin h, −cos h) in xz)
      const bx = 3*mt*mt*(p1x-fx) + 6*mt*t*(p2x-p1x) + 3*t*t*(tx-p2x);
      const bz = 3*mt*mt*(p1z-fz) + 6*mt*t*(p2z-p1z) + 3*t*t*(tz-p2z);
      const h  = (bx*bx + bz*bz > 1e-6) ? Math.atan2(bx, -bz) : (t < 0.5 ? fh : th);
      return { x, z, h };
    };

    this.npcs.forEach(npc => {
      if (npc.state === 'despawned') {
        npc.respawnTimer -= dt;
        if (npc.respawnTimer <= 0) this._spawnNPC(npc);
        return;
      }

      const pos = npc.mesh.position;

      // Follow-speed only applies during free-movement states
      if (npc.state === 'approaching' || npc.state === 'on_roundabout' || npc.state === 'exiting') {
        npc.speed = this._npcFollowSpeed(npc);
      }

      // ── Straight approach ──────────────────────────────────────────────────
      if (npc.state === 'approaching') {
        pos.x += Math.sin(npc.heading) * npc.speed * dtScale;
        pos.z -= Math.cos(npc.heading) * npc.speed * dtScale;
        npc.mesh.rotation.y = -npc.heading;

        const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
        if (dist <= RB_OUT + 6) {
          // Smooth arc onto ring — target the ENTRY_ADVANCE point CW past the geometric
          // lane–ring intersection, which gives bezierArc a lateral offset large enough
          // to produce a clean C-curve instead of an S-curve.
          const isOuter    = npc.ringRadius === NPC_OUTER_R;
          const entryInt   = this._ringIntersect(npc.entryArm, npc.ringRadius, isOuter, true);
          const advEntryAng = (entryInt.ringAngle + ENTRY_ADVANCE + Math.PI * 2) % (Math.PI * 2);
          const advEntryX  = npc.ringRadius * Math.sin(advEntryAng);
          const advEntryZ  = -npc.ringRadius * Math.cos(advEntryAng);
          const advEntryH  = Math.atan2(Math.cos(advEntryAng), -Math.sin(advEntryAng));
          npc.ringAngle  = advEntryAng;
          npc.transFromX = pos.x;       npc.transFromZ = pos.z;       npc.transFromH = npc.heading;
          npc.transToX   = advEntryX;   npc.transToZ   = advEntryZ;   npc.transToH   = advEntryH;
          npc.transDuration = bezierArcLen(
            npc.transFromX, npc.transFromZ, npc.transFromH,
            npc.transToX,   npc.transToZ,   npc.transToH,
          ) / (NPC_SPEED * 60);
          npc.transProgress = 0;
          npc.state = 'entering_ring';
        }

      // ── Smooth arc: road → ring ────────────────────────────────────────────
      } else if (npc.state === 'entering_ring') {
        npc.transProgress = Math.min(npc.transProgress + dt / npc.transDuration * this._arcSpeedScale(pos), 1);
        const arc = bezierArc(
          npc.transFromX, npc.transFromZ, npc.transFromH,
          npc.transToX,   npc.transToZ,   npc.transToH,
          npc.transProgress,
        );
        pos.x = arc.x;  pos.z = arc.z;
        npc.heading = arc.h;
        npc.mesh.rotation.y = -npc.heading;

        if (npc.transProgress >= 1) {
          pos.x = npc.transToX;  pos.z = npc.transToZ;
          npc.heading = npc.transToH;
          npc.ringTravelDone = 0;
          npc.state = 'on_roundabout';
        }

      // ── Circular ring travel ───────────────────────────────────────────────
      } else if (npc.state === 'on_roundabout') {
        const dθ = npc.speed * dtScale / npc.ringRadius;
        npc.ringAngle       = (npc.ringAngle + dθ) % TWO_PI;
        npc.ringTravelDone += dθ;
        pos.x = npc.ringRadius * Math.sin(npc.ringAngle);
        pos.z = -npc.ringRadius * Math.cos(npc.ringAngle);
        npc.mesh.rotation.y = -Math.atan2(Math.cos(npc.ringAngle), -Math.sin(npc.ringAngle));

        // Near-exit: signal left ~40° before the exit (mirrors player check-c rule)
        if (!npc.nearExitSignaled && npc.ringTravelDone >= npc.ringTravelNeeded - 0.7) {
          npc.nearExitSignaled = true;
          npc.leftIndicator    = true;
          npc.rightIndicator   = false;
        }

        if (npc.ringTravelDone >= npc.ringTravelNeeded) {
          // Smooth arc off ring → lane-specific exit intersection + 8 units down exit road
          const isOuter  = npc.ringRadius === NPC_OUTER_R;
          const exitInt  = this._ringIntersect(npc.exitArm, npc.ringRadius, isOuter, false);
          const exitCfg  = ARM_CFG[npc.exitArm];
          const fromH    = Math.atan2(Math.cos(npc.ringAngle), -Math.sin(npc.ringAngle));
          npc.transFromX = pos.x;
          npc.transFromZ = pos.z;
          npc.transFromH = fromH;
          npc.transToX   = exitInt.x + Math.sin(exitCfg.departHeading) * 8;
          npc.transToZ   = exitInt.z - Math.cos(exitCfg.departHeading) * 8;
          npc.transToH   = exitCfg.departHeading;
          npc.transDuration = bezierArcLen(
            npc.transFromX, npc.transFromZ, npc.transFromH,
            npc.transToX,   npc.transToZ,   npc.transToH,
          ) / (NPC_SPEED * 60);
          npc.transProgress = 0;
          npc.state = 'leaving_ring';
        }

      // ── Smooth arc: ring → exit road ──────────────────────────────────────
      } else if (npc.state === 'leaving_ring') {
        npc.transProgress = Math.min(npc.transProgress + dt / npc.transDuration * this._arcSpeedScale(pos), 1);
        const arc = bezierArc(
          npc.transFromX, npc.transFromZ, npc.transFromH,
          npc.transToX,   npc.transToZ,   npc.transToH,
          npc.transProgress,
        );
        pos.x = arc.x;  pos.z = arc.z;
        npc.heading = arc.h;
        npc.mesh.rotation.y = -npc.heading;

        if (npc.transProgress >= 1) {
          pos.x = npc.transToX;  pos.z = npc.transToZ;
          npc.heading = npc.transToH;
          npc.mesh.rotation.y = -npc.heading;
          // Cancel indicator once fully on the exit road
          npc.leftIndicator  = false;
          npc.rightIndicator = false;
          npc.state = 'exiting';
        }

      // ── Straight exit ──────────────────────────────────────────────────────
      } else if (npc.state === 'exiting') {
        pos.x += Math.sin(npc.heading) * npc.speed * dtScale;
        pos.z -= Math.cos(npc.heading) * npc.speed * dtScale;
        npc.mesh.rotation.y = -npc.heading;

        if (ARM_CFG[npc.exitArm].despawnCheck(pos)) {
          npc.mesh.visible = false;
          npc.state        = 'despawned';
          npc.respawnTimer = 3 + Math.random() * 3;
        }
      }

      // ── Sync indicator lights ───────────────────────────────────────────────
      if (npc.indMeshes) {
        const on = this._blinkOn;
        npc.indMeshes.left.forEach(m  => { m.visible = npc.leftIndicator  && on; });
        npc.indMeshes.right.forEach(m => { m.visible = npc.rightIndicator && on; });
      }
    });
  }

  // ── Indicator click sound ─────────────────────────────────────────────────
  _playIndicatorClick() {
    if (this._muted) return;
    try {
      if (!this._audioCtx) {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') ctx.resume();

      // Short relay-click: square wave with fast exponential decay
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.025);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.025);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.03);
    } catch (_) { /* audio unavailable */ }
  }

  // ── NPC horn beep ─────────────────────────────────────────────────────────
  _playHorn() {
    if (this._muted) return;
    try {
      if (!this._audioCtx) {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const t   = ctx.currentTime;
      const dur = 0.42;

      // Soft-clip waveshaper — adds harmonic richness without harsh digital clipping
      const shaper = ctx.createWaveShaper();
      const n = 512;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = (Math.PI + 180) * x / (Math.PI + 180 * Math.abs(x));
      }
      shaper.curve = curve;

      // Master envelope — fast attack, hold, soft release
      const master = ctx.createGain();
      master.connect(shaper);
      shaper.connect(ctx.destination);
      master.gain.setValueAtTime(0,    t);
      master.gain.linearRampToValueAtTime(0.55, t + 0.018);
      master.gain.setValueAtTime(0.55, t + dur - 0.06);
      master.gain.linearRampToValueAtTime(0,    t + dur);

      // Two-tone horn: 392 Hz (G4) + 494 Hz (B4) — classic European car horn interval
      [
        { freq: 392, vol: 0.65 },
        { freq: 494, vol: 0.50 },
      ].forEach(({ freq, vol }) => {
        const osc    = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain   = ctx.createGain();

        // Sawtooth for harmonic richness
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq,          t);
        // Tiny pitch sag mid-blast — real horns sag slightly under load
        osc.frequency.linearRampToValueAtTime(freq * 0.994, t + 0.12);
        osc.frequency.linearRampToValueAtTime(freq * 0.997, t + dur);

        // Lowpass filter softens the raw sawtooth into a horn-like timbre
        filter.type            = 'lowpass';
        filter.frequency.value = 1800;
        filter.Q.value         = 1.8;

        gain.gain.value = vol;

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(master);

        osc.start(t);
        osc.stop(t + dur + 0.05);
      });
    } catch (_) {}
  }

  // ── Stationary horn check ─────────────────────────────────────────────────
  _updateHornCheck(dt) {
    const car = this.car;
    if (car.failed || car.phase === 'completed') return;

    const moving = Math.abs(car.speed) > 0.02;
    if (moving) {
      this._stationaryTimer = 0;
      this._hornCooldown    = 0;
      return;
    }

    this._stationaryTimer += dt;
    if (this._hornCooldown > 0) {
      this._hornCooldown -= dt;
      return;
    }
    if (this._stationaryTimer < 3) return;

    // Is any NPC directly behind the player?
    const onRoundabout = car.phase === 'on_roundabout';
    const sinH = Math.sin(car.heading);
    const cosH = Math.cos(car.heading);
    const npcBehind = this.npcs.some(npc => {
      if (npc.state === 'despawned') return false;
      const dx = npc.mesh.position.x - car.pos.x;
      const dz = npc.mesh.position.z - car.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 35 || dist < 1) return false;
      // Must be in rear hemisphere (behind the player)
      const dot = dx * (-sinH) + dz * cosH;
      if (dot < 2) return false;
      // On straight road: also require same lane + matching heading.
      // On roundabout: skip these — curved paths cause large lateral offsets
      // and heading divergence even for cars directly behind in the arc.
      if (!onRoundabout) {
        const lat = Math.abs(dx * (-cosH) - dz * sinH);
        if (lat > 1.2) return false;
        const headingDiff = Math.abs(Math.atan2(
          Math.sin(npc.heading - car.heading),
          Math.cos(npc.heading - car.heading)
        ));
        if (headingDiff >= 1.2) return false;
      }
      return true;
    });
    if (!npcBehind) return;

    // Is the road ahead of the player clear (no NPC within 20 units forward)?
    const pathClear = !this.npcs.some(npc => {
      if (npc.state === 'despawned') return false;
      const dx = npc.mesh.position.x - car.pos.x;
      const dz = npc.mesh.position.z - car.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 20) return false;
      const dot = dx * sinH + dz * (-cosH);
      return dot > 3;
    });
    if (!pathClear) return;

    this._playHorn();
    this._hornCooldown = 3;
  }

  // ── Mute toggle ───────────────────────────────────────────────────────────
  toggleMute() {
    this._muted = !this._muted;
    if (this._engMaster) this._engMaster.gain.value = this._muted ? 0 : 0.55;
    return this._muted;
  }

  // ── Engine sound ──────────────────────────────────────────────────────────
  _initEngineSound() {
    if (this._engOsc) return; // already started
    try {
      if (!this._audioCtx) {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = this._audioCtx;

      // Main tone: sawtooth rich in harmonics
      this._engOsc = ctx.createOscillator();
      this._engOsc.type = 'sawtooth';
      this._engOsc.frequency.value = 55;

      // Sub octave: adds low-end body
      this._engSub = ctx.createOscillator();
      this._engSub.type = 'triangle';
      this._engSub.frequency.value = 27.5;

      // Individual gain nodes
      this._engGain    = ctx.createGain();
      this._engSubGain = ctx.createGain();
      this._engGain.gain.value    = 0.07;
      this._engSubGain.gain.value = 0.05;

      // Lowpass filter shapes the timbre (opens as RPM rises)
      this._engFilter = ctx.createBiquadFilter();
      this._engFilter.type = 'lowpass';
      this._engFilter.frequency.value = 380;
      this._engFilter.Q.value = 1.8;

      // Master volume
      this._engMaster = ctx.createGain();
      this._engMaster.gain.value = 0.55;

      this._engOsc.connect(this._engGain);
      this._engSub.connect(this._engSubGain);
      this._engGain.connect(this._engFilter);
      this._engSubGain.connect(this._engFilter);
      this._engFilter.connect(this._engMaster);
      this._engMaster.connect(ctx.destination);

      this._engOsc.start();
      this._engSub.start();
    } catch (_) {}
  }

  _updateEngineSound() {
    if (!this._engOsc || !this._audioCtx) return;
    const ctx = this._audioCtx;
    if (ctx.state === 'suspended') { ctx.resume(); return; }

    const now  = ctx.currentTime;
    const tc   = 0.06; // smoothing time constant (seconds)
    const spd  = Math.abs(this.car.speed) / MAX_SPEED; // 0..1

    // Pitch: idle ~55 Hz, full throttle ~210 Hz
    const freq = 55 + spd * 155;
    this._engOsc.frequency.setTargetAtTime(freq,       now, tc);
    this._engSub.frequency.setTargetAtTime(freq / 2,   now, tc);

    // Filter opens as revs rise (muffled idle → bright under load)
    this._engFilter.frequency.setTargetAtTime(350 + spd * 2200, now, tc);

    // Volume swells with speed; idle is a quiet rumble
    const vol = 0.03 + spd * 0.10;
    this._engGain.gain.setTargetAtTime(vol,        now, tc);
    this._engSubGain.gain.setTargetAtTime(vol * 0.65, now, tc);
  }

  // ── Dashboard overlay (unused in third-person mode) ───────────────────────
  _initDashboard() {
    // No dashboard overlay in third-person view
  }

  // ── Camera — third-person chase cam ────────────────────────────────────────
  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 600);
    // Initialise smooth-follow position directly behind starting car position
    const { pos, heading } = this.car;
    this._camLag = new THREE.Vector3(
      pos.x - Math.sin(heading) * CAM_BACK,
      0,
      pos.z + Math.cos(heading) * CAM_BACK,
    );
    this._updateCamera();
  }

  _updateCamera(dtScale = 1) {
    const { pos, heading, speed } = this.car;
    const { back, h, lookY, lookFwd, fov } = this._camCfg;
    const fwdX =  Math.sin(heading);
    const fwdZ = -Math.cos(heading);

    // Target position: directly behind the car
    const tx = pos.x - fwdX * back;
    const tz = pos.z - fwdZ * back;

    // Smooth lag: dt-compensated so camera feel is consistent at any frame rate
    const camAlpha = 1 - Math.pow(0.9, dtScale);
    this._camLag.x += (tx - this._camLag.x) * camAlpha;
    this._camLag.z += (tz - this._camLag.z) * camAlpha;

    this.camera.position.set(this._camLag.x, h, this._camLag.z);
    this.camera.lookAt(pos.x + fwdX * lookFwd, lookY, pos.z + fwdZ * lookFwd);

    this.camera.fov = fov + (Math.abs(speed) / MAX_SPEED) * 8;
    this.camera.updateProjectionMatrix();
  }

  setCamCfg(cfg) {
    Object.assign(this._camCfg, cfg);
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ── Mission assignment ─────────────────────────────────────────────────────
  _assignMission() {
    const exit = EXITS[this._missionIndex % EXITS.length];
    this.car.targetExit       = exit.name;
    this.car.targetExitNum    = exit.num;
    this.car.exitTravelTarget = exit.travelAngle;
    this.car.requiredLane     = exit.requiredLane;
    this.car.requiredRingLane = exit.requiredRingLane;
    this._checkADone            = false;
    this._checkBDone            = false;
    this._checkCDone            = false;
    this._checkDDone            = false;
    this._checkLaneApproachDone = false;
  }

  // ── Exit preview and begin gameplay ────────────────────────────────────────
  startGame() {
    this._preview = false;
    // Re-sync camera lag to current car position so it doesn't snap
    const { pos, heading } = this.car;
    const { back } = this._camCfg;
    this._camLag.set(
      pos.x - Math.sin(heading) * back,
      0,
      pos.z + Math.cos(heading) * back,
    );
  }

  setPreviewCfg(cfg) {
    Object.assign(this._previewCfg, cfg);
  }

  // ── Advance to next mission after a successful exit ─────────────────────────
  nextMission() {
    this._missionIndex++;
    this.restart();
  }

  // ── Player indicator toggle (Q = left, E = right; mutually exclusive) ───────
  _toggleIndicator(side) {
    const car = this.car;
    if (side === 'left') {
      car.leftIndicator  = !car.leftIndicator;
      car.rightIndicator = false;
    } else {
      car.rightIndicator = !car.rightIndicator;
      car.leftIndicator  = false;
    }
    // Play click immediately on toggle
    this._playIndicatorClick();
  }

  // ── Restart (full reset + new mission) ─────────────────────────────────────
  restart() {
    const car = this.car;
    car.pos.set(-LANE_W * 1.5, 0, RB_OUT + ROAD_L * 0.55);
    car.heading       = 0;
    car.speed         = 0;
    car.steer         = 0;
    car.yawRate       = 0;
    car.phase         = 'approaching';
    car.leftIndicator = false;
    car.rightIndicator= false;
    car.entryAngle    = SOUTH_ENTRY_ANGLE;
    car.traveledAngle = 0;
    car.approachLane  = 'outer';
    car.ringLane      = 'outer';
    car.graceActive   = false;
    car.graceTimer    = 0;
    car.graceRequired = null;
    car.failed        = false;
    car.failReason    = null;
    this._prevRingAngle      = null;
    this._prevDistFromCenter = null;
    this._completeTimer      = 0;
    this._assignMission();
  }

  // ── State machine update ────────────────────────────────────────────────────
  _updateStateMachine(dt) {
    const car    = this.car;
    const TWO_PI = Math.PI * 2;

    if (car.failed || car.phase === 'completed') return;

    // dist needed throughout → compute once at top
    const dist = Math.sqrt(car.pos.x * car.pos.x + car.pos.z * car.pos.z);

    // ── Off-road check ─────────────────────────────────────────────────────
    // Each arm is extended INWARD by 8 units (RB_OUT - 8) to bridge the gap
    // between the rectangular arm zone and the circular ring zone.  At the
    // outer lane edge (|x|=7) the ring boundary is ~1.1 units inside RB_OUT,
    // so an 8-unit overlap gives plenty of margin with no gameplay side-effects.
    const ARM_OVERLAP = 1.5;
    const onRoad = (
      (dist > RB_IN && dist < RB_OUT) ||                                                                          // ring
      (Math.abs(car.pos.x) < ROAD_W / 2 && car.pos.z >  RB_OUT - ARM_OVERLAP && car.pos.z <  RB_OUT + ROAD_L) || // S arm
      (Math.abs(car.pos.x) < ROAD_W / 2 && car.pos.z < -RB_OUT + ARM_OVERLAP && car.pos.z > -(RB_OUT + ROAD_L)) || // N arm
      (Math.abs(car.pos.z) < ROAD_W / 2 && car.pos.x >  RB_OUT - ARM_OVERLAP && car.pos.x <  RB_OUT + ROAD_L) || // E arm
      (Math.abs(car.pos.z) < ROAD_W / 2 && car.pos.x < -RB_OUT + ARM_OVERLAP && car.pos.x > -(RB_OUT + ROAD_L))  // W arm
    );
    if (!onRoad) {
      car.failed    = true;
      car.failReason = dist < RB_IN ? 'You drove into the centre island. Stay focused next time!' : "That's grass, not asphalt. Stay on the road.";
      return;
    }

    // ── Collision check ────────────────────────────────────────────────────
    for (const npc of this.npcs) {
      if (npc.state === 'despawned') continue;
      const dx = car.pos.x - npc.mesh.position.x;
      const dz = car.pos.z - npc.mesh.position.z;
      if (dx * dx + dz * dz < 3.5 * 3.5) {
        car.failed    = true;
        car.failReason = 'You crashed into the traffic. Stay focused next time!';
        return;
      }
    }

    // ── Universal condition checker ────────────────────────────────────────
    // Handles indicator types ('left','right','none') and lane types.
    const condOk = req =>
      req === 'left'           ? car.leftIndicator :
      req === 'right'          ? car.rightIndicator :
      req === 'none'           ? !car.leftIndicator && !car.rightIndicator :
      req === 'approach_outer' ? car.pos.x < -LANE_W :
      req === 'approach_inner' ? (car.pos.x >= -LANE_W && car.pos.x < 0) :
      req === 'ring_outer'     ? dist > RB_MID :
      req === 'ring_inner'     ? dist < RB_MID :
      req === 'signal'         ? (car.leftIndicator || car.rightIndicator) :
      true;

    // ── Grace period countdown ─────────────────────────────────────────────
    if (car.graceActive) {
      car.graceTimer -= dt;
      if (condOk(car.graceRequired)) {
        car.graceActive = false;          // player corrected in time
      } else if (car.graceTimer <= 0) {
        car.failed     = true;
        car.graceActive = false;
        const indViolations = ['left', 'right', 'none'];
        car.failReason = indViolations.includes(car.graceRequired)
          ? "No signal? Other drivers can't read your mind."
          : 'You didn\'t move into the correct lane in time.';
        return;
      }
    }

    // ── Helper: start grace only if none already active ────────────────────
    const startGrace = (req, duration = 3.0) => {
      if (!car.graceActive) {
        car.graceActive   = true;
        car.graceTimer    = duration;
        car.graceRequired = req;
      }
    };

    // ── Phase: approaching ─────────────────────────────────────────────────
    if (car.phase === 'approaching') {
      car.approachLane = car.pos.x < -LANE_W ? 'outer' : 'inner';

      // ── Check (lane-approach): correct arm lane within 20 m of give-way ──
      // Exit 1 (left turn):  outer lane required
      // Exit 2 (straight):   either lane — no check
      // Exit 3 (right turn): inner lane required
      if (!this._checkLaneApproachDone && dist < RB_OUT + 20) {
        this._checkLaneApproachDone = true;
        const inOuter = car.pos.x < -LANE_W;
        if (car.targetExitNum === 1 && !inOuter) startGrace('approach_outer', 4.0);
        if (car.targetExitNum === 3 &&  inOuter) startGrace('approach_inner', 4.0);
        // Exit 2: either lane is acceptable — no approach-lane check
      }

      // ── Check (a): entry indicator ────────────────────────────────────────
      if (dist <= RB_OUT + 1) {
        if (!this._checkADone) {
          this._checkADone = true;
          if (!condOk(ENTRY_IND[car.targetExitNum])) startGrace(ENTRY_IND[car.targetExitNum]);
        }
        car.phase = 'on_roundabout';
        const raw           = Math.atan2(-car.pos.z, car.pos.x);
        this._prevRingAngle = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
        car.traveledAngle   = 0;
        this._prevDistFromCenter = dist;
      }

    // ── Phase: on_roundabout ───────────────────────────────────────────────
    } else if (car.phase === 'on_roundabout') {
      car.ringLane = dist < RB_MID ? 'inner' : 'outer';

      // Accumulate clockwise traveledAngle (negate delta because UK CW = decreasing atan2(-z,x))
      const raw  = Math.atan2(-car.pos.z, car.pos.x);
      const norm = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
      if (this._prevRingAngle !== null) {
        let d = norm - this._prevRingAngle;
        if (d < -Math.PI) d += TWO_PI;
        if (d >  Math.PI) d -= TWO_PI;
        car.traveledAngle -= d;
      }
      this._prevRingAngle = norm;

      // ── Check (b): 12-o-clock — 3rd exit must still have right ───────────
      if (!this._checkBDone && car.traveledAngle >= Math.PI - 0.1) {
        this._checkBDone = true;
        if (car.targetExitNum === 3 && !condOk('right')) startGrace('right');
      }

      // ── Check (d): exit 2 — left indicator required after passing exit 1 ───
      if (!this._checkDDone && car.targetExitNum === 2 && car.traveledAngle >= Math.PI / 2) {
        this._checkDDone = true;
        if (!condOk('left')) startGrace('left');
      }

      // ── Check (c): near exit (~40°) — all exits need left ────────────────
      // Checked before ring-lane so indicator violation takes priority.
      if (!this._checkCDone && car.traveledAngle >= car.exitTravelTarget - 0.7) {
        this._checkCDone = true;
        if (!condOk('left')) startGrace('left');
      }

      // ── Ring lane check (continuous) ──────────────────────────────────────
      // Exit 1: always outer ring.
      // Exit 2: stay in the ring lane that matches your approach lane throughout.
      // Exit 3: inner ring until ~40° from exit, then move to outer.
      let needOuterRing;
      if (car.targetExitNum === 1) {
        needOuterRing = true;
      } else if (car.targetExitNum === 2) {
        needOuterRing = car.approachLane === 'outer'; // maintain whichever lane you chose
      } else {
        needOuterRing = car.traveledAngle >= car.exitTravelTarget - 0.7;
      }
      if (needOuterRing !== (dist > RB_MID)) {
        startGrace(needOuterRing ? 'ring_outer' : 'ring_inner', 3.0);
      }

      // ── Lane-change indicator check ───────────────────────────────────────
      // If radial displacement > 0.5 units this frame with no indicator: violation.
      if (this._prevDistFromCenter !== null) {
        const radialDelta = Math.abs(dist - this._prevDistFromCenter);
        if (radialDelta > 0.5 && !car.leftIndicator && !car.rightIndicator) {
          startGrace('signal', 2.0);
        }
      }
      this._prevDistFromCenter = dist;

      // ── Phase transition: angle-based OR physically on the correct exit arm ─
      // traveledAngle can stop accumulating once the car leaves the ring road,
      // so also check whether the car has physically crossed RB_OUT onto the
      // correct arm road (west/north/east — player always enters from south).
      const onExitArm = (
        (car.targetExit === 'west'  && car.pos.x < -RB_OUT && Math.abs(car.pos.z) < ROAD_W / 2) ||
        (car.targetExit === 'north' && car.pos.z < -RB_OUT && Math.abs(car.pos.x) < ROAD_W / 2) ||
        (car.targetExit === 'east'  && car.pos.x >  RB_OUT && Math.abs(car.pos.z) < ROAD_W / 2)
      );
      if (onExitArm) car.graceActive = false;  // clear ring/indicator graces once on correct arm
      if (car.traveledAngle >= car.exitTravelTarget - 0.15 || onExitArm) {
        car.phase = 'exiting';
      }

    // ── Phase: exiting ─────────────────────────────────────────────────────
    } else if (car.phase === 'exiting') {
      if (dist >= RB_OUT + 8) {
        car.phase = 'completed';
        this._completeTimer = 2.0;
      }
    }
  }

  // ── Physics update ─────────────────────────────────────────────────────────
  _update() {
    // Cap dt to 100 ms so a backgrounded tab or slow startup frame doesn't
    // produce a giant timestep that warps timers or physics.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    // Scale factor: 1.0 at 60 fps. All per-frame physics values are multiplied
    // by dtScale so the simulation runs at the same real-world speed regardless
    // of frame rate. This fixes the "everything moves slowly" issue on slow starts.
    const dtScale = dt * 60;
    this.elapsed += dt * 1000;

    // Preview mode — slow cinematic orbit, no physics or controls
    if (this._preview) {
      const t   = this.elapsed / 1000;
      const { r, h, spd, fov } = this._previewCfg;
      this.camera.position.set(Math.sin(t * spd) * r, h, Math.cos(t * spd) * r);
      this.camera.lookAt(0, 0, 0);
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Indicator debug mode — freeze everything, orbit camera
    if (this._indDebug) {
      this._blinkTimer += dt;
      const cx = this.car.pos.x, cz = this.car.pos.z;
      const { az, el, r } = this._indOrbit;
      this.camera.position.set(
        cx + r * Math.sin(az) * Math.cos(el),
        r * Math.sin(el),
        cz + r * Math.cos(az) * Math.cos(el),
      );
      this.camera.lookAt(cx, 1, cz);
      return;
    }

    const car = this.car;

    if      (this.keys.has('ArrowLeft'))  car.steer = Math.max(car.steer - 0.13 * dtScale, -1);
    else if (this.keys.has('ArrowRight')) car.steer = Math.min(car.steer + 0.13 * dtScale,  1);
    else                                  car.steer *= Math.pow(0.88, dtScale);

    if (this.keys.has('ArrowUp')) {
      car.speed += ACCEL * dtScale;
    } else if (this.keys.has('ArrowDown')) {
      car.speed  = car.speed > 0.01 ? car.speed - BRAKE * dtScale : car.speed - ACCEL * 0.5 * dtScale;
    } else {
      car.speed *= Math.pow(FRICTION, dtScale);
    }
    car.speed = Math.max(-MAX_REV, Math.min(MAX_SPEED, car.speed));
    if (Math.abs(car.speed) < 0.0005) car.speed = 0;

    const spd       = Math.abs(car.speed);
    const sFactor   = Math.min(spd / MAX_SPEED * 2 + 0.3, 1) * (1 - spd / MAX_SPEED * 0.2);
    const targetYaw = MAX_STEER * car.steer * sFactor * (car.speed >= 0 ? 1 : -1);
    car.yawRate    += (targetYaw - car.yawRate) * Math.min(0.2 * dtScale, 1);
    car.heading    += car.yawRate * dtScale;

    car.pos.x +=  Math.sin(car.heading) * car.speed * dtScale;
    car.pos.z += -Math.cos(car.heading) * car.speed * dtScale;

    // Indicator blink: 1.5 Hz (on 0.33 s, off 0.33 s)
    this._prevBlinkOn  = this._blinkOn;
    this._blinkTimer  += dt;
    this._blinkOn = Math.floor(this._blinkTimer * 3) % 2 === 0;
    // Play click on every edge (on→off and off→on) while player indicator is active
    if (this._prevBlinkOn !== this._blinkOn && (car.leftIndicator || car.rightIndicator)) {
      this._playIndicatorClick();
    }

    // Sync player indicator lights
    if (this._playerIndMeshes) {
      const on = this._blinkOn;
      this._playerIndMeshes.left.forEach(m  => { m.visible  = car.leftIndicator  && on; });
      this._playerIndMeshes.right.forEach(m => { m.visible  = car.rightIndicator && on; });
    }

    if (!this._preview) {
      this._initEngineSound();
      this._updateEngineSound();
    }
    this._updateCamera(dtScale);
    this._updateNPCs(dt, dtScale);
    this._updateStateMachine(dt);
    this._updateHornCheck(dt);

    // Sync player car mesh — pivot around rear axle (local z = +1.55)
    // rotation.y must be NEGATED: Three.js positive-Y rotation turns the mesh
    // counter-clockwise from above, but increasing heading is a clockwise/right turn.
    if (this._playerCarMesh) {
      this._playerCarMesh.position.set(
        car.pos.x + Math.sin(car.heading) * 1.55,
        0,
        car.pos.z - Math.cos(car.heading) * 1.55,
      );
      this._playerCarMesh.rotation.y = -car.heading;
    }

    // Rotate front wheels — also negated to stay consistent with mesh orientation
    if (this._frontWheelGroups) {
      this._frontWheelGroups.forEach(pivot => { pivot.rotation.y = -car.steer * 0.42; });
    }

    // ── Complete-mission countdown ────────────────────────────────────────────
    if (this._completeTimer > 0) {
      this._completeTimer -= dt;
      if (this._completeTimer <= 0) {
        this._completeTimer = 0;
        this._missionIndex++;
        this.restart();
        return;
      }
    }

    const kmh = Math.round((spd / MAX_SPEED) * 80);
    this.onHUD?.({
      speed:          kmh,
      speedRatio:     spd / MAX_SPEED,
      gear:           car.speed >= 0 ? 'D' : 'R',
      steer:          car.steer,
      phase:          car.phase,
      showComplete:   this._completeTimer > 0,
      targetExit:     car.targetExit,
      targetExitNum:  car.targetExitNum,
      requiredLane:   car.requiredLane,
      leftIndicator:  car.leftIndicator,
      rightIndicator: car.rightIndicator,
      approachLane:   car.approachLane,
      ringLane:       car.ringLane,
      graceActive:    car.graceActive,
      graceTimer:     car.graceTimer,
      graceRequired:  car.graceRequired,
      failed:         car.failed,
      failReason:     car.failReason,
      missionIndex:   this._missionIndex,
    });
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  start() {
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this._animId = requestAnimationFrame(loop);
      this._update();
      this.renderer.render(this.scene, this.camera);
    };
    this._animId = requestAnimationFrame(loop);
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this._animId);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    window.removeEventListener('resize',  this._onResize);
    if (this._indOnMouseMove) {
      this.renderer.domElement.removeEventListener('mousedown', this._indOnMouseDown);
      window.removeEventListener('mousemove', this._indOnMouseMove);
      window.removeEventListener('mouseup',   this._indOnMouseUp);
    }
    try { this._engOsc?.stop(); this._engSub?.stop(); } catch (_) {}
    try { this._audioCtx?.close(); } catch (_) {}
    this.renderer.dispose();
  }
}
