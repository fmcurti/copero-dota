import { useEffect, useRef, useState, type ReactNode } from "react";
import { createHookAudio } from "./hookAudio";

// ---------------------------------------------------------------------------
// The Pudge-hook modal shell. A meat hook on a chain is thrown from off-screen,
// snags a rusty plate below the viewport, and drags it to center; on close the
// hook either lets the plate drop away (release) or yanks it clean off-screen
// (yank). The canvas owns everything painterly (chain, hook, sparks, shake) and
// ignores the pointer; the plate is real DOM so whatever it holds — a
// confirmation or a whole form — stays focusable and screen-reader sane.
//
// The shell is content-agnostic: callers render into it and drive it through
// the `HookController` handed to their render function. Once landed the plate
// keeps a slow perpetual hang — it never freezes — because a plate on a chain
// is never truly still. `flakes` toggles the idle rust shedding (off for the
// sign-in form, on for the sign-out plate). prefers-reduced-motion parks the
// plate instantly with a static chain.
// ---------------------------------------------------------------------------

const ATTACH = 14; // px between the plate's top edge and the eyelet center it hangs from
const HOOK_SCALE = 1.25;
const THROW_T = 0.3; // hook flight time
const RETRACT_T = 0.26; // the plate's drop-away on release
const YANK_T = 0.32;
const SPRING_K = 78; // attach-point spring toward home (1/s²) — snappier settle
const SPRING_C = 9; // its damping (1/s) — under-damped for one overshoot
const PEND_L = 150; // visual pendulum length of the hanging plate (px)
const PEND_C = 2.1;
const GRAV = 2600; // px/s²

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.14'/%3E%3C/svg%3E\")";

// --------------------------------- math ------------------------------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOutQuad = (u: number) => 1 - (1 - u) * (1 - u);
const easeInQuad = (u: number) => u * u;
const easeInCubic = (u: number) => u * u * u;
const rot = (x: number, y: number, a: number) => ({
  x: x * Math.cos(a) - y * Math.sin(a),
  y: x * Math.sin(a) + y * Math.cos(a),
});
const qBezier = (p0: Pt, c: Pt, p1: Pt, u: number): Pt => {
  const v = 1 - u;
  return {
    x: v * v * p0.x + 2 * v * u * c.x + u * u * p1.x,
    y: v * v * p0.y + 2 * v * u * c.y + u * u * p1.y,
  };
};

interface Pt {
  x: number;
  y: number;
}

// ------------------------------ hook geometry ------------------------------

// The hook's spine from chain end, down the shank, around the bend, up to the
// point: [x, y, width]. The fill polygon is the spine offset by its normals.
const SPINE: Array<[number, number, number]> = [
  [0, -2, 7],
  [0.6, 12, 8],
  [1, 26, 9],
  [1.2, 38, 10.5],
  [-1, 50, 11.5],
  [-7, 60, 11],
  [-16, 64, 10.5],
  [-24, 60, 9.5],
  [-29, 51, 8.5],
  [-30.5, 40, 7],
  [-29, 29, 5.2],
  [-25.5, 20, 3.4],
  [-22, 13, 1.4],
];
// Where the eyelet ring sits inside the hook's cavity, in spine coordinates.
const CAVITY = { x: -15, y: 46 };
const RUST_BLOTCHES = [
  { x: -2, y: 18, r: 5, c: "rgba(128,74,38,0.30)" },
  { x: 2, y: 34, r: 4, c: "rgba(96,52,24,0.28)" },
  { x: -8, y: 56, r: 6, c: "rgba(134,80,40,0.26)" },
  { x: -22, y: 60, r: 5, c: "rgba(90,50,26,0.30)" },
  { x: -28, y: 44, r: 4, c: "rgba(130,72,34,0.24)" },
  { x: -26, y: 30, r: 3, c: "rgba(102,58,30,0.28)" },
  { x: 1, y: 6, r: 3.4, c: "rgba(88,48,22,0.30)" },
];
const CHAIN_SHADES = ["#4a423a", "#514738", "#453c33", "#564a3b"];

function makeHookPath(): Path2D {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < SPINE.length; i++) {
    const [x, y, w] = SPINE[i];
    const [px, py] = SPINE[Math.max(0, i - 1)];
    const [nx, ny] = SPINE[Math.min(SPINE.length - 1, i + 1)];
    const len = Math.hypot(nx - px, ny - py) || 1;
    const norm = { x: -(ny - py) / len, y: (nx - px) / len };
    left.push({ x: x + (norm.x * w) / 2, y: y + (norm.y * w) / 2 });
    right.push({ x: x - (norm.x * w) / 2, y: y - (norm.y * w) / 2 });
  }
  const path = new Path2D();
  path.moveTo(right[0].x, right[0].y);
  for (const p of right) path.lineTo(p.x, p.y);
  for (let i = left.length - 1; i >= 0; i--) path.lineTo(left[i].x, left[i].y);
  path.closePath();
  // the barb near the point
  path.moveTo(-33, 38);
  path.lineTo(-38.5, 29.5);
  path.lineTo(-29.5, 31);
  path.closePath();
  return path;
}

/** Draw the hook with its chain ring at (ox, oy); returns the chain endpoint. */
function drawHookAt(
  ctx: CanvasRenderingContext2D,
  hookPath: Path2D,
  ox: number,
  oy: number,
  angle: number,
): Pt {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.rotate(angle);
  ctx.scale(HOOK_SCALE, HOOK_SCALE);

  const fill = ctx.createLinearGradient(-34, 8, 10, 64);
  fill.addColorStop(0, "#6e655b");
  fill.addColorStop(0.35, "#4a4239");
  fill.addColorStop(0.62, "#5a4c3e");
  fill.addColorStop(1, "#26211c");
  ctx.fillStyle = fill;
  ctx.fill(hookPath);

  ctx.save();
  ctx.clip(hookPath);
  for (const blotch of RUST_BLOTCHES) {
    ctx.fillStyle = blotch.c;
    ctx.beginPath();
    ctx.ellipse(blotch.x, blotch.y, blotch.r * 1.3, blotch.r, 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(226,214,192,0.16)";
  ctx.lineWidth = 1.2;
  ctx.stroke(hookPath);
  ctx.strokeStyle = "rgba(233,225,205,0.25)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(5.2, 2);
  ctx.lineTo(6.4, 34);
  ctx.stroke();

  // chain ring
  ctx.strokeStyle = "#4d443c";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, -7, 5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
  const ring = rot(0, -10 * HOOK_SCALE, angle);
  return { x: ox + ring.x, y: oy + ring.y };
}

/** Hook origin such that its cavity wraps the eyelet at (ex, ey). */
function originFromEyelet(ex: number, ey: number, angle: number): Pt {
  const c = rot(CAVITY.x * HOOK_SCALE, CAVITY.y * HOOK_SCALE, angle);
  return { x: ex - c.x, y: ey - c.y };
}

function drawChain(
  ctx: CanvasRenderingContext2D,
  from: Pt,
  to: Pt,
  sag: number,
  ripple: number,
  time: number,
) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 2) return;
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + sag };
  const links = Math.max(2, Math.ceil(dist / 13));
  for (let i = 0; i <= links; i++) {
    const u = i / links;
    const p = qBezier(from, mid, to, u);
    if (ripple > 0) {
      const wave = Math.sin(u * 34 - time * 30) * ripple * u * (1 - u) * 4;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      p.x += (-dy / dist) * wave;
      p.y += (dx / dist) * wave;
    }
    const ahead = qBezier(from, mid, to, Math.min(1, u + 0.02));
    const angle = Math.atan2(ahead.y - p.y, ahead.x - p.x);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(angle);
    const shade = CHAIN_SHADES[i % CHAIN_SHADES.length];
    if (i % 2 === 0) {
      ctx.strokeStyle = shade;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.4, 4.1, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(214,201,178,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(-0.5, -0.6, 6.4, 4.1, 0, Math.PI * 0.9, Math.PI * 1.7);
      ctx.stroke();
    } else {
      ctx.fillStyle = shade;
      ctx.fillRect(-5.5, -1.8, 11, 3.6);
      ctx.fillStyle = "rgba(214,201,178,0.14)";
      ctx.fillRect(-5.5, -1.8, 11, 1.1);
    }
    ctx.restore();
  }
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  kind: "spark" | "rust";
}

// ------------------------------- component ---------------------------------

type Phase = "throw" | "drag" | "hang" | "release" | "confirm";

/** What the shell hands its content: readiness plus the two ways to leave. */
export interface HookController {
  /** The plate has landed and settled — safe to enable primary actions. */
  armed: boolean;
  /** The hook lets go; the plate drops away, then the modal closes. */
  close: () => void;
  /** The hook yanks the plate off-screen; `until` (if given) is awaited before
   *  the modal actually closes, so async work can finish under the animation. */
  yank: (until?: Promise<unknown>) => void;
}

export interface HookHandle {
  close: () => void;
  yank: (until?: Promise<unknown>) => void;
}

export default function HookModal({
  onClose,
  ariaLabelledBy,
  sound = true,
  flakes = true,
  contentClassName = "px-6 pb-6 pt-8",
  handleRef,
  children,
}: {
  onClose: () => void;
  ariaLabelledBy: string;
  sound?: boolean;
  flakes?: boolean;
  contentClassName?: string;
  handleRef?: React.MutableRefObject<HookHandle | null>;
  children: (ctrl: HookController) => ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<HookHandle | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const flakesRef = useRef(flakes);
  flakesRef.current = flakes;
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const backdrop = backdropRef.current;
    const wrap = wrapRef.current;
    const plate = plateRef.current;
    const canvas = canvasRef.current;
    if (!backdrop || !wrap || !plate || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const audio = reduced || !sound ? null : createHookAudio();
    const hookPath = makeHookPath();
    const opened = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const state = {
      phase: (reduced ? "hang" : "throw") as Phase,
      t: reduced ? 0 : -0.05, // brief hold so the backdrop reads before the throw
      elapsed: 0,
      s: { x: 0, y: 0, vx: 0, vy: 0 }, // the eyelet (attach point) the plate hangs from
      th: 0, // plate swing angle
      w: 0, // its angular velocity
      shake: 0,
      flakeIn: 1.4,
      releaseFrom: null as Pt | null,
      yankFrom: null as Pt | null,
      until: null as Promise<unknown> | null,
      finishing: false,
      closed: false,
      raf: 0,
      fadeTimer: 0,
      armedSent: false,
    };
    const particles: Particle[] = [];
    const impacts: Array<{ x: number; y: number; age: number }> = [];

    const fadeOut = () => {
      if (state.closed) return;
      state.closed = true;
      backdrop.style.opacity = "0";
      wrap.style.opacity = "0";
      state.fadeTimer = window.setTimeout(() => onCloseRef.current(), reduced ? 40 : 320);
    };

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    };

    const spawnSparks = (x: number, y: number) => {
      for (let i = 0; i < 34; i++) {
        const angle = -Math.PI * (0.15 + Math.random() * 0.7); // up-ish fan
        const speed = 220 + Math.random() * 780;
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          ttl: 0.25 + Math.random() * 0.4,
          kind: "spark",
        });
      }
      for (let i = 0; i < 8; i++) {
        particles.push({
          x: x + (Math.random() - 0.5) * 20,
          y: y + (Math.random() - 0.5) * 10,
          vx: (Math.random() - 0.5) * 260,
          vy: -Math.random() * 320,
          life: 0,
          ttl: 0.7 + Math.random() * 0.8,
          kind: "rust",
        });
      }
      impacts.push({ x, y, age: 0 });
    };

    const spawnFlake = (x: number, y: number) => {
      particles.push({
        x: x + (Math.random() - 0.5) * 10,
        y: y + Math.random() * 6,
        vx: (Math.random() - 0.5) * 30,
        vy: 20 + Math.random() * 50,
        life: 0,
        ttl: 0.9 + Math.random() * 0.7,
        kind: "rust",
      });
    };

    const arm = () => {
      if (state.armedSent) return;
      state.armedSent = true;
      setArmed(true);
    };

    const engine: HookHandle = {
      close: () => {
        if (state.closed || state.phase === "confirm" || state.phase === "release") return;
        if (reduced || state.phase !== "hang") {
          // hook still flying (or motion off): no theatrics, just leave
          fadeOut();
          return;
        }
        state.phase = "release";
        state.t = 0;
        state.releaseFrom = { x: state.s.x, y: state.s.y };
        state.s.vy = Math.max(state.s.vy, 0) + 220;
        state.w += (Math.random() - 0.5) * 1.6;
        audio?.release();
      },
      yank: (until) => {
        if (state.closed || state.phase === "confirm" || state.phase === "release") return;
        state.until = until ?? Promise.resolve();
        if (reduced || state.phase !== "hang") {
          void state.until.then(fadeOut);
          return;
        }
        state.phase = "confirm";
        state.t = 0;
        state.yankFrom = { x: state.s.x, y: state.s.y };
        audio?.yank();
      },
    };
    engineRef.current = engine;
    if (handleRef) handleRef.current = engine;

    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      state.elapsed += dt;
      const { w: W, h: H } = size();
      const plateH = plate.offsetHeight;

      const anchor = { x: W * 0.86, y: -60 };
      const park = { x: W / 2 + 10, y: H + 40 };
      const home = {
        x: W / 2,
        y: Math.max(60, H * 0.45 - plateH / 2 - ATTACH),
      };

      // ------------------------------------------------------- simulate
      if (reduced) {
        state.s.x = home.x;
        state.s.y = home.y;
        state.th = 0;
        arm();
      } else if (state.phase === "throw") {
        state.t += dt;
        state.s.x = park.x;
        state.s.y = park.y;
        if (state.t >= THROW_T) {
          state.phase = "drag";
          state.t = 0;
          state.s.vx = 0;
          state.s.vy = -2300;
          state.th = (Math.random() - 0.5) * 0.24;
          state.w = (Math.random() - 0.5) * 2.4;
          if (!state.closed) {
            audio?.impact();
            state.shake = 1;
            spawnSparks(park.x, Math.min(park.y, H - 6));
          }
        } else if (state.t >= 0 && state.t - dt < 0 && !state.closed) {
          audio?.throwWhoosh();
        }
      } else if (state.phase === "drag" || state.phase === "hang") {
        state.t += dt;
        // Once landed the plate keeps a slow perpetual hang: the eyelet drifts
        // on two out-of-phase sines and the damped pendulum answers, so it
        // breathes forever instead of freezing.
        const target =
          state.phase === "hang"
            ? {
                x: home.x + Math.sin(state.elapsed * 1.7) * 2.2,
                y: home.y + Math.sin(state.elapsed * 2.3 + 1) * 1.6,
              }
            : home;
        for (let i = 0; i < 2; i++) {
          const h = dt / 2;
          const ax = SPRING_K * (target.x - state.s.x) - SPRING_C * state.s.vx;
          const ay = SPRING_K * (target.y - state.s.y) - SPRING_C * state.s.vy;
          state.s.vx += ax * h;
          state.s.vy += ay * h;
          state.s.x += state.s.vx * h;
          state.s.y += state.s.vy * h;
          const aw =
            (-GRAV * Math.sin(state.th) - ax * Math.cos(state.th)) / PEND_L - PEND_C * state.w;
          state.w += aw * h;
          state.th += state.w * h;
        }
        if (state.phase === "drag") {
          const speed = Math.hypot(state.s.vx, state.s.vy);
          const off = Math.hypot(home.x - state.s.x, home.y - state.s.y);
          if ((state.t > 0.32 && speed < 70 && off < 12) || state.t > 1.0) {
            state.phase = "hang";
            audio?.retractStop();
            arm();
          }
        } else if (flakesRef.current) {
          state.flakeIn -= dt;
          if (state.flakeIn <= 0) {
            state.flakeIn = 1.2 + Math.random() * 1.4;
            spawnFlake(state.s.x, state.s.y);
          }
        }
      } else if (state.phase === "release") {
        state.t += dt;
        state.s.vy += GRAV * 1.7 * dt;
        state.s.x += state.s.vx * dt;
        state.s.y += state.s.vy * dt;
        state.th += state.w * dt;
        if (state.s.y + ATTACH > H + plateH + 80 && !state.closed) fadeOut();
      } else if (state.phase === "confirm") {
        state.t += dt;
        const u = easeInQuad(clamp01(state.t / YANK_T));
        const from = state.yankFrom!;
        const prevX = state.s.x;
        const prevY = state.s.y;
        state.s.x = from.x + (anchor.x - from.x) * u;
        state.s.y = from.y + (anchor.y - 120 - from.y) * u;
        const vx = state.s.x - prevX;
        const vy = state.s.y - prevY;
        const speed = Math.hypot(vx, vy);
        if (speed > 1) {
          const trail = Math.atan2(vx / speed, -vy / speed);
          const blend = 1 - Math.exp(-8 * dt);
          state.th += (trail - state.th) * blend;
        }
        if (state.t >= YANK_T && !state.finishing) {
          state.finishing = true;
          void state.until!.then(fadeOut);
        }
      }
      // Decay the shake, then kill it outright so the settled plate is exactly
      // still (no eternal sub-pixel jitter under a form's caret).
      state.shake = state.shake < 0.015 ? 0 : state.shake * Math.exp(-6.5 * dt);

      // --------------------------------------------------------- place DOM
      const sx = (Math.random() - 0.5) * 20 * state.shake;
      const sy = (Math.random() - 0.5) * 20 * state.shake;
      wrap.style.transform = `translate3d(${state.s.x + sx}px, ${state.s.y + sy}px, 0)`;
      plate.style.transform = `translate(-50%, ${ATTACH}px) rotate(${state.th}rad)`;

      // ------------------------------------------------------------- paint
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(sx, sy);

      if (reduced || state.phase === "drag" || state.phase === "hang") {
        const eye = { x: state.s.x, y: state.s.y };
        const origin = originFromEyelet(eye.x, eye.y, state.th);
        const chainEnd = drawHookAt(ctx, hookPath, origin.x, origin.y, state.th);
        drawChain(ctx, anchor, chainEnd, state.phase === "drag" ? 6 : 14, 0, state.elapsed);
      } else if (state.phase === "throw" && state.t >= 0) {
        const u = easeOutQuad(clamp01(state.t / THROW_T));
        const targetOrigin = originFromEyelet(park.x, park.y, 0);
        const dx = targetOrigin.x - anchor.x;
        const dy = targetOrigin.y - anchor.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ctrl = {
          x: (anchor.x + targetOrigin.x) / 2 + (dy / dist) * 110,
          y: (anchor.y + targetOrigin.y) / 2 - (dx / dist) * 110,
        };
        const pos = qBezier(anchor, ctrl, targetOrigin, u);
        const spin = u * Math.PI * 4;
        const chainEnd = drawHookAt(ctx, hookPath, pos.x, pos.y, spin);
        drawChain(ctx, anchor, chainEnd, 4, 1 - u, state.elapsed);
      } else if (state.phase === "release") {
        const u = easeInCubic(clamp01(state.t / RETRACT_T));
        if (u < 1) {
          const from = originFromEyelet(state.releaseFrom!.x, state.releaseFrom!.y, 0);
          const pos = {
            x: from.x + (anchor.x - from.x) * u,
            y: from.y + (anchor.y - from.y) * u,
          };
          const chainEnd = drawHookAt(ctx, hookPath, pos.x, pos.y, -u * 2.4);
          drawChain(ctx, anchor, chainEnd, 10 * (1 - u), u * 0.6, state.elapsed);
        }
      } else if (state.phase === "confirm") {
        const origin = originFromEyelet(state.s.x, state.s.y, state.th);
        const chainEnd = drawHookAt(ctx, hookPath, origin.x, origin.y, state.th);
        drawChain(ctx, anchor, chainEnd, 4, 0.4, state.elapsed);
      }

      // particles + impact rings
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life >= p.ttl) {
          particles.splice(i, 1);
          continue;
        }
        p.vy += (p.kind === "spark" ? 1800 : 1400) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const fade = 1 - p.life / p.ttl;
        if (p.kind === "spark") {
          ctx.globalCompositeOperation = "lighter";
          ctx.strokeStyle = `rgba(255,${170 + Math.floor(60 * fade)},70,${0.9 * fade})`;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.018, p.y - p.vy * 0.018);
          ctx.stroke();
          ctx.globalCompositeOperation = "source-over";
        } else {
          ctx.fillStyle = `rgba(110,74,42,${0.8 * fade})`;
          ctx.fillRect(p.x, p.y, 2.5, 2.5);
        }
      }
      for (let i = impacts.length - 1; i >= 0; i--) {
        const ring = impacts[i];
        ring.age += dt;
        if (ring.age > 0.22) {
          impacts.splice(i, 1);
          continue;
        }
        const u = ring.age / 0.22;
        ctx.strokeStyle = `rgba(255,210,150,${0.5 * (1 - u)})`;
        ctx.lineWidth = 2.5 * (1 - u) + 0.5;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, 12 + u * 70, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
      state.raf = requestAnimationFrame(frame);
    };

    // fade the backdrop in, then let it fly
    requestAnimationFrame(() => {
      backdrop.style.opacity = "1";
    });
    state.raf = requestAnimationFrame((now) => {
      last = now;
      frame(now);
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        engineRef.current?.close();
      } else if (event.key === "Tab") {
        const stops = Array.from(
          plate.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null);
        if (!stops.length) {
          event.preventDefault();
          return;
        }
        const idx = stops.indexOf(document.activeElement as HTMLElement);
        // Let Tab move naturally between the stops; only wrap at the ends.
        if (event.shiftKey && idx <= 0) {
          event.preventDefault();
          stops[stops.length - 1].focus();
        } else if (!event.shiftKey && idx === stops.length - 1) {
          event.preventDefault();
          stops[0].focus();
        } else if (idx === -1) {
          event.preventDefault();
          stops[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      cancelAnimationFrame(state.raf);
      clearTimeout(state.fadeTimer);
      window.removeEventListener("keydown", onKey, true);
      audio?.dispose();
      engineRef.current = null;
      if (handleRef) handleRef.current = null;
      opened?.focus();
    };
    // The engine builds once per mount; live values flow through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const controller: HookController = {
    armed,
    close: () => engineRef.current?.close(),
    yank: (until) => engineRef.current?.yank(until),
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={ariaLabelledBy} className="fixed inset-0 z-[70]">
      <div
        ref={backdropRef}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) engineRef.current?.close();
        }}
        className="absolute inset-0 opacity-0 transition-opacity duration-300"
        style={{
          background: "radial-gradient(130% 100% at 50% 0%, rgba(46,12,6,0.5), rgba(0,0,0,0.85) 70%)",
        }}
      />

      <div
        ref={wrapRef}
        className="absolute left-0 top-0 z-[71] will-change-transform"
        style={{ transform: "translate3d(-9999px, 0, 0)", transition: "opacity 0.3s ease" }}
      >
        <div
          ref={plateRef}
          className="relative w-[min(400px,calc(100vw-2.5rem))]"
          style={{
            transform: `translate(-50%, ${ATTACH}px)`,
            transformOrigin: `50% ${-ATTACH}px`,
            filter: "drop-shadow(0 26px 44px rgba(0,0,0,0.65))",
          }}
        >
          {/* the eyelet the hook grabs */}
          <div
            aria-hidden
            className="absolute left-1/2 h-[26px] w-[26px] -translate-x-1/2"
            style={{
              top: -(ATTACH + 13),
              background:
                "radial-gradient(circle, transparent 5.5px, #6b6156 6px 8.5px, #3a342d 9px 12.5px, transparent 13px)",
            }}
          />
          {/* the plate itself: forged charcoal eaten by rust */}
          <div
            className={`relative max-h-[calc(100dvh-6rem)] overflow-y-auto ${contentClassName}`}
            style={{
              clipPath:
                "polygon(0 14px, 12px 0, calc(100% - 16px) 0, 100% 10px, 100% calc(100% - 12px), calc(100% - 10px) 100%, 14px 100%, 0 calc(100% - 16px))",
              background: [
                "radial-gradient(130% 90% at 20% 6%, rgba(255,255,255,0.09), transparent 42%)",
                "radial-gradient(90% 70% at 88% 96%, rgba(124,62,30,0.5), transparent 62%)",
                "radial-gradient(55% 42% at 6% 82%, rgba(112,56,26,0.42), transparent 70%)",
                "radial-gradient(38% 30% at 78% 10%, rgba(96,50,24,0.36), transparent 72%)",
                GRAIN,
                "linear-gradient(168deg, #3e3a35 0%, #2c2925 46%, #1e1b18 100%)",
              ].join(","),
              boxShadow:
                "inset 0 1px 0 rgba(233,229,218,0.1), inset 0 -16px 34px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(20,16,11,0.9)",
            }}
          >
            {[
              { left: 13, top: 15 },
              { right: 17, top: 13 },
              { left: 15, bottom: 17 },
              { right: 13, bottom: 15 },
            ].map((pos, i) => (
              <div
                key={i}
                aria-hidden
                className="absolute h-3 w-3 rounded-full"
                style={{
                  ...pos,
                  // A forged rivet: a bright specular hotspot on a metal dome,
                  // seated in a dark recess with a cast shadow below.
                  background: [
                    "radial-gradient(circle at 33% 27%, rgba(255,251,242,0.95) 0%, rgba(214,204,188,0.45) 13%, transparent 30%)",
                    "radial-gradient(circle at 40% 36%, #b3a996 0%, #7d7264 38%, #443d34 74%, #221d18 100%)",
                  ].join(","),
                  boxShadow: [
                    "inset 0 1px 1px rgba(255,248,235,0.4)",
                    "inset 0 -1.5px 2.5px rgba(0,0,0,0.65)",
                    "0 0 0 1px rgba(18,14,10,0.75)",
                    "0 1.5px 2.5px rgba(0,0,0,0.6)",
                  ].join(","),
                }}
              />
            ))}
            <div
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                left: "12%",
                top: "34%",
                width: "38%",
                height: 1,
                transform: "rotate(-7deg)",
                background: "linear-gradient(90deg, transparent, rgba(224,212,190,0.16), transparent)",
              }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                right: "10%",
                bottom: "26%",
                width: "30%",
                height: 1,
                transform: "rotate(4deg)",
                background: "linear-gradient(90deg, transparent, rgba(0,0,0,0.55), transparent)",
              }}
            />

            {children(controller)}
          </div>
        </div>
      </div>

      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[72] h-full w-full" />
    </div>
  );
}
