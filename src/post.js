// Final image: ACES tone mapping with exposure from the environment, and bloom when it is worth its cost.
//
// Bloom path: the scene renders into one float target, a bright-pass shrinks it to half size, five more cheap
// downsamples and upsamples blur it (dual filtering), and a single full-screen pass smooths edges (FXAA),
// adds the glow, tone-maps and writes sRGB.
// The float target has no MSAA: measured at 1920x1080 on Intel Iris Xe, 4x MSAA on a float target cost 6 to 7 ms
// a frame (16.5 to 19 ms in total), FXAA in the final pass about 1 ms. EffectComposer + UnrealBloomPass was slower still.
// With bloom off the scene renders straight to the canvas and every material tone-maps itself (OUTPUT chunk).
import * as THREE from 'three';
import { OUTPUT } from './shaders/common.glsl.js';

const LEVELS = 5;
const THRESHOLD = 0.9; // scene-linear; only what exceeds it glows

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export function createPost(renderer, scene, camera) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  let sceneRT = null, mips = [];
  let size = { width: 1, height: 1, dpr: 1 };
  let allocated = '';

  const brightMaterial = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: VERTEX,
    depthTest: false,
    depthWrite: false,
    fragmentShader: /* glsl */ `
      uniform sampler2D tMap;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec3 c = vec3(0.0);
        c += texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        c = min(c * 0.25, vec3(24.0)); // also keeps a stray huge pixel from flooding the frame
        float l = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c * (max(l - ${THRESHOLD.toFixed(2)}, 0.0) / max(l, 1e-4)), 1.0);
      }
    `,
  });
  const downMaterial = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: VERTEX,
    depthTest: false,
    depthWrite: false,
    fragmentShader: /* glsl */ `
      uniform sampler2D tMap;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tMap, vUv).rgb * 4.0;
        c += texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(c / 8.0, 1.0);
      }
    `,
  });
  // Adds the next smaller level on top of this one (additive blending).
  const upMaterial = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: VERTEX,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    transparent: true,
    fragmentShader: /* glsl */ `
      uniform sampler2D tMap;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
        c += texture2D(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(c * 0.25, 1.0);
      }
    `,
  });
  const finalMaterial = new THREE.ShaderMaterial({
    uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 0 }, uPixel: { value: new THREE.Vector2() } },
    vertexShader: VERTEX,
    depthTest: false,
    depthWrite: false,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene;
      uniform sampler2D tBloom;
      uniform float uStrength;
      uniform vec2 uPixel;
      varying vec2 vUv;

      // Scene colour squeezed into 0..1 so edges are judged the way the eye sees them.
      vec3 tap(vec2 uv) {
        vec3 c = texture2D(tScene, uv).rgb;
        return c / (1.0 + max(c.r, max(c.g, c.b)));
      }

      // FXAA (Timothy Lottes), the compact nine-tap form.
      vec3 fxaa(vec2 uv) {
        const vec3 W = vec3(0.299, 0.587, 0.114);
        vec3 nw = tap(uv + vec2(-1.0, -1.0) * uPixel), ne = tap(uv + vec2(1.0, -1.0) * uPixel);
        vec3 sw = tap(uv + vec2(-1.0, 1.0) * uPixel), se = tap(uv + vec2(1.0, 1.0) * uPixel);
        vec3 m = tap(uv);
        float lnw = dot(nw, W), lne = dot(ne, W), lsw = dot(sw, W), lse = dot(se, W), lm = dot(m, W);
        float lmin = min(lm, min(min(lnw, lne), min(lsw, lse)));
        float lmax = max(lm, max(max(lnw, lne), max(lsw, lse)));
        vec2 dir = vec2(-((lnw + lne) - (lsw + lse)), (lnw + lsw) - (lne + lse));
        float reduce = max((lnw + lne + lsw + lse) * 0.03125, 0.0078125);
        dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), vec2(-8.0), vec2(8.0)) * uPixel;
        vec3 a = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
        vec3 b = a * 0.5 + 0.25 * (tap(uv - dir * 0.5) + tap(uv + dir * 0.5));
        float lb = dot(b, W);
        return (lb < lmin || lb > lmax) ? a : b;
      }

      void main() {
        vec3 c = fxaa(vUv);
        c = c / max(1.0 - max(c.r, max(c.g, c.b)), 0.02); // back to scene-linear
        c += texture2D(tBloom, vUv).rgb * uStrength;
        gl_FragColor = vec4(c, 1.0);
        ${OUTPUT}
      }
    `,
  });

  const fsScene = new THREE.Scene();
  const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  quad.frustumCulled = false;
  fsScene.add(quad);
  function pass(material, target, source, clear) {
    material.uniforms.tMap.value = source.texture;
    material.uniforms.uTexel.value.set(0.5 / source.width, 0.5 / source.height);
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.autoClear = clear;
    renderer.render(fsScene, fsCamera);
  }

  function allocate() {
    const w = Math.max(2, Math.round(size.width * size.dpr)), h = Math.max(2, Math.round(size.height * size.dpr));
    const key = `${w}x${h}`;
    if (key === allocated) return;
    allocated = key;
    if (sceneRT) sceneRT.dispose();
    mips.forEach((m) => m.dispose());
    sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < LEVELS; i++) {
      mw = Math.max(2, mw >> 1);
      mh = Math.max(2, mh >> 1);
      mips.push(new THREE.WebGLRenderTarget(mw, mh, { type: THREE.HalfFloatType, depthBuffer: false }));
    }
  }

  return {
    setSize(width, height, dpr) {
      size = { width, height, dpr };
    },
    /** @param {{ exposure: number, bloom: number }} env  @param {boolean} allowBloom from the quality setting */
    render(env, allowBloom) {
      renderer.toneMappingExposure = env.exposure;
      if (!(allowBloom && env.bloom > 0.01)) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      allocate();
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);

      pass(brightMaterial, mips[0], sceneRT, true);
      for (let i = 1; i < LEVELS; i++) pass(downMaterial, mips[i], mips[i - 1], true);
      for (let i = LEVELS - 2; i >= 0; i--) pass(upMaterial, mips[i], mips[i + 1], false);

      finalMaterial.uniforms.tScene.value = sceneRT.texture;
      finalMaterial.uniforms.tBloom.value = mips[0].texture;
      finalMaterial.uniforms.uPixel.value.set(1 / sceneRT.width, 1 / sceneRT.height);
      finalMaterial.uniforms.uStrength.value = env.bloom * 0.6; // five summed levels, see timeOfDay.js for env.bloom
      quad.material = finalMaterial;
      renderer.setRenderTarget(null);
      renderer.autoClear = true;
      renderer.render(fsScene, fsCamera);
    },
  };
}
