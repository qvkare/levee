"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { integer, readSecond } from "@/lib/format.ts";
import type { Replay } from "@/lib/proof-model.ts";
import { textWidth, type Weight } from "@/lib/text-width.ts";
import { DISPLAY, TYPE, fluid } from "@/lib/type-scale.ts";
import { Badge, LANE_NAMES, type LaneKey } from "./badge.tsx";
import { LESS_MOTION, useWidth } from "./use-width.ts";

/** Seconds of drawn, untimed fall before detection. No record times it. */
const PRE = 2.4;
/** Seconds the finished line holds before the replay stops. */
const HOLD = 0.5;
/** The left edge of the time axis: the untimed zone runs from here to detection at 0. */
const TMIN = -1.6;

type Layout = "h" | "v";
const LANES: LaneKey[] = ["P", "K", "N", "M"];
/** The colour of each stretch of the route, in order. */
const STRETCH: LaneKey[] = ["P", "K", "K", "K", "N", "M", "M", "K", "P", "P"];

interface Times {
  near: number;
  signed: number;
  sent: number;
  included: number;
}

interface Geo {
  layout: Layout;
  W: number;
  H: number;
  viewport: number;
  tmax: number;
  gap: number;
  pps: number;
  lane: (index: number) => number;
  at: (t: number, lane: number) => [number, number];
  axis: number;
}

function geometry(layout: Layout, W: number, viewport: number, tmax: number): Geo {
  if (layout === "h") {
    const x0 = 214;
    const gap = 56;
    const y0 = 132;
    const pps = (W - 28 - x0) / (tmax - TMIN);
    const lane = (index: number) => y0 + index * gap;
    return { layout, W, H: 388, viewport, tmax, gap, pps, lane, at: (t, index) => [x0 + (t - TMIN) * pps, lane(index)], axis: y0 + 3 * gap + 52 };
  }
  const H = 760;
  const y0 = 26;
  const gap = 44;
  const pps = (H - 24 - y0) / (tmax - TMIN);
  const lane = (index: number) => 22 + index * gap;
  return { layout, W, H, viewport, tmax, gap, pps, lane, at: (t, index) => [lane(index), y0 + (t - TMIN) * pps], axis: 0 };
}

/** The route: down from your position to the keeper, to NEAR, to the MPC network, and back up to the same position. */
function waypoints(times: Times, geo: Geo): Array<{ t: number; lane: number }> {
  const step = geo.gap / geo.pps;
  return [
    { t: TMIN, lane: 0 },
    { t: 0, lane: 0 },
    { t: 0, lane: 1 },
    { t: Math.max(0, times.near - step), lane: 1 },
    { t: times.near, lane: 2 },
    { t: Math.min(times.signed, times.near + step), lane: 3 },
    { t: times.signed, lane: 3 },
    { t: times.signed, lane: 1 },
    { t: times.sent, lane: 1 },
    { t: Math.min(times.included, times.sent + step), lane: 0 },
    { t: times.included, lane: 0 },
  ];
}

function positionAt(route: Array<{ t: number; p: [number, number] }>, t: number): [number, number] {
  const first = route[0] as { t: number; p: [number, number] };
  if (t <= first.t) return first.p;
  for (let index = route.length - 1; index > 0; index -= 1) {
    const a = route[index - 1] as (typeof route)[number];
    const b = route[index] as (typeof route)[number];
    if (t >= a.t && t <= b.t) {
      if (b.t === a.t) return b.p;
      const k = (t - a.t) / (b.t - a.t);
      return [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k];
    }
  }
  return (route[route.length - 1] as (typeof route)[number]).p;
}

type Size = "xs" | "s" | "xxl";

interface SignLine {
  text: string;
  size: Size;
  weight: Weight;
  mono?: boolean;
  /** Line height as a multiple of the size. */
  lh?: number;
}

interface Sign {
  key: string;
  /** Shown from this moment on. */
  from: number;
  /** A moment a click on the sign jumps to, with its name for screen readers. */
  jump?: { t: number; label: string };
  x: number;
  y: number;
  anchor: "start" | "end";
  v: "top" | "mid" | "bottom";
  tone: "amber" | "plain" | "M" | "P";
  px: number;
  py: number;
  lines: SignLine[];
}

const sizeOf = (size: Size, viewport: number) => (size === "xxl" ? fluid(DISPLAY, viewport) : TYPE[size]);

function SignBox({ sign, geo, onJump }: { sign: Sign; geo: Geo; onJump: (t: number) => void }) {
  const sizes = sign.lines.map((line) => sizeOf(line.size, geo.viewport));
  const heights = sign.lines.map((line, index) => (sizes[index] as number) * (line.lh ?? 1.25));
  const inner = Math.max(...sign.lines.map((line, index) => textWidth(line.text, sizes[index] as number, line.weight, line.mono)));
  const width = Math.ceil(inner + sign.px * 2 + 4);
  const height = heights.reduce((total, value) => total + value, 0) + sign.py * 2 - 4;
  const wanted = sign.anchor === "end" ? sign.x - width : sign.x;
  const x = Math.max(2, Math.min(geo.W - width - 2, wanted));
  const y = sign.v === "bottom" ? sign.y - height : sign.v === "mid" ? sign.y - height / 2 : sign.y;
  let cursor = y + sign.py - 2;
  const texts = sign.lines.map((line, index) => {
    const lh = heights[index] as number;
    cursor += lh;
    return (
      <text key={index} x={x + sign.px} y={cursor - lh * 0.22} className={`t-${line.size} w${line.weight / 100}${line.mono ? " mono" : ""}`}>
        {line.text}
      </text>
    );
  });
  const box = (
    <>
      <rect className="sign-box" x={x} y={y} width={width} height={height} rx={8} />
      {texts}
    </>
  );
  if (!sign.jump) {
    return (
      <g className={`sign sign-${sign.tone}`} aria-hidden="true">
        {box}
      </g>
    );
  }
  const jump = sign.jump;
  const keyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onJump(jump.t);
    }
  };
  return (
    <g className={`sign sign-${sign.tone} sign-button`} role="button" tabIndex={0} aria-label={jump.label} onClick={() => onJump(jump.t)} onKeyDown={keyDown}>
      {box}
    </g>
  );
}

const ease = (x: number) => 1 - (1 - x) ** 3;
const secs = (seconds: number) => `${seconds.toFixed(2)} s`;

function Drawing({ replay, times, geo, t, onJump, clip }: { replay: Replay; times: Times; geo: Geo; t: number; onJump: (t: number) => void; clip: string }) {
  const horizontal = geo.layout === "h";
  const end = times.included + HOLD;
  const route = waypoints(times, geo).map((point) => ({ t: point.t, p: geo.at(point.t, point.lane) }));
  // The untimed zone is drawn from TMIN to 0, and the pre-roll from -PRE to 0 is spread across it.
  const drawn = t < 0 ? TMIN + ((t + PRE) / PRE) * (0 - TMIN) : t;
  const head = geo.at(Math.min(drawn, times.included), 0);
  const train = positionAt(route, Math.min(drawn, times.included));
  const before = replay.before;
  const health =
    t >= 0 || !before ? replay.healthBefore : before.counted / (before.counted / before.from + (before.debtAt - before.counted / before.from) * ease(Math.min(1, Math.max(0, (t + PRE) / PRE))));
  const trigger = replay.trigger;
  const below = t >= 0 || (trigger !== null && health < trigger);
  const p0 = geo.at(0, 0);
  const p2 = geo.at(times.near, 2);
  const p3 = geo.at(times.signed, 3);
  const p4 = geo.at(times.sent, 1);
  const p5 = geo.at(times.included, 0);
  const near = `${secs(times.near)} · caps checked`;
  const signed = `${secs(times.signed)} · took ${secs(times.signed - times.near)}`;
  const sentGap = times.sent - times.signed;
  const sentLine = sentGap < 1 ? `${Math.round(sentGap * 1000)} ms later` : `${secs(sentGap)} later`;
  const blockLine = replay.block === null ? "health factor" : `health factor · block ${integer(replay.block)}`;
  const firstLines: SignLine[] = [
    { text: t >= 0 ? "Below trigger" : "Health factor", size: "xs", weight: 700 },
    { text: health.toFixed(2), size: "xxl", weight: 800, lh: 1.02 },
    ...(trigger === null ? [] : [{ text: `Trigger ${trigger.toFixed(2)}`, size: "xs" as const, weight: 600 as const }]),
  ];
  const afterLines: SignLine[] = [
    { text: `Repaid ${replay.amount}`, size: "s", weight: 800 },
    { text: replay.healthAfter.toFixed(2), size: "xxl", weight: 800, lh: 1 },
    { text: horizontal ? blockLine : "health factor", size: "xs", weight: 600 },
  ];
  const firstTone = below ? "amber" : "plain";
  const jumps = {
    before: { t: 0.2, label: "Show the moment health factor was below the trigger" },
    signed: { t: times.signed + 0.002, label: "Show the moment the signature came back" },
    after: { t: end, label: "Show the repaid position" },
  };
  const signs: Sign[] = horizontal
    ? [
        { key: "first", from: -Infinity, jump: jumps.before, x: p0[0] + 8, y: p0[1] - 20, anchor: "end", v: "bottom", tone: firstTone, px: 14, py: 11, lines: firstLines },
        { key: "near", from: times.near, x: p2[0] + 16, y: (geo.lane(1) + geo.lane(2)) / 2, anchor: "start", v: "mid", tone: "plain", px: 12, py: 10, lines: [{ text: "Rescue call on NEAR", size: "s", weight: 800 }, { text: near, size: "xs", weight: 600, mono: true }] },
        { key: "signed", from: times.signed, jump: jumps.signed, x: p3[0] - 18, y: (geo.lane(2) + geo.lane(3)) / 2, anchor: "end", v: "mid", tone: "M", px: 12, py: 10, lines: [{ text: "Signed by MPC", size: "s", weight: 800 }, { text: signed, size: "xs", weight: 600, mono: true }] },
        { key: "sent", from: times.sent, x: p4[0] + 18, y: (geo.lane(1) + geo.lane(2)) / 2, anchor: "start", v: "mid", tone: "plain", px: 12, py: 10, lines: [{ text: "Signer checked, sent", size: "s", weight: 800 }, { text: sentLine, size: "xs", weight: 600, mono: true }] },
        { key: "after", from: times.included, jump: jumps.after, x: p5[0] + 26, y: p5[1] - 20, anchor: "end", v: "bottom", tone: "P", px: 16, py: 12, lines: afterLines },
      ]
    : [
        { key: "first", from: -Infinity, jump: jumps.before, x: geo.lane(3) + 30, y: p0[1], anchor: "start", v: "mid", tone: firstTone, px: 12, py: 9, lines: firstLines },
        { key: "near", from: times.near, x: geo.lane(3) + 30, y: p2[1], anchor: "start", v: "mid", tone: "plain", px: 12, py: 10, lines: [{ text: "Rescue call on NEAR", size: "s", weight: 800 }, { text: near, size: "xs", weight: 600, mono: true }] },
        { key: "signed", from: times.signed, jump: jumps.signed, x: geo.lane(3) + 30, y: p3[1] - 2, anchor: "start", v: "bottom", tone: "M", px: 12, py: 10, lines: [{ text: "Signed by MPC, sent", size: "s", weight: 800 }, { text: signed, size: "xs", weight: 600, mono: true }] },
        { key: "after", from: times.included, jump: jumps.after, x: geo.lane(3) + 30, y: p5[1] + 10, anchor: "start", v: "top", tone: "P", px: 14, py: 10, lines: afterLines },
      ];

  const ticks = horizontal ? Array.from({ length: Math.floor(geo.tmax - 0.4) + 1 }, (_, second) => second) : [];
  const zoneA = geo.at(TMIN, 0);
  const zoneB = geo.at(0, 3);
  const ended = t >= end;
  const clockText = t < 0 ? "before" : `${Math.min(t, times.included).toFixed(2)} s`;

  return (
    <svg className={`map map-${geo.layout}`} viewBox={`0 0 ${geo.W} ${geo.H}`} width={geo.W} height={geo.H} role="group" aria-label="The route of one rescue, drawn to time">
      <defs>
        <clipPath id={clip}>{horizontal ? <rect x={-20} y={-20} width={Math.max(0, head[0] + 12)} height={geo.H + 40} /> : <rect x={-20} y={-20} width={geo.W + 40} height={Math.max(0, head[1] + 12)} />}</clipPath>
      </defs>
      <g aria-hidden="true">
        {horizontal ? (
          <>
            <rect className="zone" x={zoneA[0]} y={geo.lane(0) - 22} width={zoneB[0] - zoneA[0]} height={geo.lane(3) - geo.lane(0) + 44} rx={6} />
            <text className="t-xs w6 f-ink2" x={zoneA[0] + 8} y={geo.lane(3) + 40}>
              Before the run, untimed
            </text>
          </>
        ) : (
          <rect className="zone" x={geo.lane(0) - 16} y={zoneA[1]} width={geo.lane(3) - geo.lane(0) + 32} height={zoneB[1] - zoneA[1]} rx={6} />
        )}
        {LANES.map((key, index) => {
          const start = geo.at(TMIN, index);
          const stop = geo.at(geo.tmax, index);
          return <line key={key} className={`lane s-${key}`} x1={horizontal ? start[0] - 12 : start[0]} y1={horizontal ? start[1] : start[1] - 6} x2={stop[0]} y2={stop[1]} />;
        })}
        {horizontal &&
          LANES.map((key, index) => {
            const y = geo.lane(index);
            return (
              <g key={key}>
                <rect className={`f-${key}`} x={0} y={y - 13} width={26} height={26} rx={7} />
                <text className="t-s w8 f-white" x={13} y={y + 6} textAnchor="middle">
                  {key}
                </text>
                <text className="t-s w8 f-ink" x={36} y={y - 1}>
                  {LANE_NAMES[key]}
                </text>
                <text className="t-xs f-ink2" x={36} y={y + 15}>
                  {key === "P" ? `Aave on ${replay.chain}` : key === "K" ? "Off chain" : key === "N" ? `NEAR ${replay.network}` : "NEAR Chain Signatures"}
                </text>
              </g>
            );
          })}
        {ticks.map((second) => {
          const [x] = geo.at(second, 3);
          return (
            <g key={second}>
              <line className="tick" x1={x} x2={x} y1={geo.axis - 16} y2={geo.axis - 8} />
              <text className="t-xs mono f-ink2" x={x} y={geo.axis + 8} textAnchor="middle">
                {second} s
              </text>
            </g>
          );
        })}
        <g clipPath={`url(#${clip})`}>
          {route.slice(0, -1).map((a, index) => {
            const b = route[index + 1] as (typeof route)[number];
            return <line key={index} className={`route s-${STRETCH[index]}${index === 0 ? " route-dots" : ""}`} x1={a.p[0]} y1={a.p[1]} x2={b.p[0]} y2={b.p[1]} />;
          })}
        </g>
        {horizontal ? (
          <line className="playhead" x1={head[0]} x2={head[0]} y1={8} y2={geo.axis - 12} opacity={ended ? 0 : 1} />
        ) : (
          <line className="playhead" x1={0} x2={geo.lane(3) + 16} y1={head[1]} y2={head[1]} opacity={ended ? 0 : 1} />
        )}
        {[
          { t: 0, lane: 0, big: false, fill: t >= 0 ? "f-amber" : "f-white" },
          { t: times.near, lane: 2, big: false, fill: "f-white" },
          { t: times.signed, lane: 3, big: false, fill: "f-white" },
          { t: times.sent, lane: 1, big: false, fill: "f-white" },
          { t: times.included, lane: 0, big: true, fill: t >= times.included ? "f-P" : "f-white" },
        ].map((station) => {
          const [cx, cy] = geo.at(station.t, station.lane);
          return <circle key={`${station.t}-${station.lane}`} className={`station ${station.fill}${station.big ? " station-end" : ""}`} cx={cx} cy={cy} r={station.big ? 10 : 7.5} />;
        })}
      </g>
      {signs.map((sign) => (sign.from <= t || sign.from === -Infinity ? <SignBox key={sign.key} sign={sign} geo={geo} onJump={onJump} /> : null))}
      <g aria-hidden="true">
        <circle className="train" cx={train[0]} cy={train[1]} r={10} />
        {horizontal && !ended && (
          <g>
            <rect className="f-ink" x={head[0] - 31} y={geo.axis - 6} width={62} height={22} rx={5} />
            <text className="t-xs w7 mono f-white" x={head[0]} y={geo.axis + 10} textAnchor="middle">
              {clockText}
            </text>
          </g>
        )}
      </g>
    </svg>
  );
}

function liveMessage(t: number, times: Times, replay: Replay): string {
  if (t < 0) return "Before the run, health factor falling.";
  if (t < times.near) return `Below the trigger at ${replay.healthBefore.toFixed(4)}.`;
  if (t < times.signed) return "Rescue call on NEAR, waiting for the MPC signature.";
  if (t < times.included) return "Signed and sent.";
  return `Repaid ${replay.amount}, health factor ${replay.healthAfter.toFixed(2)}.`;
}

/** The same rescue in words, for screen readers and for anyone who would rather read it. */
function Steps({ replay, times }: { replay: Replay; times: Times }) {
  const trigger = replay.trigger === null ? "" : `, below the trigger of ${replay.trigger.toFixed(2)}`;
  return (
    <ol className="vh">
      {replay.before && (
        <li>
          Before the run, untimed: health factor falls from {replay.before.from.toFixed(2)} to {replay.healthBefore.toFixed(2)}
          {trigger}.
        </li>
      )}
      <li>
        0 s: the keeper reads health factor {replay.healthBefore.toFixed(4)} on Aave on {replay.chain}.
      </li>
      <li>{secs(times.near)}: the rescue call is included on NEAR, and the Levee contract checks the caps.</li>
      <li>
        {secs(times.signed)}: the MPC network returns the signature, {secs(times.signed - times.near)} after the call.
      </li>
      <li>{secs(times.sent)}: the keeper checks the signer and sends the repay.</li>
      <li>
        {secs(times.included)}: the repay of {replay.amount} is included{replay.block === null ? "" : ` in block ${integer(replay.block)}`}, and health factor is {replay.healthAfter.toFixed(2)}.
      </li>
    </ol>
  );
}

/**
 * One real testnet rescue on a map of four lines, at real speed. It plays once when it first comes
 * into view, unless the reader asked for less motion, and it can be paused at any moment.
 */
export function RescueMap({ replay }: { replay: Replay }) {
  const { ref, width, viewport, narrow, measured } = useWidth<HTMLDivElement>({ width: 1328, viewport: 1440, narrow: false });
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const times: Times = { near: replay.marks.near / 1000, signed: replay.marks.signed / 1000, sent: replay.marks.sent / 1000, included: replay.marks.included / 1000 };
  const end = times.included + HOLD;
  const tmax = Math.max(Math.floor(times.included) + 1, times.included + 0.6);
  const [t, setT] = useState(end);
  const [mode, setMode] = useState<"idle" | "playing" | "paused">("idle");
  // Spoken progress only once the reader has used the controls, so the autoplay stays quiet.
  const [announce, setAnnounce] = useState(false);
  const frame = useRef(0);
  const touched = useRef(false);
  const wrap = useRef<HTMLElement>(null);

  const stop = useCallback(() => cancelAnimationFrame(frame.current), []);

  const play = useCallback(
    (from: number) => {
      stop();
      const steps = [-PRE, 0, times.near, times.signed, times.included, end];
      const origin = performance.now() - (from + PRE) * 1000;
      // Read at the moment of playing: the hook's value lags by one render.
      const still = window.matchMedia(LESS_MOTION).matches;
      setMode("playing");
      const tick = (now: number) => {
        let at = (now - origin) / 1000 - PRE;
        // With less motion the picture changes only at the recorded moments, and nothing slides.
        if (still) at = steps.filter((step) => step <= at).pop() ?? -PRE;
        setT(Math.min(at, end));
        if (at < end) frame.current = requestAnimationFrame(tick);
        else setMode("idle");
      };
      frame.current = requestAnimationFrame(tick);
    },
    [stop, end, times.near, times.signed, times.included],
  );

  // Plays once, the first time most of it is on screen, unless the reader asked for less motion.
  useEffect(() => {
    const element = wrap.current;
    if (!element || window.matchMedia(LESS_MOTION).matches) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !touched.current) {
          touched.current = true;
          play(-PRE);
          observer.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [play]);

  useEffect(() => stop, [stop]);

  function control() {
    touched.current = true;
    setAnnounce(true);
    if (mode === "playing") {
      stop();
      setMode("paused");
    } else if (mode === "paused") play(t);
    else play(-PRE);
  }

  function jump(at: number) {
    touched.current = true;
    setAnnounce(true);
    stop();
    setT(at);
    setMode(at >= end ? "idle" : "paused");
  }

  const layouts: Array<{ layout: Layout; width: number; viewport: number }> = measured
    ? [{ layout: narrow ? "v" : "h", width, viewport }]
    : [
        { layout: "h", width: 1328, viewport: 1440 },
        { layout: "v", width: 350, viewport: 390 },
      ];
  const when = readSecond(replay.detectedAt);

  return (
    <section className="band" aria-labelledby={`${uid}-title`} ref={wrap}>
      <div className="band-head">
        <h2 id={`${uid}-title`}>A real testnet rescue, at real speed</h2>
        <p className="band-meta">
          {replay.chain} · {when} · <span className="when-h">left to right</span>
          <span className="when-v">top to bottom</span> is time
        </p>
        <div className="acts">
          <a className="pill" href={replay.near.href} rel="noreferrer">
            <Badge lane="N" size="s" />
            {replay.near.label}
          </a>
          <a className="pill" href={replay.evm.href} rel="noreferrer">
            <Badge lane="P" size="s" />
            {replay.evm.label}
          </a>
          <button className="replay" type="button" onClick={control}>
            {mode === "playing" ? "Pause" : mode === "paused" ? "Play" : "Replay"}
          </button>
        </div>
      </div>
      <ul className="legend-m" aria-hidden="true">
        {LANES.map((key) => (
          <li key={key}>
            <Badge lane={key} />
            {LANE_NAMES[key]}
          </li>
        ))}
      </ul>
      <div className="map-frame" ref={ref}>
        {layouts.map(({ layout, width: w, viewport: v }) => (
          <Drawing key={layout} replay={replay} times={times} geo={geometry(layout, w, v, tmax)} t={t} onJump={jump} clip={`${uid}-${layout}`} />
        ))}
      </div>
      <Steps replay={replay} times={times} />
      <p className="vh" aria-live="polite">
        {announce ? liveMessage(t, times, replay) : ""}
      </p>
    </section>
  );
}
