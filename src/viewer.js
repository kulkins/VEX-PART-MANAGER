import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// The Viewer owns the Three.js scene, camera, lights, picking, ghost
// outline overlay, and the explode animation.
//
// Color modes:
//   - "natural":  use the part's source color if the file provided one,
//                 otherwise a deterministic palette color derived from the
//                 part's id. This is the default and is what CAD users expect.
//   - "category": tint every mesh by the classifier category (Structure,
//                 Motion, Hardware, etc.). Useful for understanding what the
//                 app detected.
export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1020);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 5000);
    this.camera.position.set(8, 6, 10);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.05;
    this.controls.maxDistance = 5000;

    this._buildLights();
    this._buildGrid();

    this.assembly = null;
    this.ghostGroup = null;
    this.parts = [];
    this.explodeAmount = 0;
    this.selectedMesh = null;
    this.categoryColors = new Map();
    this.colorMode = "natural";
    this.ghostUserPref = null; // null = auto, true/false = explicit override
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._onSelect = null;
    this._explodeAnim = null;

    this._tick = this._tick.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._pointerDownPos = null;
    canvas.addEventListener("pointerdown", (e) => {
      this._pointerDownPos = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointerup", this._onPointerUp);

    this.onResize();
    window.addEventListener("resize", () => this.onResize());
    requestAnimationFrame(this._tick);
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x202650, 0.65);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(12, 18, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 80;
    key.shadow.camera.left = -20;
    key.shadow.camera.right = 20;
    key.shadow.camera.top = 20;
    key.shadow.camera.bottom = -20;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xaab8ff, 0.45);
    fill.position.set(-14, 8, -10);
    this.scene.add(fill);
  }

  _buildGrid() {
    const grid = new THREE.GridHelper(40, 40, 0x2a335a, 0x1a2240);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.position.y = -0.01;
    this.scene.add(grid);
    this.grid = grid;

    const floorMat = new THREE.ShadowMaterial({ opacity: 0.18 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.floor = floor;
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 1.4;
  }

  setSelectHandler(fn) {
    this._onSelect = fn;
  }

  clear() {
    if (this.assembly) {
      this.scene.remove(this.assembly);
      disposeObject(this.assembly);
      this.assembly = null;
    }
    if (this.ghostGroup) {
      this.scene.remove(this.ghostGroup);
      disposeObject(this.ghostGroup);
      this.ghostGroup = null;
    }
    this.parts = [];
    this.selectedMesh = null;
    this.explodeAmount = 0;
  }

  loadAssembly(assembly, categoryColors) {
    this.clear();
    this.categoryColors = categoryColors;
    this.assembly = assembly;

    let meshCount = 0;
    assembly.traverse((c) => { if (c.isMesh) meshCount++; });
    console.log(`[viewer] loadAssembly: ${meshCount} mesh(es)`);

    // Normalize: recenter on origin and scale so the longest dim is ~10 units.
    const box = new THREE.Box3().setFromObject(assembly);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 10 / maxDim;
    console.log(
      `[viewer] raw extents: ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} ` +
        `· view scale: ${scale.toFixed(4)} (longest dim -> 10 units)`,
    );
    assembly.position.sub(center.multiplyScalar(scale));
    assembly.scale.setScalar(scale);
    this.viewScale = scale;

    let partIndex = 0;
    assembly.traverse((c) => {
      if (!c.isMesh) return;
      const baseColor = this._colorFor(c, partIndex++);
      c.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(baseColor),
        roughness: 0.42,
        metalness: 0.32,
      });
      c.material.userData.baseColor = c.material.color.clone();
      c.userData.naturalColor = this._naturalColorFor(c, partIndex - 1);
      c.userData.categoryColor =
        categoryColors.get(c.userData.category) || 0x9aa3c6;
      c.castShadow = true;
      c.receiveShadow = true;
    });

    assembly.updateMatrixWorld(true);
    this.parts = [];
    assembly.traverse((c) => {
      if (!c.isMesh) return;
      const worldCenter = new THREE.Vector3();
      const bb = new THREE.Box3().setFromObject(c);
      bb.getCenter(worldCenter);
      this.parts.push({
        mesh: c,
        originalPos: c.position.clone(),
        worldCenter,
        explodeOffset: new THREE.Vector3(0, 0, 0),
      });
    });

    this._computeExplodeOffsets();
    this._buildGhostOutline();
    this._updateGhostVisibility();
    this.frame();
  }

  _naturalColorFor(mesh, index) {
    // Prefer the source CAD color if the parser stored one.
    if (mesh.userData.sourceColor) return mesh.userData.sourceColor;
    // Otherwise, deterministic golden-angle hue palette so adjacent parts get
    // visually distinct colors. Bright enough to read against the dark scene
    // background without looking like a candy box.
    const golden = 0.61803398875;
    const hue = (index * golden) % 1;
    const sat = 0.45 + ((index * 7) % 10) * 0.025; // 0.45..0.70
    const lit = 0.62 + ((index * 5) % 7) * 0.025; // 0.62..0.77
    return new THREE.Color().setHSL(hue, sat, lit).getHex();
  }

  _colorFor(mesh, index) {
    if (this.colorMode === "category") {
      return this.categoryColors.get(mesh.userData.category) || 0x9aa3c6;
    }
    return this._naturalColorFor(mesh, index);
  }

  setColorMode(mode) {
    if (mode !== "natural" && mode !== "category") return;
    this.colorMode = mode;
    if (!this.assembly) return;
    this.assembly.traverse((c) => {
      if (!c.isMesh) return;
      const hex =
        mode === "category"
          ? c.userData.categoryColor
          : c.userData.naturalColor;
      const color = new THREE.Color(hex);
      c.material.color.copy(color);
      c.material.userData.baseColor = color.clone();
    });
  }

  _computeExplodeOffsets() {
    if (!this.parts.length) return;
    const center = new THREE.Vector3();
    for (const p of this.parts) center.add(p.worldCenter);
    center.divideScalar(this.parts.length);

    const categoryDir = new Map();
    const baseDirs = [
      new THREE.Vector3(-1.2, 0.3, 0),
      new THREE.Vector3(1.2, 0.3, 0),
      new THREE.Vector3(0, 1.1, 0),
      new THREE.Vector3(0, -0.6, 1.1),
      new THREE.Vector3(0, -0.6, -1.1),
      new THREE.Vector3(-1, -0.6, -1),
      new THREE.Vector3(1, -0.6, 1),
    ];
    const categoryIds = [
      ...new Set(this.parts.map((p) => p.mesh.userData.category)),
    ];
    categoryIds.forEach((id, i) => {
      categoryDir.set(id, baseDirs[i % baseDirs.length].clone().normalize());
    });

    const bbox = new THREE.Box3();
    for (const p of this.parts) bbox.expandByPoint(p.worldCenter);
    const spread = bbox.getSize(new THREE.Vector3()).length() || 5;
    const explodeRadius = Math.max(spread, 6) * 1.1;

    const categoryCount = new Map();
    for (const p of this.parts) {
      const id = p.mesh.userData.category;
      categoryCount.set(id, (categoryCount.get(id) || 0) + 1);
    }
    const categoryIndex = new Map();

    for (const p of this.parts) {
      const id = p.mesh.userData.category;
      const i = categoryIndex.get(id) || 0;
      categoryIndex.set(id, i + 1);
      const total = categoryCount.get(id);

      const radial = p.worldCenter.clone().sub(center);
      if (radial.lengthSq() < 1e-6) radial.set(0, 0.01, 0);
      const radialDir = radial.clone().normalize();

      const catDir = categoryDir.get(id) || radialDir;
      const dir = radialDir
        .clone()
        .multiplyScalar(0.4)
        .add(catDir.clone().multiplyScalar(1.4))
        .normalize();

      const tangent = new THREE.Vector3(-catDir.z, 0, catDir.x).normalize();
      const fanOffset = tangent
        .clone()
        .multiplyScalar(((i + 0.5) / total - 0.5) * explodeRadius * 0.7);
      const verticalStack = new THREE.Vector3(
        0,
        ((i + 0.5) / total - 0.5) * explodeRadius * 0.5,
        0,
      );

      p.explodeOffset = dir
        .multiplyScalar(explodeRadius)
        .add(fanOffset)
        .add(verticalStack);
    }
  }

  _buildGhostOutline() {
    if (!this.assembly) return;
    const group = new THREE.Group();
    this.assembly.traverse((c) => {
      if (!c.isMesh) return;
      const edges = new THREE.EdgesGeometry(c.geometry, 22);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: 0x6ee7ff,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
        }),
      );
      c.updateMatrixWorld(true);
      line.applyMatrix4(c.matrixWorld);
      group.add(line);
    });
    this.ghostGroup = group;
    this.scene.add(group);
  }

  // User-controlled override. `null` resets to automatic (driven by explode).
  setGhostVisible(visible) {
    this.ghostUserPref = visible;
    this._updateGhostVisibility();
  }

  _updateGhostVisibility() {
    if (!this.ghostGroup) return;
    if (this.ghostUserPref === true) {
      this.ghostGroup.visible = true;
      this._setGhostOpacity(0.55);
    } else if (this.ghostUserPref === false) {
      this.ghostGroup.visible = false;
    } else {
      // Auto: faint baseline outline while assembled (so the user always sees
      // the model, even if the lighting/material would otherwise leave it
      // looking flat), brightening as the explode amount grows.
      const a = this.explodeAmount;
      this.ghostGroup.visible = true;
      this._setGhostOpacity(0.12 + a * 0.40);
    }
  }

  _setGhostOpacity(o) {
    if (!this.ghostGroup) return;
    this.ghostGroup.traverse((c) => {
      if (c.material) c.material.opacity = o;
    });
  }

  setWireframe(on) {
    if (!this.assembly) return;
    this.assembly.traverse((c) => {
      if (c.isMesh) c.material.wireframe = on;
    });
  }

  setExplode(amount) {
    this.explodeAmount = THREE.MathUtils.clamp(amount, 0, 1);
    for (const p of this.parts) {
      const offset = p.explodeOffset.clone().multiplyScalar(this.explodeAmount);
      const local = offset.clone().divideScalar(this.viewScale || 1);
      p.mesh.position.copy(p.originalPos).add(local);
    }
    this._updateGhostVisibility();
  }

  animateExplode(target, duration = 1400) {
    cancelAnimationFrame(this._explodeAnim);
    const start = performance.now();
    const from = this.explodeAmount;
    const to = THREE.MathUtils.clamp(target, 0, 1);
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      const eased = easeInOutCubic(t);
      this.setExplode(from + (to - from) * eased);
      if (t < 1) this._explodeAnim = requestAnimationFrame(step);
    };
    this._explodeAnim = requestAnimationFrame(step);
  }

  frame() {
    if (!this.assembly) return;
    const box = new THREE.Box3().setFromObject(this.assembly);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const target = sphere.center;
    const radius = Math.max(sphere.radius, 1);

    const dir = new THREE.Vector3(1, 0.7, 1.2).normalize();
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position
      .copy(target)
      .add(dir.multiplyScalar(distance * 1.4));
    this.controls.target.copy(target);
    this.controls.update();

    this.grid.position.y = box.min.y - 0.01;
    this.floor.position.y = box.min.y - 0.01;
  }

  highlight(mesh) {
    if (this.selectedMesh && this.selectedMesh.material?.userData?.baseColor) {
      this.selectedMesh.material.color.copy(
        this.selectedMesh.material.userData.baseColor,
      );
      this.selectedMesh.material.emissive?.setHex(0x000000);
    }
    this.selectedMesh = mesh || null;
    if (mesh) {
      mesh.material.emissive = new THREE.Color(0x224a6e);
      mesh.material.color
        .copy(mesh.material.userData.baseColor)
        .lerp(new THREE.Color(0xffffff), 0.18);
    }
  }

  _onPointerUp(e) {
    if (!this._pointerDownPos) return;
    const dx = e.clientX - this._pointerDownPos.x;
    const dy = e.clientY - this._pointerDownPos.y;
    this._pointerDownPos = null;
    if (Math.hypot(dx, dy) > 4) return;
    if (!this.assembly) return;
    const rect = this.canvas.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this._raycaster.intersectObject(this.assembly, true);
    const hit = hits.find((h) => h.object.isMesh);
    if (hit) {
      this.highlight(hit.object);
      this._onSelect?.(hit.object);
    } else {
      this.highlight(null);
      this._onSelect?.(null);
    }
  }

  onResize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._tick);
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function disposeObject(obj) {
  obj.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of mats) m.dispose?.();
    }
  });
}
