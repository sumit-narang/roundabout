import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const BASE = import.meta.env.BASE_URL;

// ─── World constants ──────────────────────────────────────────────────────────
const LANE_W  = 3.5;
const ROAD_W  = 14;
const RB_IN   = 12;
const RB_MID  = 17;
const RB_OUT  = 22;
const ROAD_L  = 110;
const ROAD_VEXT = 180;

// ─── 3-arm layout: Y-shaped, arms 120° apart ──────────────────────────────────
// Ring angle convention: x = r·sin(θ), z = −r·cos(θ)  (θ: north=0, CW positive)
// Player enters from south (bottom), exits via NW (upper-left) or NE (upper-right).
const SOUTH_THETA = Math.PI;           // bottom entry arm
const NW_THETA    = 5 * Math.PI / 3;  // upper-left exit arm (exit 1, ~120° CW from south)
const NE_THETA    = Math.PI / 3;      // upper-right exit arm (exit 2, ~240° CW from south)
const ALL_ARM_THETAS = [SOUTH_THETA, NW_THETA, NE_THETA];

const SOUTH_ENTRY_ANGLE = 3 * Math.PI / 2;

const EXITS = [
  { num: 1, theta: NW_THETA, travelAngle: 2 * Math.PI / 3, requiredLane: 'outer', requiredRingLane: 'outer' },
  { num: 2, theta: NE_THETA, travelAngle: 4 * Math.PI / 3, requiredLane: 'inner', requiredRingLane: 'inner' },
];

const ENTRY_IND = { 1: 'left', 2: 'right' };

// ─── NPC traffic constants ────────────────────────────────────────────────────
const NPC_SPEED   = 0.22;
const NPC_INNER_R = (RB_IN  + RB_MID) / 2;
const NPC_OUTER_R = (RB_MID + RB_OUT) / 2;
const ENTRY_ADVANCE = 0.4;
const EXIT_ADVANCE  = 0.4;

// ─── Car physics constants ────────────────────────────────────────────────────
const MAX_SPEED   = 0.55;
const MAX_REV     = 0.18;
const ACCEL       = 0.009;
const BRAKE       = 0.018;
const FRICTION    = 0.965;
const MAX_STEER   = 0.062;
const CAM_BACK    = 12;
const CAM_H       = 7.5;

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

// Returns rotation.y for a Group so its local +Z aligns with arm direction at theta.
// Arm direction: (sin(theta), 0, -cos(theta)).
// Three.js Ry(α) maps local +Z to world (sin(α), 0, cos(α)).
// We need sin(α)=sin(θ) and cos(α)=-cos(θ), giving α = π - θ.
function armGroupRy(theta) { return Math.PI - theta; }

// World position of a point at distance d along arm theta, lateral offset o
// (positive o = right when facing outward = near-side for left-hand traffic).
function armWorld(theta, d, o = 0) {
  return new THREE.Vector3(
    d * Math.sin(theta) + o * Math.cos(theta),
    0,
    -d * Math.cos(theta) + o * Math.sin(theta),
  );
}

// ─── Main game class ──────────────────────────────────────────────────────────
export class RoundaboutGame3arm {
  constructor(canvas, onHUD) {
    this.canvas  = canvas;
    this.onHUD   = onHUD;
    this.keys    = new Set();
    this.running     = false;
    this.clock       = new THREE.Timer();
    this.elapsed     = 0;
    this._blinkTimer  = 0;
    this._blinkOn     = false;
    this._prevBlinkOn = false;
    this._audioCtx    = null;
    this._muted       = false;

    this._lampRefs  = [];
    this._treeRefs  = [];
    this._houseRefs = [];

    this._camCfg = { back: 12, h: 6, lookY: 1.5, lookFwd: 3, fov: 65 };

    this._indTypes = {};
    this._indDebug = false;
    this._indOrbit      = { az: Math.PI, el: 0.30, r: 11 };
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

    this.car = {
      pos:    new THREE.Vector3(-LANE_W * 1.5, 0, RB_OUT + ROAD_L * 0.55),
      heading: 0,
      speed:   0,
      steer:   0,
      yawRate: 0,
      phase:            'approaching',
      targetExitNum:    null,
      exitTravelTarget: 0,
      exitArmAngle:     SOUTH_THETA,
      requiredLane:     'outer',
      requiredRingLane: 'outer',
      leftIndicator:    false,
      rightIndicator:   false,
      entryAngle:       SOUTH_ENTRY_ANGLE,
      traveledAngle:    0,
      approachLane:     'outer',
      ringLane:         'outer',
      graceActive:      false,
      graceTimer:       0,
      graceRequired:    null,
      failed:           false,
      failReason:       null,
    };
    this._prevRingAngle       = null;
    this._prevDistFromCenter  = null;
    this._checkADone          = false;
    this._checkBDone          = false;
    this._checkCDone          = false;
    this._checkDDone          = false;
    this._checkLaneApproachDone = false;
    this._checkExitLaneDone   = false;
    this._missionIndex  = 0;
    this._lastExitIndex = -1;
    this._exitTheta     = NW_THETA;
    this._completeTimer       = 0;
    this._preview             = true;
    this._previewCfg          = { r: 60, h: 32, spd: 0.02, fov: 36 };
    this._stationaryTimer     = 0;
    this._hornCooldown        = 0;
    this._assignMission();

    this._onKeyDown = e => {
      if (this._preview) return;
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow')) e.preventDefault();
      if (e.code === 'KeyQ') this._toggleIndicator('left');
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
    const loader = this._createLoader();
    this._buildWorld(loader);
    this._buildNPCs(loader);
    this._buildPlayerCar(loader);
    this._initCamera();
    this._initDashboard();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
    window.addEventListener('resize',  this._onResize);
    this.start();
  }

  _createLoader() {
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${BASE}draco/`);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    return loader;
  }

  _initRenderer() {
    const isMobile = window.innerWidth <= 600;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !isMobile });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type      = THREE.PCFShadowMap;
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
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { near: 1, far: 500, left: -160, right: 160, top: 160, bottom: -160 });
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0x87ceeb, 0x2d5e22, 0.55));
  }

  // ── World building ─────────────────────────────────────────────────────────
  _buildWorld(loader) {
    const grassTex = new THREE.TextureLoader().load(`${BASE}textures/grass.webp`);
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
    this._loadBuildings(loader);
    this._buildProps(loader);
    this._buildClouds(loader);
    this._buildSkyDome();
  }

  // ── Roundabout ring (same geometry as 4-arm version) ──────────────────────
  _buildRoundabout() {
    const asMat    = new THREE.MeshLambertMaterial({ map: asphaltTex(4, 4) });
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const islandGrassTex = new THREE.TextureLoader().load(`${BASE}textures/grass.webp`);
    islandGrassTex.wrapS = islandGrassTex.wrapT = THREE.RepeatWrapping;
    islandGrassTex.repeat.set(6, 6);
    const islandMat = new THREE.MeshLambertMaterial({ map: islandGrassTex });
    const curbMat   = new THREE.MeshLambertMaterial({ color: 0xd0d0d0 });

    const ring = new THREE.Mesh(new THREE.RingGeometry(RB_IN, RB_OUT, 80), asMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y  = 0.02;
    ring.receiveShadow = true;
    this.scene.add(ring);

    const innerEdge = new THREE.Mesh(new THREE.RingGeometry(RB_IN, RB_IN + 0.28, 80), whiteMat);
    innerEdge.rotation.x = -Math.PI / 2;
    innerEdge.position.y  = 0.03;
    this.scene.add(innerEdge);

    const outerEdge = new THREE.Mesh(new THREE.RingGeometry(RB_OUT - 0.28, RB_OUT, 80), whiteMat);
    outerEdge.rotation.x = -Math.PI / 2;
    outerEdge.position.y  = 0.03;
    this.scene.add(outerEdge);

    const numSegs = 40, segA = (Math.PI * 2) / numSegs;
    for (let i = 0; i < numSegs; i += 2) {
      const dashMesh = new THREE.Mesh(
        new THREE.RingGeometry(RB_MID - 0.15, RB_MID + 0.15, 6, 1, i * segA, segA),
        whiteMat,
      );
      dashMesh.rotation.x = -Math.PI / 2;
      dashMesh.position.y  = 0.035;
      this.scene.add(dashMesh);
    }

    const isl = new THREE.Mesh(new THREE.CircleGeometry(RB_IN, 72), islandMat);
    isl.rotation.x = -Math.PI / 2;
    isl.position.y  = 0.02;
    this.scene.add(isl);

    const mound = new THREE.Mesh(
      new THREE.CylinderGeometry(RB_IN * 0.65, RB_IN - 0.3, 1.4, 40),
      islandMat,
    );
    mound.position.y = 0.7;
    this.scene.add(mound);

    const iCurb = new THREE.Mesh(new THREE.TorusGeometry(RB_IN, 0.22, 8, 80), curbMat);
    iCurb.rotation.x = Math.PI / 2;
    iCurb.position.y = 0.13;
    this.scene.add(iCurb);
  }

  // ── 3 arms via Groups — each group's local +Z is the arm's outward direction ──
  _buildRoads() {
    const EXT = 3, VEXT = ROAD_VEXT;
    const totalL = ROAD_L + EXT + VEXT;
    const armC   = RB_OUT + (ROAD_L + VEXT) / 2 - EXT / 2;
    const ew     = 0.25, halfW = ROAD_W / 2;
    const edgeL  = ROAD_L + VEXT;
    const edgeC  = RB_OUT + edgeL / 2;
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

    ALL_ARM_THETAS.forEach(theta => {
      const g = new THREE.Group();
      g.rotation.y = armGroupRy(theta);

      const road = new THREE.Mesh(
        new THREE.PlaneGeometry(ROAD_W, totalL),
        new THREE.MeshLambertMaterial({ map: asphaltTex(2, 10) }),
      );
      road.rotation.x = -Math.PI / 2;
      road.position.set(0, 0.01, armC);
      road.receiveShadow = true;
      g.add(road);

      [-(halfW - ew / 2), halfW - ew / 2].forEach(x => {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(ew, edgeL), whiteMat);
        line.rotation.x = -Math.PI / 2;
        line.position.set(x, 0.03, edgeC);
        g.add(line);
      });

      this.scene.add(g);
    });
  }

  // ── Road markings for each arm — all in local Group space ─────────────────
  _buildMarkings() {
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const halfW    = ROAD_W / 2;
    const triLen   = 18;
    const fullL    = ROAD_L + ROAD_VEXT;
    const cz       = RB_OUT + fullL / 2;

    const dashL = 2.5, dashGap = 4.0;
    const gwDash = 1.0, gwGap = 0.65, gwThick = 0.3;
    this._hatchMat = this._makeHatchMat();

    ALL_ARM_THETAS.forEach(theta => {
      const g = new THREE.Group();
      g.rotation.y = armGroupRy(theta);

      const mark = (mat, w, l, x, y, z) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, y, z);
        g.add(m);
      };

      const lineStart  = RB_OUT + triLen;
      const lineEnd    = cz + fullL / 2;
      const lineCenter = (lineStart + lineEnd) / 2;

      // Centre line
      mark(whiteMat, 0.3, lineEnd - lineStart, 0, 0.04, lineCenter);

      // Lane dashes (two lines, at ±LANE_W)
      for (let d = -(fullL / 2) + 3; d < fullL / 2 - 2; d += dashL + dashGap) {
        mark(whiteMat, 0.2, dashL, -LANE_W, 0.04, cz + d);
        mark(whiteMat, 0.2, dashL,  LANE_W, 0.04, cz + d);
      }

      // Give-way double lines across near-side half (local x < 0)
      for (let x = -halfW + gwDash / 2; x < 0; x += gwDash + gwGap) {
        mark(whiteMat, gwDash, gwThick, x, 0.05, RB_OUT + 0.45);
        mark(whiteMat, gwDash, gwThick, x, 0.05, RB_OUT + 0.90);
      }

      // Hatch triangle
      const tri = new THREE.Mesh(new THREE.PlaneGeometry(2.5, triLen), this._hatchMat);
      tri.rotation.x = -Math.PI / 2;
      tri.position.set(0, 0.05, RB_OUT + triLen / 2);
      g.add(tri);

      this.scene.add(g);
    });
  }

  _makeHatchMat() {
    const HATCH_W = 128, HATCH_H = 256;
    const hc = document.createElement('canvas');
    hc.width = HATCH_W; hc.height = HATCH_H;
    const hctx = hc.getContext('2d');
    hctx.clearRect(0, 0, HATCH_W, HATCH_H);
    hctx.save();
    hctx.beginPath();
    hctx.moveTo(0, 0); hctx.lineTo(HATCH_W, 0); hctx.lineTo(HATCH_W / 2, HATCH_H);
    hctx.closePath(); hctx.clip();
    hctx.strokeStyle = 'white'; hctx.lineWidth = 9;
    for (let i = -HATCH_H; i < HATCH_W + HATCH_H; i += 24) {
      hctx.beginPath(); hctx.moveTo(i, 0); hctx.lineTo(i + HATCH_H, HATCH_H); hctx.stroke();
    }
    hctx.restore();
    hctx.beginPath();
    hctx.moveTo(0, 0); hctx.lineTo(HATCH_W, 0); hctx.lineTo(HATCH_W / 2, HATCH_H);
    hctx.closePath(); hctx.strokeStyle = 'white'; hctx.lineWidth = 10; hctx.lineJoin = 'miter'; hctx.stroke();
    return new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(hc), transparent: true, depthWrite: false, alphaTest: 0.01, side: THREE.DoubleSide,
    });
  }

  // ── Props: trees and lamps along each arm ─────────────────────────────────
  _buildProps(loader) {
    // Island trees
    const islandPos = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const r = 4.5 + Math.random() * 1.5;
      islandPos.push([Math.sin(a) * r, -Math.cos(a) * r, 0.7]);
    }
    // Corner trees at mid-angles between each pair of arms
    // Arms at 60°, 180°, 300° → corners at 120°, 240°, 0°
    [0, 2 * Math.PI / 3, 4 * Math.PI / 3].forEach(deg => {
      for (let j = -1; j <= 1; j++) {
        const a = deg + j * 0.28;
        const r = 27 + Math.random() * 6;
        islandPos.push([Math.sin(a) * r, -Math.cos(a) * r, 0.9 + Math.random() * 0.2]);
      }
    });

    // Road-side trees along 3 arms
    const halfW  = ROAD_W / 2;
    const treeOff = halfW + 4;   // lateral offset from road centre
    const treeD  = [37, 51, 65, 79, 93, 107, 121];
    const roadPos = [];
    ALL_ARM_THETAS.forEach(theta => {
      treeD.forEach(d => {
        // near-side (positive lateral = right when facing outward)
        const near = armWorld(theta, RB_OUT + d,  treeOff);
        const far  = armWorld(theta, RB_OUT + d, -treeOff);
        roadPos.push({ x: near.x, z: near.z });
        roadPos.push({ x: far.x,  z: far.z  });
      });
    });

    loader.load(`${BASE}models/trees_low_poly.glb`, (gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const baseScale = 7 / size.y;
      const yOffset   = -box.min.y * baseScale;

      islandPos.forEach(([x, z, s]) => {
        const inst = gltf.scene.clone(true);
        inst.scale.setScalar(baseScale * s);
        inst.position.set(x, yOffset * s, z);
        inst.rotation.y = Math.random() * Math.PI * 2;
        this.scene.add(inst);
      });

      roadPos.forEach(({ x, z }) => {
        const inst = gltf.scene.clone(true);
        inst.scale.setScalar(baseScale);
        inst.position.set(x, yOffset, z);
        inst.rotation.y = Math.random() * Math.PI * 2;
        this.scene.add(inst);
      });
    });

    this._buildLamps(loader);
  }

  _buildLamps(loader) {
    loader.load(`${BASE}models/lamp_post.glb`, (gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale   = 5 / size.y;
      const yOffset = -box.min.y * scale;

      const halfW = ROAD_W / 2;
      const step  = 20;
      ALL_ARM_THETAS.forEach(theta => {
        for (let d = RB_OUT + 8; d < RB_OUT + ROAD_L - 5; d += step) {
          [-1, 1].forEach(side => {
            const p   = armWorld(theta, d, side * (halfW + 0.5));
            const inst = gltf.scene.clone(true);
            inst.scale.setScalar(scale);
            inst.position.set(p.x, yOffset, p.z);
            inst.rotation.y = armGroupRy(theta) + (side > 0 ? Math.PI : 0);
            this.scene.add(inst);
          });
        }
      });
    });
  }

  _loadBuildings(loader) {
    const loadGLB = (url) => new Promise((resolve, reject) =>
      loader.load(url, resolve, undefined, reject));

    loadGLB(`${BASE}models/building.glb`).then((gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale   = 8 / Math.max(size.x, size.z);
      const yOffset = -box.min.y * scale;
      const off = ROAD_W / 2 + 4;

      // Building front is local +Z, so rotation.y = β makes it face (sin β, 0, cos β).
      // For arm at theta, +lateral direction = (cos θ, 0, sin θ).
      // +o side building (right of arm when facing outward) faces −(cos θ, 0, sin θ):
      //   sin β = −cos θ, cos β = −sin θ  →  β = −π/2 − θ
      // −o side building (left of arm when facing outward) faces +(cos θ, 0, sin θ):
      //   sin β = cos θ,  cos β = sin θ   →  β = π/2 − θ
      const distances = [14, 30, 44, 58, 72, 86, 100, 114, 128];
      ALL_ARM_THETAS.forEach(theta => {
        distances.forEach(d => {
          [
            { o:  off, ry: -Math.PI / 2 - theta },
            { o: -off, ry:  Math.PI / 2 - theta },
          ].forEach(({ o, ry }) => {
            const p    = armWorld(theta, RB_OUT + d, o);
            const inst = gltf.scene.clone(true);
            inst.scale.setScalar(scale);
            inst.position.set(p.x, yOffset, p.z);
            inst.rotation.y = ry;
            this.scene.add(inst);
            this._houseRefs.push({ group: inst });
          });
        });
      });
    }).catch(err => console.error('Building load failed:', err));

    loadGLB(`${BASE}models/yield.glb`).then((gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale   = 2.5 / Math.max(size.x, size.y, size.z);
      const yOffset = -box.min.y * scale;

      ALL_ARM_THETAS.forEach(theta => {
        // Place yield sign on near-side (left of approaching driver) at give-way line
        const p   = armWorld(theta, RB_OUT + 1.5, ROAD_W / 2 + 0.8);
        const inst = gltf.scene.clone(true);
        inst.scale.setScalar(scale);
        inst.position.set(p.x, yOffset, p.z);
        // Sign faces incoming traffic (toward roundabout = inward along arm)
        inst.rotation.y = armGroupRy(theta) + Math.PI;
        this.scene.add(inst);
      });
    }).catch(err => console.error('Yield sign load failed:', err));
  }

  _buildClouds(loader) {
    loader.load(`${BASE}models/cloud.glb`, (gltf) => {
      gltf.scene.traverse(child => {
        if (child.isMesh) { child.castShadow = false; child.receiveShadow = false; }
      });
      const box  = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const norm = 1 / Math.max(size.x, size.y, size.z);
      const pts = [
        [-0.82, -0.64], [ 0.82, -0.82], [-0.64,  0.64], [ 1.00,  0.23],
        [ 0.00, -1.00], [-1.00,  0.09], [ 0.64,  0.82], [-0.36, -1.09],
        [ 1.09,  0.55], [ 0.00,  0.73], [-0.55,  0.36], [ 0.73, -0.36],
        [-0.73,  0.73], [ 0.36, -0.55],
      ];
      const scale = 16, spread = 140;
      const y = window.innerWidth < 600 ? 36 : 40;
      this._cloudInstances = [];
      pts.forEach(([nx, nz]) => {
        const inst = gltf.scene.clone(true);
        inst.rotation.y = Math.random() * Math.PI * 2;
        inst.scale.setScalar(norm * scale);
        inst.position.set(nx * spread, y, nz * spread);
        this.scene.add(inst);
        this._cloudInstances.push(inst);
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

  // ── NPC traffic ────────────────────────────────────────────────────────────
  _buildNPCs(loader) {
    this.npcs = [];
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Group();
      mesh.visible = false;
      this.scene.add(mesh);
      this.npcs.push({
        mesh, indMeshes: { left: [], right: [] },
        state:            'despawned',
        respawnTimer:     i * 2.5,
        entryTheta:       SOUTH_THETA,
        exitTheta:        SOUTH_THETA,
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

    const loadGLB = (url) => new Promise(resolve => loader.load(url, resolve));
    Promise.all([loadGLB(`${BASE}models/car_blue.glb`), loadGLB(`${BASE}models/car_green.glb`), loadGLB(`${BASE}models/car_orange.glb`), loadGLB(`${BASE}models/car_purple.glb`)]).then(([g1, g2, g3, g4]) => {
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
          if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
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

  _spawnNPC(npc) {
    const TWO_PI = Math.PI * 2;
    const entryIdx   = Math.floor(Math.random() * ALL_ARM_THETAS.length);
    const entryTheta = ALL_ARM_THETAS[entryIdx];
    const exitCands  = ALL_ARM_THETAS.filter((_, i) => i !== entryIdx);
    const exitTheta  = exitCands[Math.floor(Math.random() * exitCands.length)];
    npc.entryTheta = entryTheta;
    npc.exitTheta  = exitTheta;
    npc.heading    = (entryTheta + Math.PI) % TWO_PI;

    const tempEntry = this._ringIntersect(entryTheta, NPC_OUTER_R, true,  true);
    const tempExit  = this._ringIntersect(exitTheta,  NPC_OUTER_R, true,  false);
    const tempAdv   = (tempEntry.ringAngle + ENTRY_ADVANCE + TWO_PI) % TWO_PI;
    const tempAdvX  = (tempExit.ringAngle  - EXIT_ADVANCE  + TWO_PI) % TWO_PI;
    let approxTravel = (tempAdvX - tempAdv + TWO_PI) % TWO_PI;
    if (approxTravel < 0.2) approxTravel += TWO_PI;

    // In 3-arm layout max travel is ~4π/3; use π as the threshold
    const outer = approxTravel < Math.PI ? true
                : approxTravel > Math.PI ? false
                : Math.random() < 0.5;
    npc.ringRadius = outer ? NPC_OUTER_R : NPC_INNER_R;

    const entryInt = this._ringIntersect(entryTheta, npc.ringRadius, outer, true);
    const exitInt  = this._ringIntersect(exitTheta,  npc.ringRadius, outer, false);
    const advEntryAngle = (entryInt.ringAngle + ENTRY_ADVANCE + TWO_PI) % TWO_PI;
    const advExitAngle  = (exitInt.ringAngle  - EXIT_ADVANCE  + TWO_PI) % TWO_PI;
    npc.ringTravelNeeded = (advExitAngle - advEntryAngle + TWO_PI) % TWO_PI;
    if (npc.ringTravelNeeded < 0.2) npc.ringTravelNeeded += TWO_PI;
    npc.ringTravelDone   = 0;
    npc.state            = 'approaching';

    npc.leftIndicator    = approxTravel < Math.PI;
    npc.rightIndicator   = approxTravel >= Math.PI;
    npc.nearExitSignaled = false;

    const spawnDist = RB_OUT + ROAD_L * 0.88;
    const wOff = outer ? LANE_W * 1.5 : LANE_W * 0.5;
    const sx = spawnDist * Math.sin(entryTheta) + wOff * Math.cos(entryTheta);
    const sz = -spawnDist * Math.cos(entryTheta) + wOff * Math.sin(entryTheta);
    npc.mesh.position.set(sx, 0, sz);
    npc.mesh.rotation.y = -npc.heading;
    npc.mesh.visible    = true;
  }

  _ringIntersect(theta, r, outer, isEntry) {
    const TWO_PI   = Math.PI * 2;
    const w        = outer ? LANE_W * 1.5 : LANE_W * 0.5;
    const h        = Math.sqrt(r * r - w * w);
    const w_signed = isEntry ? w : -w;
    const x = h * Math.sin(theta) + w_signed * Math.cos(theta);
    const z = -h * Math.cos(theta) + w_signed * Math.sin(theta);
    const rawAngle  = Math.atan2(x, -z);
    const ringAngle = ((rawAngle % TWO_PI) + TWO_PI) % TWO_PI;
    const tangentH  = Math.atan2(Math.cos(ringAngle), -Math.sin(ringAngle));
    return { x, z, ringAngle, tangentH };
  }

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
    const LOOK_AHEAD  = 12;
    const STOP_DIST   =  4;
    const LANE_HALF   =  2.2;
    const TWO_PI      = Math.PI * 2;

    if (npc.state === 'approaching') {
      const pos  = npc.mesh.position;
      const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
      if (dist < RB_OUT + 14) {
        const isOuter    = npc.ringRadius === NPC_OUTER_R;
        const entryInt   = this._ringIntersect(npc.entryTheta, npc.ringRadius, isOuter, true);
        const entryAngle = entryInt.ringAngle;

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
            const otherAngle = ((Math.atan2(ox, -oz) % TWO_PI) + TWO_PI) % TWO_PI;
            const gap = (entryAngle - otherAngle + TWO_PI) % TWO_PI;
            if (gap < 0.9) return 0;
          } else {
            const dx = ox - entryInt.x, dz = oz - entryInt.z;
            if (dx * dx + dz * dz < 10 * 10) return 0;
          }
        }
      }
    }

    let dirX, dirZ;
    if (npc.state === 'on_roundabout') {
      dirX =  Math.cos(npc.ringAngle);
      dirZ =  Math.sin(npc.ringAngle);
    } else {
      dirX =  Math.sin(npc.heading);
      dirZ = -Math.cos(npc.heading);
    }

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
      const fwd = dx * dirX + dz * dirZ;
      const lat = Math.abs(dx * dirZ - dz * dirX);
      if (fwd > 0 && fwd < LOOK_AHEAD && lat < LANE_HALF) {
        closestFwd = Math.min(closestFwd, fwd);
      }
    }

    if (closestFwd === Infinity)   return NPC_SPEED;
    if (closestFwd <= STOP_DIST)   return 0;
    return NPC_SPEED * (closestFwd - STOP_DIST) / (LOOK_AHEAD - STOP_DIST);
  }

  _updateNPCs(dt, dtScale) {
    const TWO_PI = Math.PI * 2;

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

    const bezierArc = (fx, fz, fh, tx, tz, th, t) => {
      const d   = Math.sqrt((tx - fx) ** 2 + (tz - fz) ** 2);
      const sc  = d / 3;
      const p1x = fx + Math.sin(fh) * sc,  p1z = fz - Math.cos(fh) * sc;
      const p2x = tx - Math.sin(th) * sc,  p2z = tz + Math.cos(th) * sc;
      const mt  = 1 - t;
      const x = mt*mt*mt*fx + 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t*tx;
      const z = mt*mt*mt*fz + 3*mt*mt*t*p1z + 3*mt*t*t*p2z + t*t*t*tz;
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

      if (npc.state === 'approaching' || npc.state === 'on_roundabout' || npc.state === 'exiting') {
        npc.speed = this._npcFollowSpeed(npc);
      }

      if (npc.state === 'approaching') {
        pos.x += Math.sin(npc.heading) * npc.speed * dtScale;
        pos.z -= Math.cos(npc.heading) * npc.speed * dtScale;
        npc.mesh.rotation.y = -npc.heading;

        const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
        if (dist <= RB_OUT + 6) {
          const isOuter    = npc.ringRadius === NPC_OUTER_R;
          const entryInt   = this._ringIntersect(npc.entryTheta, npc.ringRadius, isOuter, true);
          const advEntryAng = (entryInt.ringAngle + ENTRY_ADVANCE + TWO_PI) % TWO_PI;
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

      } else if (npc.state === 'entering_ring') {
        npc.transProgress = Math.min(npc.transProgress + dt / npc.transDuration * this._arcSpeedScale(pos), 1);
        const arc = bezierArc(
          npc.transFromX, npc.transFromZ, npc.transFromH,
          npc.transToX,   npc.transToZ,   npc.transToH,
          npc.transProgress,
        );
        pos.x = arc.x; pos.z = arc.z;
        npc.heading = arc.h;
        npc.mesh.rotation.y = -npc.heading;
        if (npc.transProgress >= 1) {
          pos.x = npc.transToX; pos.z = npc.transToZ;
          npc.heading = npc.transToH;
          npc.ringTravelDone = 0;
          npc.state = 'on_roundabout';
        }

      } else if (npc.state === 'on_roundabout') {
        const dθ = npc.speed * dtScale / npc.ringRadius;
        npc.ringAngle       = (npc.ringAngle + dθ) % TWO_PI;
        npc.ringTravelDone += dθ;
        pos.x = npc.ringRadius * Math.sin(npc.ringAngle);
        pos.z = -npc.ringRadius * Math.cos(npc.ringAngle);
        npc.mesh.rotation.y = -Math.atan2(Math.cos(npc.ringAngle), -Math.sin(npc.ringAngle));

        if (!npc.nearExitSignaled && npc.ringTravelDone >= npc.ringTravelNeeded - 0.7) {
          npc.nearExitSignaled = true;
          npc.leftIndicator    = true;
          npc.rightIndicator   = false;
        }

        if (npc.ringTravelDone >= npc.ringTravelNeeded) {
          const isOuter  = npc.ringRadius === NPC_OUTER_R;
          const exitInt  = this._ringIntersect(npc.exitTheta, npc.ringRadius, isOuter, false);
          const dH       = npc.exitTheta;
          const fromH    = Math.atan2(Math.cos(npc.ringAngle), -Math.sin(npc.ringAngle));
          npc.transFromX = pos.x; npc.transFromZ = pos.z; npc.transFromH = fromH;
          npc.transToX   = exitInt.x + Math.sin(dH) * 8;
          npc.transToZ   = exitInt.z - Math.cos(dH) * 8;
          npc.transToH   = dH;
          npc.transDuration = bezierArcLen(
            npc.transFromX, npc.transFromZ, npc.transFromH,
            npc.transToX,   npc.transToZ,   npc.transToH,
          ) / (NPC_SPEED * 60);
          npc.transProgress = 0;
          npc.state = 'leaving_ring';
        }

      } else if (npc.state === 'leaving_ring') {
        npc.transProgress = Math.min(npc.transProgress + dt / npc.transDuration * this._arcSpeedScale(pos), 1);
        const arc = bezierArc(
          npc.transFromX, npc.transFromZ, npc.transFromH,
          npc.transToX,   npc.transToZ,   npc.transToH,
          npc.transProgress,
        );
        pos.x = arc.x; pos.z = arc.z;
        npc.heading = arc.h;
        npc.mesh.rotation.y = -npc.heading;
        if (npc.transProgress >= 1) {
          pos.x = npc.transToX; pos.z = npc.transToZ;
          npc.heading = npc.transToH;
          npc.mesh.rotation.y = -npc.heading;
          npc.leftIndicator  = false;
          npc.rightIndicator = false;
          npc.state = 'exiting';
        }

      } else if (npc.state === 'exiting') {
        pos.x += Math.sin(npc.heading) * npc.speed * dtScale;
        pos.z -= Math.cos(npc.heading) * npc.speed * dtScale;
        npc.mesh.rotation.y = -npc.heading;

        const radial = pos.x * Math.sin(npc.exitTheta) + pos.z * (-Math.cos(npc.exitTheta));
        if (radial > RB_OUT + ROAD_L - 5) {
          npc.mesh.visible = false;
          npc.state        = 'despawned';
          npc.respawnTimer = 3 + Math.random() * 3;
        }
      }

      if (npc.indMeshes) {
        const on = this._blinkOn;
        npc.indMeshes.left.forEach(m  => { m.visible = npc.leftIndicator  && on; });
        npc.indMeshes.right.forEach(m => { m.visible = npc.rightIndicator && on; });
      }
    });
  }

  // ── Audio ──────────────────────────────────────────────────────────────────
  _playIndicatorClick() {
    if (this._muted) return;
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.025);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.025);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.03);
    } catch (_) {}
  }

  _playHorn() {
    if (this._muted) return;
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime, dur = 0.42;
      const shaper = ctx.createWaveShaper();
      const n = 512, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = (Math.PI + 180) * x / (Math.PI + 180 * Math.abs(x));
      }
      shaper.curve = curve;
      const master = ctx.createGain();
      master.connect(shaper); shaper.connect(ctx.destination);
      master.gain.setValueAtTime(0, t);
      master.gain.linearRampToValueAtTime(0.55, t + 0.018);
      master.gain.setValueAtTime(0.55, t + dur - 0.06);
      master.gain.linearRampToValueAtTime(0, t + dur);
      [{ freq: 392, vol: 0.65 }, { freq: 494, vol: 0.50 }].forEach(({ freq, vol }) => {
        const osc = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.linearRampToValueAtTime(freq * 0.994, t + 0.12);
        osc.frequency.linearRampToValueAtTime(freq * 0.997, t + dur);
        filter.type = 'lowpass'; filter.frequency.value = 1800; filter.Q.value = 1.8;
        gain.gain.value = vol;
        osc.connect(filter); filter.connect(gain); gain.connect(master);
        osc.start(t); osc.stop(t + dur + 0.05);
      });
    } catch (_) {}
  }

  _updateHornCheck(dt) {
    const car = this.car;
    if (car.failed || car.phase === 'completed') return;
    const moving = Math.abs(car.speed) > 0.02;
    if (moving) { this._stationaryTimer = 0; this._hornCooldown = 0; return; }
    this._stationaryTimer += dt;
    if (this._hornCooldown > 0) { this._hornCooldown -= dt; return; }
    if (this._stationaryTimer < 3) return;
    const onRoundabout = car.phase === 'on_roundabout';
    const sinH = Math.sin(car.heading), cosH = Math.cos(car.heading);
    const npcBehind = this.npcs.some(npc => {
      if (npc.state === 'despawned') return false;
      const dx = npc.mesh.position.x - car.pos.x;
      const dz = npc.mesh.position.z - car.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 35 || dist < 1) return false;
      const dot = dx * (-sinH) + dz * cosH;
      if (dot < 2) return false;
      if (!onRoundabout) {
        const lat = Math.abs(dx * (-cosH) - dz * sinH);
        if (lat > 1.2) return false;
        const headingDiff = Math.abs(Math.atan2(Math.sin(npc.heading - car.heading), Math.cos(npc.heading - car.heading)));
        if (headingDiff >= 1.2) return false;
      }
      return true;
    });
    if (!npcBehind) return;
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

  toggleMute() {
    this._muted = !this._muted;
    if (this._engMaster) this._engMaster.gain.value = this._muted ? 0 : 0.55;
    return this._muted;
  }

  _initEngineSound() {
    if (this._engOsc) return;
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      this._engOsc = ctx.createOscillator(); this._engOsc.type = 'sawtooth'; this._engOsc.frequency.value = 55;
      this._engSub = ctx.createOscillator(); this._engSub.type = 'triangle'; this._engSub.frequency.value = 27.5;
      this._engGain    = ctx.createGain(); this._engGain.gain.value    = 0.07;
      this._engSubGain = ctx.createGain(); this._engSubGain.gain.value = 0.05;
      this._engFilter  = ctx.createBiquadFilter(); this._engFilter.type = 'lowpass'; this._engFilter.frequency.value = 380; this._engFilter.Q.value = 1.8;
      this._engMaster  = ctx.createGain(); this._engMaster.gain.value = 0.55;
      this._engOsc.connect(this._engGain); this._engSub.connect(this._engSubGain);
      this._engGain.connect(this._engFilter); this._engSubGain.connect(this._engFilter);
      this._engFilter.connect(this._engMaster); this._engMaster.connect(ctx.destination);
      this._engOsc.start(); this._engSub.start();
    } catch (_) {}
  }

  _updateEngineSound() {
    if (!this._engOsc || !this._audioCtx) return;
    const ctx = this._audioCtx;
    if (ctx.state === 'suspended') { ctx.resume(); return; }
    const now = ctx.currentTime, tc = 0.06;
    const spd = Math.abs(this.car.speed) / MAX_SPEED;
    const freq = 55 + spd * 155;
    this._engOsc.frequency.setTargetAtTime(freq, now, tc);
    this._engSub.frequency.setTargetAtTime(freq / 2, now, tc);
    this._engFilter.frequency.setTargetAtTime(350 + spd * 2200, now, tc);
    const vol = 0.03 + spd * 0.10;
    this._engGain.gain.setTargetAtTime(vol, now, tc);
    this._engSubGain.gain.setTargetAtTime(vol * 0.65, now, tc);
  }

  _initDashboard() {}

  // ── Camera ─────────────────────────────────────────────────────────────────
  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 600);
    const { pos, heading } = this.car;
    this._camLag = new THREE.Vector3(
      pos.x - Math.sin(heading) * CAM_BACK, 0,
      pos.z + Math.cos(heading) * CAM_BACK,
    );
    this._updateCamera();
  }

  _updateCamera(dtScale = 1) {
    const { pos, heading, speed } = this.car;
    const { back, h, lookY, lookFwd, fov } = this._camCfg;
    const fwdX =  Math.sin(heading), fwdZ = -Math.cos(heading);
    const tx = pos.x - fwdX * back, tz = pos.z - fwdZ * back;
    const camAlpha = 1 - Math.pow(0.9, dtScale);
    this._camLag.x += (tx - this._camLag.x) * camAlpha;
    this._camLag.z += (tz - this._camLag.z) * camAlpha;
    this.camera.position.set(this._camLag.x, h, this._camLag.z);
    this.camera.lookAt(pos.x + fwdX * lookFwd, lookY, pos.z + fwdZ * lookFwd);
    this.camera.fov = fov + (Math.abs(speed) / MAX_SPEED) * 8;
    this.camera.updateProjectionMatrix();
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ── Player car ─────────────────────────────────────────────────────────────
  _buildPlayerCar(loader) {
    this._playerCarMesh    = null;
    this._frontWheelGroups = null;
    this._playerIndMeshes  = { left: [], right: [] };

    loader.load(`${BASE}models/car_white.glb`, (gltf) => {
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
      const hw = size.x * scale * 0.48, hl = size.z * scale * 0.48;
      const g  = new THREE.Group();
      g.add(gltf.scene);
      const mat     = new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide });
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
        'front-left':  { hw, hl, y: 0.5, inds: flInds  },
        'front-right': { hw, hl, y: 0.5, inds: frInds  },
        'rear':        { hw, hl, y: 0.5, inds: rearInds },
      };
      for (const part of ['front-left', 'front-right', 'rear']) {
        const d = this._defaultIndOff[part];
        this.setIndOffset(part, d.hw, d.y, d.hl);
      }
      this._playerCarMesh = g;
      this.scene.add(g);
    });
  }

  // ── Mission assignment ─────────────────────────────────────────────────────
  _assignMission() {
    let idx;
    do { idx = Math.floor(Math.random() * EXITS.length); }
    while (EXITS.length > 1 && idx === this._lastExitIndex);
    this._lastExitIndex = idx;
    const exit = EXITS[idx];
    this._exitTheta = exit.theta;
    this.car.targetExitNum    = exit.num;
    this.car.exitTravelTarget = exit.travelAngle;
    this.car.requiredLane     = exit.requiredLane;
    this.car.requiredRingLane = exit.requiredRingLane;
    this._checkADone            = false;
    this._checkBDone            = false;
    this._checkCDone            = false;
    this._checkDDone            = false;
    this._checkLaneApproachDone = false;
    this._checkExitLaneDone     = false;
  }

  startGame() {
    this._preview = false;
    const { pos, heading } = this.car;
    const { back } = this._camCfg;
    this._camLag.set(
      pos.x - Math.sin(heading) * back, 0,
      pos.z + Math.cos(heading) * back,
    );
  }

  pressKey(code)         { if (!this._preview) this.keys.add(code); }
  releaseKey(code)       { this.keys.delete(code); }
  triggerIndicator(side) { if (!this._preview) this._toggleIndicator(side); }

  nextMission() {
    this._missionIndex++;
    this._completeTimer = 0;
    this.restart();
  }

  _toggleIndicator(side) {
    const car = this.car;
    if (side === 'left') { car.leftIndicator = !car.leftIndicator; car.rightIndicator = false; }
    else                 { car.rightIndicator = !car.rightIndicator; car.leftIndicator  = false; }
    this._playIndicatorClick();
  }

  restart() {
    this.npcs?.forEach(npc => {
      npc.state        = 'despawned';
      npc.respawnTimer = 2 + Math.random() * 4;
      npc.mesh.visible = false;
      if (npc.indMeshes) {
        [...npc.indMeshes.left, ...npc.indMeshes.right].forEach(m => { m.visible = false; });
      }
    });
    const car = this.car;
    car.pos.set(-LANE_W * 1.5, 0, RB_OUT + ROAD_L * 0.55);
    car.heading = 0; car.speed = 0; car.steer = 0; car.yawRate = 0;
    car.phase = 'approaching'; car.leftIndicator = false; car.rightIndicator = false;
    car.entryAngle = SOUTH_ENTRY_ANGLE; car.traveledAngle = 0;
    car.approachLane = 'outer'; car.ringLane = 'outer';
    car.graceActive = false; car.graceTimer = 0; car.graceRequired = null;
    car.failed = false; car.failReason = null;
    this._prevRingAngle = null; this._prevDistFromCenter = null;
    this._completeTimer = 0;
    this._assignMission();
  }

  // ── State machine — adapted for 3-arm layout ───────────────────────────────
  _updateStateMachine(dt) {
    const car    = this.car;
    const TWO_PI = Math.PI * 2;

    if (car.failed || car.phase === 'completed') return;

    const dist = Math.sqrt(car.pos.x * car.pos.x + car.pos.z * car.pos.z);

    // ── Off-road check: generalised for any arm theta ──────────────────────
    const ARM_OVERLAP = 1.5;
    const onRoad = (dist > RB_IN && dist < RB_OUT) || ALL_ARM_THETAS.some(theta => {
      const radial  = car.pos.x * Math.sin(theta) + car.pos.z * (-Math.cos(theta));
      const lateral = Math.abs(car.pos.x * Math.cos(theta) + car.pos.z * Math.sin(theta));
      return radial > RB_OUT - ARM_OVERLAP && radial < RB_OUT + ROAD_L && lateral < ROAD_W / 2;
    });
    if (!onRoad) {
      car.failed     = true;
      car.failReason = dist < RB_IN
        ? 'You drove into the central island. Stay focused next time!'
        : "That's grass, not asphalt. Stay on the road.";
      return;
    }

    // ── Collision check ────────────────────────────────────────────────────
    for (const npc of this.npcs) {
      if (npc.state === 'despawned') continue;
      const dx = car.pos.x - npc.mesh.position.x;
      const dz = car.pos.z - npc.mesh.position.z;
      if (dx * dx + dz * dz < 3.5 * 3.5) {
        car.failed    = true;
        car.failReason = 'You crashed into traffic. Stay focused next time!';
        return;
      }
    }

    // ── Condition checker ──────────────────────────────────────────────────
    const exitRadial  = car.pos.x * Math.sin(this._exitTheta) + car.pos.z * (-Math.cos(this._exitTheta));
    const exitLateral = Math.abs(car.pos.x * Math.cos(this._exitTheta) + car.pos.z * Math.sin(this._exitTheta));
    const laneProj    = -(car.pos.x * Math.cos(this._exitTheta) + car.pos.z * Math.sin(this._exitTheta));

    const condOk = req =>
      req === 'left'           ? car.leftIndicator :
      req === 'right'          ? car.rightIndicator :
      req === 'none'           ? !car.leftIndicator && !car.rightIndicator :
      req === 'approach_outer' ? car.pos.x < -LANE_W :
      req === 'approach_inner' ? (car.pos.x >= -LANE_W && car.pos.x < 0) :
      req === 'ring_outer'     ? dist > RB_MID :
      req === 'ring_inner'     ? dist < RB_MID :
      req === 'exit_left'      ? laneProj > LANE_W :
      req === 'exit_right'     ? laneProj < LANE_W :
      req === 'signal'         ? (car.leftIndicator || car.rightIndicator) :
      true;

    // ── Grace countdown ────────────────────────────────────────────────────
    if (car.graceActive) {
      car.graceTimer -= dt;
      if (condOk(car.graceRequired)) {
        car.graceActive = false;
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

    const startGrace = (req, duration = 3.0) => {
      if (!car.graceActive) { car.graceActive = true; car.graceTimer = duration; car.graceRequired = req; }
    };

    // ── Phase: approaching ─────────────────────────────────────────────────
    if (car.phase === 'approaching') {
      car.approachLane = car.pos.x < -LANE_W ? 'outer' : 'inner';

      if (!this._checkLaneApproachDone && dist < RB_OUT + 20) {
        this._checkLaneApproachDone = true;
        const inOuter = car.pos.x < -LANE_W;
        if (car.targetExitNum === 1 && !inOuter) startGrace('approach_outer', 4.0); // NW: outer lane
        if (car.targetExitNum === 2 &&  inOuter) startGrace('approach_inner', 4.0); // NE: inner lane
      }

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

      const raw  = Math.atan2(-car.pos.z, car.pos.x);
      const norm = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
      if (this._prevRingAngle !== null) {
        let d = norm - this._prevRingAngle;
        if (d < -Math.PI) d += TWO_PI;
        if (d >  Math.PI) d -= TWO_PI;
        car.traveledAngle -= d;
      }
      this._prevRingAngle = norm;

      // ── Check (b): at 120° — exit 2 (NE) must still have right indicator ──
      if (!this._checkBDone && car.traveledAngle >= 2 * Math.PI / 3 - 0.15) {
        this._checkBDone = true;
        if (car.targetExitNum === 2 && !condOk('right')) startGrace('right');
      }

      // ── Check (d): exit 2 — left indicator required just after passing NW exit ──
      if (!this._checkDDone && car.targetExitNum === 2 && car.traveledAngle >= 2 * Math.PI / 3 + 0.1) {
        this._checkDDone = true;
        if (!condOk('left')) startGrace('left');
      }

      // ── Check (c): left indicator before exit ─────────────────────────────
      const checkCThreshold = car.targetExitNum === 2
        ? 2 * Math.PI / 3 + 0.1   // just after passing NW (exit 1) — signal left for NE
        : car.exitTravelTarget - 0.7;  // ~40° before NW exit
      if (!this._checkCDone && car.traveledAngle >= checkCThreshold) {
        this._checkCDone = true;
        if (!condOk('left')) startGrace('left');
      }

      // ── Ring lane check ────────────────────────────────────────────────────
      // Exit 1 (NW, short): outer ring. Exit 2 (NE, long): inner ring.
      const needOuterRing = car.targetExitNum === 1;
      const ringLaneCheckActive = !(car.targetExitNum === 2 && this._checkCDone);
      if (ringLaneCheckActive && needOuterRing !== (dist > RB_MID)) {
        startGrace(needOuterRing ? 'ring_outer' : 'ring_inner', 3.0);
      }

      // ── Lane-change indicator check ────────────────────────────────────────
      if (this._prevDistFromCenter !== null) {
        const radialDelta = Math.abs(dist - this._prevDistFromCenter);
        if (radialDelta > 0.5 && !car.leftIndicator && !car.rightIndicator) {
          startGrace('signal', 2.0);
        }
      }
      this._prevDistFromCenter = dist;

      // ── Phase transition ───────────────────────────────────────────────────
      const onExitArm = exitLateral < ROAD_W / 2 && exitRadial > RB_OUT;
      if (onExitArm) car.graceActive = false;
      if (car.traveledAngle >= car.exitTravelTarget - 0.15 || onExitArm) {
        car.phase = 'exiting';
      }

    // ── Phase: exiting ─────────────────────────────────────────────────────
    } else if (car.phase === 'exiting') {
      const exitTrigger = car.targetExitNum === 2 ? RB_OUT + 6 : RB_OUT + 2;
      if (!this._checkExitLaneDone && exitRadial > exitTrigger) {
        this._checkExitLaneDone = true;
        if (car.targetExitNum === 1) {
          if (!condOk('exit_left'))  startGrace('exit_left',  3.0);
        } else {
          if (!condOk('exit_right')) startGrace('exit_right', 3.0);
        }
      }
      if (exitRadial >= RB_OUT + 8) {
        const exitReq = car.targetExitNum === 1 ? 'exit_left' : 'exit_right';
        if (!condOk(exitReq)) {
          car.failed = true; car.graceActive = false;
          car.failReason = "Maintain lane position when exiting.";
          return;
        }
        car.phase = 'completed';
        this._completeTimer = 1;
      }
    }
  }

  // ── Physics update ─────────────────────────────────────────────────────────
  _update() {
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const dtScale = dt * 60;
    this.elapsed += dt * 1000;

    if (this._preview) {
      const t = this.elapsed / 1000;
      const { r, h, spd, fov } = this._previewCfg;
      this.camera.position.set(Math.sin(t * spd) * r, h, Math.cos(t * spd) * r);
      this.camera.lookAt(0, 0, 0);
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const car = this.car;

    if      (this.keys.has('ArrowLeft'))  car.steer = Math.max(car.steer - 0.13 * dtScale, -1);
    else if (this.keys.has('ArrowRight')) car.steer = Math.min(car.steer + 0.13 * dtScale,  1);
    else                                  car.steer *= Math.pow(0.88, dtScale);

    if (this.keys.has('ArrowUp')) {
      car.speed += ACCEL * dtScale;
    } else if (this.keys.has('ArrowDown')) {
      car.speed = car.speed > 0.01 ? car.speed - BRAKE * dtScale : car.speed - ACCEL * 0.5 * dtScale;
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

    this._prevBlinkOn  = this._blinkOn;
    this._blinkTimer  += dt;
    this._blinkOn = Math.floor(this._blinkTimer * 3) % 2 === 0;
    if (this._prevBlinkOn !== this._blinkOn && (car.leftIndicator || car.rightIndicator)) {
      this._playIndicatorClick();
    }

    if (this._playerIndMeshes) {
      const on = this._blinkOn;
      this._playerIndMeshes.left.forEach(m  => { m.visible = car.leftIndicator  && on; });
      this._playerIndMeshes.right.forEach(m => { m.visible = car.rightIndicator && on; });
    }

    if (!this._preview) { this._initEngineSound(); this._updateEngineSound(); }
    this._updateCamera(dtScale);
    this._updateNPCs(dt, dtScale);
    this._updateStateMachine(dt);
    this._updateHornCheck(dt);

    if (this._playerCarMesh) {
      this._playerCarMesh.position.set(
        car.pos.x + Math.sin(car.heading) * 1.55, 0,
        car.pos.z - Math.cos(car.heading) * 1.55,
      );
      this._playerCarMesh.rotation.y = -car.heading;
    }

    if (this._frontWheelGroups) {
      this._frontWheelGroups.forEach(pivot => { pivot.rotation.y = -car.steer * 0.42; });
    }

    const kmh = Math.round((spd / MAX_SPEED) * 80);
    this.onHUD?.({
      speed:          kmh,
      speedRatio:     spd / MAX_SPEED,
      gear:           car.speed >= 0 ? 'D' : 'R',
      steer:          car.steer,
      phase:          car.phase,
      showComplete:   this._completeTimer > 0,
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
      this._indOnMouseDown = this._indOnMouseMove = this._indOnMouseUp = null;
    }
    try { this._engOsc?.stop(); this._engSub?.stop(); } catch (_) {}
    try { this._audioCtx?.close(); } catch (_) {}
    this.renderer.dispose();
  }
}
