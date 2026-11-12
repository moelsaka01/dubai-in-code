// Final image: ACES tone mapping with exposure from the environment, and bloom when it is worth its cost.
// With bloom on, the scene renders into a float target (4x MSAA), UnrealBloomPass works at half resolution,
// and OutputPass applies tone mapping and sRGB. With bloom off, the scene renders straight to the canvas
// and every material tone-maps itself (the OUTPUT chunk), which is the cheap path used by Low quality.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 1.0; // scene-linear luminance; only the brightest windows, lamps and glints pass
// UnrealBloomPass adds its five blurred mips with weights that sum to about 3, so env.bloom stays well below 1.

export function createPost(renderer, scene, camera) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  let composer = null, bloom = null;
  let size = { width: 1, height: 1, dpr: 1 };

  function ensureComposer() {
    if (composer) return;
    const target = new THREE.WebGLRenderTarget(size.width * size.dpr, size.height * size.dpr, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), 0, BLOOM_RADIUS, BLOOM_THRESHOLD);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    composer.setPixelRatio(size.dpr);
    composer.setSize(size.width, size.height);
  }

  return {
    setSize(width, height, dpr) {
      size = { width, height, dpr };
      if (composer) {
        composer.setPixelRatio(dpr);
        composer.setSize(width, height);
      }
    },
    /** @param {{ exposure: number, bloom: number }} env  @param {boolean} allowBloom from the quality setting */
    render(env, allowBloom) {
      renderer.toneMappingExposure = env.exposure;
      if (allowBloom && env.bloom > 0.01) {
        ensureComposer();
        bloom.strength = env.bloom;
        composer.render();
      } else {
        renderer.render(scene, camera);
      }
    },
  };
}
