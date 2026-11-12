// Final image. In High quality every frame goes through here:
//   1. the scene renders into one float target with a depth texture (no MSAA: 4x MSAA on a float target cost
//      6 to 7 ms a frame at 1920x1080 on Intel Iris Xe);
//   2. contact shading (SSAO) is computed at quarter size from the depth alone and blurred: it darkens the foot of
//      every wall, the gaps between buildings and the creases of the landmarks, which is most of what makes
//      a model look built instead of drawn;
//   3. when the hour calls for it, a bright-pass is blurred down and up five levels (dual filtering) for bloom;
//   4. one full-screen pass does FXAA, applies the contact shading, adds the bloom, tone-maps (ACES), grades
//      (contrast, cool shadows and warm highlights, vignette, grain) and writes sRGB.
// Low quality renders straight to the canvas; every material tone-maps itself there (OUTPUT chunk).
import * as THREE from 'three';

const LEVELS = 5;
const THRESHOLD = 0.9; // scene-linear; only what exceeds it glows
const AO_SAMPLES = 6;

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export function createPost(renderer, scene, camera) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  let sceneRT = null, aoRT = null, aoBlurRT = null, mips = [];
  let size = { width: 1, height: 1, dpr: 1 };
  let allocated = '';
  let clock = 0;

  const flat = { depthTest: false, depthWrite: false, vertexShader: VERTEX };

  const aoMaterial = new THREE.ShaderMaterial({
    ...flat,
    uniforms: { tDepth: { value: null }, uPixel: { value: new THREE.Vector2() }, uNear: { value: 1 }, uFar: { value: 1 }, uProj: { value: new THREE.Vector2() } },
    fragmentShader: /* glsl */ `
      uniform sampler2D tDepth;
      uniform vec2 uPixel;  // one full-resolution pixel in uv
      uniform float uNear;
      uniform float uFar;
      uniform vec2 uProj;   // tan(fov / 2) * aspect, tan(fov / 2)
      varying vec2 vUv;

      float viewZ(vec2 uv) {
        float z = texture2D(tDepth, uv).r * 2.0 - 1.0;
        return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
      }
      vec3 viewPos(vec2 uv) {
        float z = viewZ(uv);
        return vec3((uv * 2.0 - 1.0) * uProj * z, -z);
      }

      void main() {
        vec3 p = viewPos(vUv);
        float z = -p.z;
        if (z > uFar * 0.5) { gl_FragColor = vec4(1.0); return; } // sky

        // Surface normal from the depth of the neighbours, taking the nearer neighbour on each axis so edges stay sharp.
        vec3 xa = viewPos(vUv + vec2(uPixel.x, 0.0)) - p, xb = p - viewPos(vUv - vec2(uPixel.x, 0.0));
        vec3 ya = viewPos(vUv + vec2(0.0, uPixel.y)) - p, yb = p - viewPos(vUv - vec2(0.0, uPixel.y));
        vec3 n = normalize(cross(abs(xa.z) < abs(xb.z) ? xa : xb, abs(ya.z) < abs(yb.z) ? ya : yb));

        // The radius grows with distance so the shading reads the same in a close-up and from the air.
        float radius = clamp(z * 0.014, 2.0, 45.0);
        vec2 reach = radius / (z * uProj) * 0.5;
        float turn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
        float occ = 0.0;
        for (int i = 0; i < ${AO_SAMPLES}; i++) {
          float a = turn + float(i) * 2.39996;
          float r = sqrt((float(i) + 0.5) / ${AO_SAMPLES.toFixed(1)});
          vec3 v = viewPos(vUv + vec2(cos(a), sin(a)) * r * reach) - p;
          float d = length(v);
          occ += max(dot(n, v) / (d + 1e-3) - 0.1, 0.0) * (1.0 - smoothstep(radius * 0.8, radius * 2.2, d));
        }
        // Faded out far away: depth is too coarse there and the shading turns to blotches on the sea and the haze.
        float ao = 1.0 - clamp(occ * ${(2.2 / AO_SAMPLES).toFixed(4)}, 0.0, 1.0);
        gl_FragColor = vec4(vec3(mix(ao, 1.0, smoothstep(5000.0, 11000.0, z))), 1.0);
      }
    `,
  });
  const tapsMaterial = (weights, extra = '', blend = {}) => new THREE.ShaderMaterial({
    ...flat,
    ...blend,
    uniforms: { tMap: { value: null }, uTexel: { value: new THREE.Vector2() } },
    fragmentShader: /* glsl */ `
      uniform sampler2D tMap;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tMap, vUv).rgb * ${weights[0].toFixed(3)};
        c += texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb * ${weights[1].toFixed(3)};
        c += texture2D(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb * ${weights[1].toFixed(3)};
        c += texture2D(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb * ${weights[1].toFixed(3)};
        c += texture2D(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb * ${weights[1].toFixed(3)};
        ${extra}
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const blurMaterial = tapsMaterial([0, 0.25]); // four bilinear taps: a 4x4 box
  const brightMaterial = tapsMaterial([0, 0.25], /* glsl */ `
    c = min(c, vec3(24.0)); // keeps a stray huge pixel from flooding the frame
    float l = max(c.r, max(c.g, c.b));
    c *= max(l - ${THRESHOLD.toFixed(2)}, 0.0) / max(l, 1e-4);
  `);
  const downMaterial = tapsMaterial([0.5, 0.125]);
  // Adds the next smaller level on top of this one.
  const upMaterial = tapsMaterial([0, 0.25], '', { blending: THREE.AdditiveBlending, transparent: true });

  const finalMaterial = new THREE.ShaderMaterial({
    ...flat,
    uniforms: {
      tScene: { value: null }, tBloom: { value: null }, tAO: { value: null },
      uStrength: { value: 0 }, uAO: { value: 0.85 }, uPixel: { value: new THREE.Vector2() }, uClock: { value: 0 },
    },
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene;
      uniform sampler2D tBloom;
      uniform sampler2D tAO;
      uniform float uStrength;
      uniform float uAO;
      uniform vec2 uPixel;
      uniform float uClock;
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
        c *= mix(1.0, texture2D(tAO, vUv).r, uAO);
        c += texture2D(tBloom, vUv).rgb * uStrength;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>

        // Grade, on the tone-mapped image: a touch more contrast and colour, shadows pulled cool and highlights
        // warm, the corners a little darker. These are the habits of a camera, and their absence reads as CG.
        vec3 g = gl_FragColor.rgb;
        float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
        g = mix(vec3(l), g, 1.06);
        g = mix(g, g * g * (3.0 - 2.0 * g), 0.22);
        g *= mix(vec3(0.96, 0.99, 1.05), vec3(1.04, 1.0, 0.95), smoothstep(0.0, 0.65, l));
        g *= mix(0.80, 1.0, 1.0 - smoothstep(0.38, 1.05, length((vUv - 0.5) * vec2(1.0, 0.82))));
        gl_FragColor.rgb = max(g, 0.0);
        #include <colorspace_fragment>
        float grain = fract(sin(dot(gl_FragCoord.xy + uClock * 61.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        gl_FragColor.rgb += grain * 0.014;
      }
    `,
  });

  const fsScene = new THREE.Scene();
  const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  quad.frustumCulled = false;
  fsScene.add(quad);
  function draw(material, target, clear = true) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.autoClear = clear;
    renderer.render(fsScene, fsCamera);
  }
  function pass(material, target, source, clear = true) {
    material.uniforms.tMap.value = source.texture;
    material.uniforms.uTexel.value.set(0.5 / source.width, 0.5 / source.height);
    draw(material, target, clear);
  }

  function allocate() {
    const w = Math.max(2, Math.round(size.width * size.dpr)), h = Math.max(2, Math.round(size.height * size.dpr));
    const key = `${w}x${h}`;
    if (key === allocated) return;
    allocated = key;
    for (const t of [sceneRT, aoRT, aoBlurRT, ...mips]) if (t) t.dispose();
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
    sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture });
    const half = { depthBuffer: false };
    // Quarter size: the shading is soft by nature, and at half size it cost about 4 ms a frame at 1080p.
    aoRT = new THREE.WebGLRenderTarget(Math.max(2, w >> 2), Math.max(2, h >> 2), half);
    aoBlurRT = new THREE.WebGLRenderTarget(Math.max(2, w >> 2), Math.max(2, h >> 2), half);
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
    /**
     * @param {{ exposure: number, bloom: number }} env
     * @param {boolean} full true for the whole pipeline (High), false to render straight to the canvas (Low)
     * @param {number} dt seconds, for the grain
     */
    render(env, full, dt = 0) {
      renderer.toneMappingExposure = env.exposure;
      if (!full) {
        renderer.setRenderTarget(null);
        renderer.autoClear = true;
        renderer.render(scene, camera);
        return;
      }
      allocate();
      renderer.setRenderTarget(sceneRT);
      renderer.autoClear = true;
      renderer.render(scene, camera);

      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const u = aoMaterial.uniforms;
      u.tDepth.value = sceneRT.depthTexture;
      u.uPixel.value.set(2 / sceneRT.width, 2 / sceneRT.height); // neighbours two pixels away: steadier normals at this size
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uProj.value.set(tan * camera.aspect, tan);
      draw(aoMaterial, aoRT);
      pass(blurMaterial, aoBlurRT, aoRT);

      const bloom = env.bloom > 0.01;
      if (bloom) {
        pass(brightMaterial, mips[0], sceneRT);
        for (let i = 1; i < LEVELS; i++) pass(downMaterial, mips[i], mips[i - 1]);
        for (let i = LEVELS - 2; i >= 0; i--) pass(upMaterial, mips[i], mips[i + 1], false);
      }

      const f = finalMaterial.uniforms;
      f.tScene.value = sceneRT.texture;
      f.tBloom.value = mips[0].texture;
      f.tAO.value = aoBlurRT.texture;
      f.uPixel.value.set(1 / sceneRT.width, 1 / sceneRT.height);
      f.uStrength.value = bloom ? env.bloom * 0.6 : 0; // five summed levels, see timeOfDay.js for env.bloom
      f.uClock.value = (clock = (clock + dt) % 10);
      draw(finalMaterial, null);
    },
  };
}
