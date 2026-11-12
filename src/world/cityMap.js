// Sun shadows and ambient occlusion without a per-frame shadow pass.
//
// Once the city has loaded it is rendered straight down into a height map (2048^2 over the 24 km tile grid,
// 11.7 m per texel). From that map two textures are derived, both read with one fetch per fragment:
//   city map   (static)  r: average building height nearby (occlusion), g: blurred land mask (shore),
//                        b / a: built-up density at ~70 m and ~280 m
//   shadow map (per sun) r: the height below which a point is in shadow. Each texel marches toward the sun
//                        through the height map; far steps read max-filtered copies so thin towers are not missed.
// When the sun moves the shadow map is recomputed in strips over a few frames and then swapped in.
import * as THREE from 'three';

const SIZE = 2048;
const HALF = 12000;
const STRIPS = 24;
const STEPS = 40;

const FS_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export function createCityMap(renderer, env) {
  const target = (size, opts = {}) => new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...opts,
  });
  const heightRT = target(SIZE, { depthBuffer: true });
  const max1 = target(SIZE / 4); // 47 m texels
  const max2 = target(SIZE / 16); // 188 m texels
  const cityRT = target(SIZE, { type: THREE.UnsignedByteType });
  let front = target(SIZE, { format: THREE.RedFormat });
  let back = target(SIZE, { format: THREE.RedFormat });

  const topCamera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 1, 4000);
  topCamera.position.set(0, 3000, 0);
  topCamera.up.set(0, 0, -1); // north at the top of the map
  topCamera.lookAt(0, 0, 0);
  topCamera.updateMatrixWorld();

  // r: height of anything standing above the land slab, g: land or building, b: building.
  const heightMaterial = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying float vY;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = modelMatrix * instanceMatrix;
        #endif
        vec4 wp = m * vec4(position, 1.0);
        vY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vY;
      void main() {
        float b = step(1.8, vY);
        gl_FragColor = vec4(b * max(vY, 0.0), 1.0, b, 1.0);
      }
    `,
  });

  const maxMaterial = (n, texel) => new THREE.ShaderMaterial({
    uniforms: { tH: { value: null } },
    vertexShader: FS_VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tH;
      varying vec2 vUv;
      void main() {
        float m = 0.0;
        for (int i = 0; i < ${n}; i++) for (int j = 0; j < ${n}; j++)
          m = max(m, texture2D(tH, vUv + (vec2(float(i), float(j)) - ${((n - 1) / 2).toFixed(1)}) * ${texel.toFixed(8)}).r);
        gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
      }
    `,
  });
  const max1Material = maxMaterial(4, 1 / SIZE);
  const max2Material = maxMaterial(4, 4 / SIZE);

  const cityMaterial = new THREE.ShaderMaterial({
    uniforms: { tH: { value: heightRT.texture } },
    vertexShader: FS_VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tH;
      varying vec2 vUv;
      const float T = ${(1 / SIZE).toFixed(8)};
      void main() {
        float h = 0.0, near = 0.0, land = 0.0, wide = 0.0;
        for (int i = 0; i < 16; i++) {
          float fi = float(i);
          vec2 o = vec2(cos(fi * 2.39996), sin(fi * 2.39996)) * sqrt((fi + 0.5) / 16.0);
          vec4 s = texture2D(tH, vUv + o * 6.0 * T);
          h += s.r;
          near += s.b;
        }
        for (int i = 0; i < 24; i++) {
          float fi = float(i);
          vec2 o = vec2(cos(fi * 2.39996), sin(fi * 2.39996)) * sqrt((fi + 0.5) / 24.0);
          vec4 s = texture2D(tH, vUv + o * 24.0 * T);
          land += s.g;
          wide += s.b;
        }
        gl_FragColor = vec4(min(h / 16.0 / 510.0, 1.0), land / 24.0, near / 16.0, wide / 24.0);
      }
    `,
  });

  const shadowMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tH: { value: heightRT.texture }, tM1: { value: max1.texture }, tM2: { value: max2.texture },
      uDir: { value: new THREE.Vector2() }, uTan: { value: 1 }, uReach: { value: 1000 },
    },
    vertexShader: FS_VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tH;
      uniform sampler2D tM1;
      uniform sampler2D tM2;
      uniform vec2 uDir;   // one metre toward the sun, in map uv
      uniform float uTan;  // tangent of the sun's elevation
      uniform float uReach;
      varying vec2 vUv;
      void main() {
        const float D0 = 14.0;
        float ratio = pow(uReach / D0, 1.0 / ${(STEPS - 1).toFixed(1)});
        float d = D0;
        float s = -1000.0;
        for (int i = 0; i < ${STEPS}; i++) {
          vec2 q = vUv + uDir * d;
          float gap = d * (ratio - 1.0);
          float h = gap < 30.0 ? texture2D(tH, q).r : (gap < 110.0 ? texture2D(tM1, q).r : texture2D(tM2, q).r);
          s = max(s, h - d * uTan);
          d *= ratio;
        }
        gl_FragColor = vec4(s, 0.0, 0.0, 1.0);
      }
    `,
  });

  const fsScene = new THREE.Scene();
  const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  quad.frustumCulled = false;
  fsScene.add(quad);
  function pass(material, rt) {
    quad.material = material;
    renderer.setRenderTarget(rt);
    renderer.render(fsScene, fsCamera);
  }

  let ready = false, job = null;
  const lastDir = new THREE.Vector3(0, -1, 0);

  function shadowStrip(dir, from, to) {
    const h = Math.hypot(dir.x, dir.z) || 1e-4;
    const tan = Math.max(dir.y, 0.03) / h;
    shadowMaterial.uniforms.uDir.value.set(dir.x / h / (2 * HALF), -dir.z / h / (2 * HALF));
    shadowMaterial.uniforms.uTan.value = tan;
    shadowMaterial.uniforms.uReach.value = Math.min(Math.max(850 / tan, 60), 7000);
    const y0 = Math.floor((from / STRIPS) * SIZE), y1 = Math.floor((to / STRIPS) * SIZE);
    back.scissorTest = true;
    back.scissor.set(0, y0, SIZE, y1 - y0);
    pass(shadowMaterial, back);
    back.scissorTest = false;
  }
  function swap() {
    [front, back] = [back, front];
    env.uniforms.uShadowMap.value = front.texture;
  }

  return {
    get ready() { return ready; },
    /**
     * Render the height map and everything derived from it. Call once the city has loaded.
     * @param {THREE.Scene} scene  @param {THREE.Object3D[]} hide objects that must not count as ground or buildings
     */
    render(scene, hide) {
      const prevTarget = renderer.getRenderTarget();
      const wasVisible = hide.map((o) => o.visible);
      hide.forEach((o) => { o.visible = false; });
      scene.overrideMaterial = heightMaterial;
      const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(heightRT);
      renderer.clear();
      renderer.render(scene, topCamera);
      scene.overrideMaterial = null;
      hide.forEach((o, i) => { o.visible = wasVisible[i]; });

      max1Material.uniforms.tH.value = heightRT.texture;
      pass(max1Material, max1);
      max2Material.uniforms.tH.value = max1.texture;
      pass(max2Material, max2);
      pass(cityMaterial, cityRT);
      env.uniforms.uCityMap.value = cityRT.texture;

      lastDir.copy(env.uniforms.uLightDir.value);
      shadowStrip(lastDir, 0, STRIPS);
      swap();
      renderer.setClearColor(clear, alpha);
      renderer.setRenderTarget(prevTarget);
      ready = true;
      job = null;
    },
    /** Per frame: keep the shadow map in step with the sun, a strip at a time. */
    update() {
      env.uniforms.uShadowOn.value = ready ? env.shadow : 0;
      if (!ready || env.shadow <= 0) return;
      const dir = env.uniforms.uLightDir.value;
      if (!job && dir.angleTo(lastDir) > 0.006) job = { dir: dir.clone(), strip: 0 };
      if (!job) return;
      const prevTarget = renderer.getRenderTarget();
      shadowStrip(job.dir, job.strip, job.strip + 1);
      renderer.setRenderTarget(prevTarget);
      if (++job.strip === STRIPS) {
        lastDir.copy(job.dir);
        swap();
        job = null;
      }
    },
  };
}
