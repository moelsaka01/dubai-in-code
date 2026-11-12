// High thin cloud, kept in a small texture so the sky, the glass towers and the landmarks can all look it up
// with one fetch. Computing the noise per pixel in every reflection cost several milliseconds a frame.
// The texture is a flat map of the cloud layer overhead: a direction d lands at d.xz / (d.y + 0.12).
import * as THREE from 'three';

const SIZE = 512;
export const CLOUD_SPAN = 24; // the map covers +-12 units of the flattened layer

export function createClouds(renderer, env) {
  const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthBuffer: false });
  target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
  env.uniforms.uCloudMap.value = target.texture;

  const material = new THREE.ShaderMaterial({
    uniforms: { uDrift: { value: 0 } },
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uDrift;
      varying vec2 vUv;
      float hash21(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        vec2 cp = (vUv - 0.5) * ${CLOUD_SPAN.toFixed(1)} + vec2(uDrift, 0.0);
        // Stretched along one axis: streaks, like cirrus.
        float c = vnoise(cp * vec2(1.0, 2.6)) * 0.55 + vnoise(cp * vec2(2.9, 6.5) + 9.0) * 0.30 + vnoise(cp * vec2(6.1, 13.0) + 3.0) * 0.15;
        gl_FragColor = vec4(vec3(smoothstep(0.50, 0.80, c)), 1.0);
      }
    `,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  let tick = 0;
  return {
    /** Redraw the layer now and then: it only drifts. */
    update() {
      if (tick++ % 20) return;
      material.uniforms.uDrift.value = env.uniforms.uTime.value * 0.004;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prev);
    },
  };
}
