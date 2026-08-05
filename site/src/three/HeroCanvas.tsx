import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer
} from 'three';

const VERTEX = /* glsl */ `
  void main() { gl_Position = vec4(position, 1.0); }
`;

/*
 * Domain-warped value noise, tinted between the application's two indigos.
 *
 * Warping the sample position by another octave of the same noise is what
 * stops it reading as static fog: the field folds over itself and the shapes
 * drift and stretch rather than just fading up and down. Alpha, not colour,
 * carries the fade to nothing at the edges, so the page's own white shows
 * through and the canvas can sit under the headline without a seam.
 */
const FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec2  uResolution;
  uniform float uTime;
  uniform vec2  uPointer;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i),                hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0,1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise(p);
      p *= 2.02;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    // Square-aspect coordinates, so the shapes do not stretch with the window.
    vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

    float t = uTime * 0.085;
    vec2 warp = vec2(
      fbm(p * 1.35 + vec2(t, -t * 0.8)),
      fbm(p * 1.35 + vec2(4.7 - t * 0.6, 2.3 + t))
    );

    // The pointer nudges where the field is sampled rather than moving a
    // shape, so it reads as the whole surface leaning rather than a blob
    // chasing the cursor.
    float n = fbm(p * 1.75 + warp * 1.25 + uPointer * 0.34);

    vec3 pale   = vec3(0.647, 0.706, 0.988);
    vec3 indigo = vec3(0.357, 0.325, 0.878);
    vec3 deep   = vec3(0.263, 0.220, 0.792);
    vec3 colour = mix(pale, indigo, smoothstep(0.26, 0.72, n));
    colour = mix(colour, deep, smoothstep(0.62, 0.88, n));

    /*
     * A bright seam where the field crosses its own midpoint.
     *
     * Without it the whole thing is one soft ramp and reads as a blur rather
     * than as anything with structure. This picks out the contour lines of
     * the noise, which is what gives it the sense of something folding.
     */
    float seam = smoothstep(0.055, 0.0, abs(n - 0.52));
    colour = mix(colour, vec3(1.0), seam * 0.35);

    float alpha = smoothstep(0.26, 0.66, n) * 0.72 + seam * 0.12;
    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/** Retina is wasted on a field this soft, and it costs four times the pixels. */
const MAX_PIXEL_RATIO = 1.5;

function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    return false;
  }
}

/*
 * The shader behind the headline.
 *
 * It renders nothing and costs nothing when the reader has asked for reduced
 * motion, or when WebGL is unavailable — the stylesheet's still gradient is
 * underneath either way, so the hero is never left empty.
 */
export function HeroCanvas() {
  const holder = useRef<HTMLDivElement>(null);
  const calm = useReducedMotion();
  const live = !calm && webglAvailable();

  useEffect(() => {
    const mount = holder.current;
    if (!live || !mount) return;

    const renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
    renderer.setClearAlpha(0);
    mount.appendChild(renderer.domElement);

    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const uniforms = {
      uResolution: { value: new Vector2(1, 1) },
      uTime: { value: 0 },
      uPointer: { value: new Vector2(0, 0) }
    };
    const geometry = new PlaneGeometry(2, 2);
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    scene.add(new Mesh(geometry, material));

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      if (!clientWidth || !clientHeight) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
      renderer.setSize(clientWidth, clientHeight, false);
      const ratio = renderer.getPixelRatio();
      uniforms.uResolution.value.set(clientWidth * ratio, clientHeight * ratio);
    };
    resize();

    const sizeWatcher = new ResizeObserver(resize);
    sizeWatcher.observe(mount);

    /* Pointer position as -1..1 from the centre of the hero. */
    const target = new Vector2(0, 0);
    const onPointerMove = (event: PointerEvent) => {
      const box = mount.getBoundingClientRect();
      target.set(
        ((event.clientX - box.left) / box.width) * 2 - 1,
        -(((event.clientY - box.top) / box.height) * 2 - 1)
      );
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    /*
     * The loop runs only while the hero is on screen and the tab is in front.
     * A shader animating behind a page the reader has scrolled past — or
     * behind another window entirely — is a fan spinning for nothing.
     */
    let frame = 0;
    let onScreen = true;
    let start = performance.now();
    let elapsed = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      elapsed += (now - start) / 1000;
      start = now;
      uniforms.uTime.value = elapsed;
      // Ease toward the pointer so a fast flick does not snap the field.
      uniforms.uPointer.value.lerp(target, 0.045);
      renderer.render(scene, camera);
    };

    const run = () => {
      if (frame || !onScreen || document.hidden) return;
      start = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const halt = () => {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const visibility = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        onScreen ? run() : halt();
      },
      { threshold: 0 }
    );
    visibility.observe(mount);

    const onTabChange = () => (document.hidden ? halt() : run());
    document.addEventListener('visibilitychange', onTabChange);

    run();

    return () => {
      halt();
      visibility.disconnect();
      sizeWatcher.disconnect();
      document.removeEventListener('visibilitychange', onTabChange);
      window.removeEventListener('pointermove', onPointerMove);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [live]);

  return <div ref={holder} className={live ? 'hero-canvas' : 'hero-canvas hero-canvas--still'} />;
}
