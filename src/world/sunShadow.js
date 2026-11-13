// Crisp sun shadows around the camera: one ordinary shadow map (2048^2, depth only) fitted to the part of
// the city in view, refreshed every fourth frame (a refresh costs several milliseconds on an integrated GPU). The height-map shadows of cityMap.js stay as the far field;
// shaders use this map inside its box and fade to the far field at its edge (sunLight() in the shared chunk).
//
// The light's view is a box along the sun's direction, so a tower kilometres up-sun still lands in the map
// when its shadow falls in view. Only buildings and landmarks are drawn; the ground only receives.
import * as THREE from 'three';

const SIZE = 2048;
const BACK = 9000; // how far up-sun the light camera sits

export function createSunShadow(renderer, env) {
  const depthTexture = new THREE.DepthTexture(SIZE, SIZE);
  depthTexture.compareFunction = THREE.LessEqualCompare; // hardware 2x2 PCF through sampler2DShadow
  depthTexture.minFilter = THREE.LinearFilter;
  depthTexture.magFilter = THREE.LinearFilter;
  const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthTexture });
  env.uniforms.uSunMap.value = depthTexture;
  // Allocate it now. Until a depth texture exists the shadow sampler is bound to a plain texture, and the
  // browser rejects every draw that uses it (INVALID_OPERATION on each frame while the city loads).
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.setRenderTarget(null);

  const light = new THREE.OrthographicCamera(-1, 1, 1, -1, 10, BACK * 2);
  const depthMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1.5,
    polygonOffsetUnits: 2,
    vertexShader: /* glsl */ `
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = modelMatrix * instanceMatrix;
        #endif
        gl_Position = projectionMatrix * viewMatrix * (m * vec4(position, 1.0));
      }
    `,
    fragmentShader: /* glsl */ `
      void main() {
        gl_FragColor = vec4(1.0);
      }
    `,
  });

  const forward = new THREE.Vector3(), focus = new THREE.Vector3(), toLight = new THREE.Vector3();
  const lightSpace = new THREE.Vector3();
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const fake = { position: focus };
  let tick = 0;

  return {
    /** Half-width in metres of the box the map covered at its last refresh: small when the camera is low and close. */
    half: 2600,
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera the viewer
     * @param {THREE.Object3D[]} hide everything that must not cast (ground, water, sky, lights)
     * @param {{ update: Function }} buildings so far tiles can drop to tall-only for this pass
     * @param {THREE.Object3D[]} show objects that exist only to cast shadows (bridge decks); visible for this pass alone
     */
    update(scene, camera, hide, buildings, show = []) {
      if (env.shadow <= 0) {
        env.uniforms.uSunOn.value = 0;
        return;
      }
      if (tick++ % 4) return;

      // What the viewer is looking at: where the view ray meets the ground, kept within reach.
      camera.getWorldDirection(forward);
      const reach = forward.y < -0.02 ? Math.min(camera.position.y / -forward.y, 2800) : 1500;
      focus.copy(camera.position).addScaledVector(forward, reach);
      focus.y = 0;
      const half = Math.min(2600, Math.max(700, reach * 0.9 + 300));
      this.half = half;

      toLight.copy(env.uniforms.uLightDir.value);
      light.left = light.bottom = -half;
      light.right = light.top = half;
      light.updateProjectionMatrix();
      light.up.set(0, 1, 0);
      light.position.copy(focus).addScaledVector(toLight, BACK);
      light.lookAt(focus);
      light.updateMatrixWorld();
      // Move in whole texels, or shadow edges crawl as the camera flies.
      const texel = (2 * half) / SIZE;
      lightSpace.copy(focus).applyMatrix4(light.matrixWorldInverse);
      lightSpace.x = Math.round(lightSpace.x / texel) * texel;
      lightSpace.y = Math.round(lightSpace.y / texel) * texel;
      focus.copy(lightSpace).applyMatrix4(light.matrixWorld);
      light.position.copy(focus).addScaledVector(toLight, BACK);
      light.updateMatrixWorld();

      buildings.update(fake, 1400, 0); // beyond 1.4 km only towers matter, and no roof plant
      const wasVisible = hide.map((o) => o.visible);
      hide.forEach((o) => { o.visible = false; });
      show.forEach((o) => { o.visible = true; });
      const prevTarget = renderer.getRenderTarget();
      scene.overrideMaterial = depthMaterial;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, light);
      scene.overrideMaterial = null;
      renderer.setRenderTarget(prevTarget);
      hide.forEach((o, i) => { o.visible = wasVisible[i]; });
      show.forEach((o) => { o.visible = false; });

      env.uniforms.uSunMatrix.value.multiplyMatrices(bias, light.projectionMatrix).multiply(light.matrixWorldInverse);
      env.uniforms.uSunTexel.value = texel;
      env.uniforms.uSunOn.value = 1;
    },
  };
}
