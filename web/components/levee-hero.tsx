"use client";

import { useState } from "react";

/** The figures the hero states, all from the replayed run record. */
export interface HeroRun {
  before: string;
  after: string;
  trigger: string;
  target: string;
  /** 5.59 USDC */
  amount: string;
  /** 0.002698 WETH, or null when the run sold nothing */
  sold: string | null;
  chain: string;
  /** 11 Nov 2026, 20:37 UTC */
  when: string;
  /** 8.0 s */
  total: string;
  keyless: boolean;
}

const WAVE =
  "M-80 290" + " q20 -7 40 0 t40 0".repeat(12);

/**
 * The homepage's first screen: the levee. Your collateral is the levee, your debt the water against
 * it, and the gauge reads your health factor. When the water passes the trigger, the route runs from
 * the keeper through the contract on NEAR and the MPC network to LeveeUnwind, which takes one brick
 * off the top, sells it in the pool and repays debt with what it brings, so the water falls to the
 * target. A 12 s loop of one real run, shown faster and labelled so. Under reduced motion, or paused,
 * it holds still; its resting frame is the end of the rescue.
 */
export function LeveeHero({ run }: { run: HeroRun }) {
  const [paused, setPaused] = useState(false);
  const after = run.keyless ? ", after the NEAR contract lost its last key" : "";

  return (
    <section className={paused ? "lh lh-paused" : "lh"} aria-labelledby="lh-title">
      <div className="lh-top">
        <div className="lh-copy">
          <p className="lh-eyebrow">
            <span className="lh-dot" aria-hidden="true" />
            Aave v3 rescues, signed on NEAR
          </p>
          <h1 id="lh-title">Hold the line.</h1>
          <p className="lh-sentence">Your collateral is the levee and your debt is the water. Before the water reaches the top, Levee sells one slice of the levee to lower it.</p>
          <div className="lh-actions">
            <a className="lh-btn lh-btn-primary" href="#rescue">
              Watch a real rescue <span aria-hidden="true">→</span>
            </a>
            <a className="lh-btn lh-btn-quiet" href="#read">
              Read an address
            </a>
          </div>
        </div>

        <div className="lh-card">
          <div className="lh-card-head">
            <span>Health factor</span>
            <button type="button" className="lh-pause" aria-pressed={paused} onClick={() => setPaused(!paused)}>
              {paused ? "Play" : "Pause"}
            </button>
          </div>
          <div className="lh-hf" aria-hidden="true">
            <span className="lh-st lh-a">{run.after}</span>
            <span className="lh-st lh-b">{run.before}</span>
            <span className="lh-st lh-c">{run.after}</span>
          </div>
          <div className="lh-status" aria-hidden="true">
            <span className="lh-st lh-a2">Above your trigger, {run.trigger}</span>
            <span className="lh-st lh-b lh-amber">Below your trigger: selling one slice</span>
            <span className="lh-st lh-c">
              Repaid {run.amount}
              {run.sold ? ` with ${run.sold} of your own collateral` : ""}
            </span>
          </div>
          <p className="lh-note">
            An animation of the rescue on {run.chain}, {run.when}: {run.total} in real time{after}. Health factor {run.before} to {run.after}. Shown faster.
          </p>
        </div>
      </div>

      <svg
        className="lh-scene"
        viewBox="0 0 1440 420"
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label={`Your collateral is a levee of blue bricks, and your USDC debt is the water against it. A gauge reads your health factor; water over the top is liquidation. When the water passes your trigger, ${run.trigger}, a line runs from the keeper to the Levee contract on NEAR, the MPC network and LeveeUnwind, which takes one brick off the top, sells it in the Uniswap pool and repays debt, so the water falls to your target, ${run.target}. Your wallet keeps the position.`}
      >
        <defs>
          <pattern id="lh-bricks" x="0" y="0" width="40" height="28" patternUnits="userSpaceOnUse">
            <rect x="0" y="0" width="40" height="14" fill="#e3e9ff" stroke="#1f4fd6" strokeWidth="1" />
            <rect x="-20" y="14" width="40" height="14" fill="#e3e9ff" stroke="#1f4fd6" strokeWidth="1" />
            <rect x="20" y="14" width="40" height="14" fill="#e3e9ff" stroke="#1f4fd6" strokeWidth="1" />
          </pattern>
        </defs>

        <g className="lh-water">
          <path className="lh-wave" d={`${WAVE} V460 H-80 Z`} fill="#e4e8ec" />
          <path className="lh-wave" d={WAVE} fill="none" stroke="#8a94a0" strokeWidth="2" />
          <text x="40" y="350" className="lh-t lh-t-m" fill="#5e6873">
            Your USDC debt
          </text>
        </g>

        <line x1="0" y1="140" x2="840" y2="140" stroke="#121826" strokeWidth="1" />
        <line className="lh-trig" x1="0" y1="256" x2="812" y2="256" stroke="#9a6700" strokeWidth="2" strokeDasharray="8 6" />
        <line x1="0" y1="290" x2="806" y2="290" stroke="#121826" strokeWidth="1" strokeDasharray="2 5" />

        <rect x="293" y="120" width="14" height="280" fill="#ffffff" stroke="#121826" strokeWidth="2" />
        <path d="M293 140 h14 M293 168 h5 M293 196 h8 M293 224 h5 M293 256 h14 M293 290 h14 M293 318 h5 M293 346 h8 M293 374 h5" stroke="#121826" strokeWidth="2" />
        <text x="280" y="122" textAnchor="end" className="lh-t" fill="#4b5563">
          water over the top: a liquidator takes a bonus
        </text>
        <text x="280" y="136" textAnchor="end" className="lh-t lh-t-m lh-b7" fill="#121826">
          1.00 liquidation
        </text>
        <text x="280" y="252" textAnchor="end" className="lh-t lh-t-m lh-b7" fill="#7a5300">
          {run.trigger} your trigger
        </text>
        <text x="280" y="306" textAnchor="end" className="lh-t lh-t-m lh-b7" fill="#121826">
          {run.target} your target
        </text>
        <g className="lh-below">
          <rect x="318" y="236" width="140" height="28" rx="6" fill="#f2a100" />
          <text x="330" y="255" className="lh-t lh-t-m lh-b7" fill="#121826">
            Below trigger
          </text>
        </g>

        <path className="lh-seg lh-s1" pathLength={1} d="M300 248 V64" stroke="#3f4a55" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path className="lh-seg lh-s2" pathLength={1} d="M300 64 H480" stroke="#087f5b" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path className="lh-seg lh-s3" pathLength={1} d="M480 64 H660" stroke="#6b3fd4" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path className="lh-seg lh-s4" pathLength={1} d="M660 64 H890 V96" stroke="#121826" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />

        <circle className="lh-ping lh-pk" cx="300" cy="64" r="22" fill="none" stroke="#3f4a55" strokeWidth="3" />
        <circle className="lh-ping lh-pn" cx="480" cy="64" r="22" fill="none" stroke="#087f5b" strokeWidth="3" />
        <circle className="lh-ping lh-pm" cx="660" cy="64" r="22" fill="none" stroke="#6b3fd4" strokeWidth="3" />
        <circle className="lh-ping lh-pu" cx="890" cy="108" r="22" fill="none" stroke="#121826" strokeWidth="3" />
        <Node x={300} y={52} fill="#3f4a55" letter="K" label="Keeper sees it" />
        <Node x={480} y={52} fill="#087f5b" letter="N" label="NEAR contract, no keys, decides" />
        <Node x={660} y={52} fill="#6b3fd4" letter="M" label="MPC signs" />
        <rect x="878" y="96" width="24" height="24" rx="4" fill="#121826" />
        <text x="890" y="114" textAnchor="middle" className="lh-t lh-b7" fill="#ffffff">
          U
        </text>
        <text x="912" y="114" className="lh-t lh-b7" fill="#121826">
          LeveeUnwind, no owner
        </text>

        <polygon points="790,400 840,140 940,140 1000,400" fill="url(#lh-bricks)" stroke="#121826" strokeWidth="2" strokeLinejoin="round" />
        <rect className="lh-brick" x="870" y="126" width="40" height="14" fill="#1f4fd6" stroke="#121826" strokeWidth="1.5" />
        <rect x="846" y="259" width="98" height="44" rx="6" fill="#ffffff" stroke="#1f4fd6" strokeWidth="1" />
        <text x="895" y="276" textAnchor="middle" className="lh-t lh-t-m lh-b7" fill="#1f4fd6">
          Your WETH
        </text>
        <text x="895" y="294" textAnchor="middle" className="lh-t lh-t-m lh-b7" fill="#1f4fd6">
          collateral
        </text>

        <rect className="lh-pool" x="520" y="152" width="140" height="34" rx="8" fill="#ffffff" stroke="#121826" strokeWidth="2" />
        <text x="590" y="174" textAnchor="middle" className="lh-t lh-b7" fill="#121826">
          Uniswap pool
        </text>
        {run.sold && (
          <text className="lh-sold lh-t lh-b7" x="720" y="122" textAnchor="middle" fill="#1f4fd6">
            sells {run.sold}
          </text>
        )}
        <g className="lh-coin">
          <circle cx="590" cy="198" r="9" fill="#121826" />
          <text x="590" y="202" textAnchor="middle" className="lh-t lh-t-xs lh-b7" fill="#ffffff">
            $
          </text>
        </g>
        <text className="lh-repaid lh-t lh-b7" x="606" y="232" fill="#121826">
          repays {run.amount} of debt
        </text>

        <line x1="0" y1="400" x2="1440" y2="400" stroke="#121826" strokeWidth="2" />
        <rect x="1110" y="300" width="170" height="100" rx="14" fill="#ffffff" stroke="#121826" strokeWidth="2" />
        <path d="M1110 330 H1280" stroke="#121826" strokeWidth="2" />
        <rect x="1240" y="342" width="40" height="28" rx="6" fill="#ffffff" stroke="#121826" strokeWidth="2" />
        <circle cx="1256" cy="356" r="4" fill="#1f4fd6" />
        <text x="1126" y="320" className="lh-t lh-b7" fill="#121826">
          Your wallet
        </text>
        <text x="1126" y="362" className="lh-t" fill="#4b5563">
          aWETH
        </text>
        <text x="1126" y="380" className="lh-t" fill="#4b5563">
          USDC debt
        </text>
        <rect x="1110" y="222" width="24" height="24" rx="6" fill="#1f4fd6" />
        <text x="1122" y="240" textAnchor="middle" className="lh-t lh-b7" fill="#ffffff">
          P
        </text>
        <text x="1144" y="240" className="lh-t lh-t-m lh-b7" fill="#121826">
          The position stays here
        </text>
        <text x="1110" y="266" className="lh-t" fill="#4b5563">
          Only the slice you allowed can move,
        </text>
        <text x="1110" y="284" className="lh-t" fill="#4b5563">
          and only below your trigger.
        </text>
      </svg>
    </section>
  );
}

function Node({ x, y, fill, letter, label }: { x: number; y: number; fill: string; letter: string; label: string }) {
  return (
    <>
      <rect x={x - 12} y={y} width="24" height="24" rx="6" fill={fill} />
      <text x={x} y={y + 18} textAnchor="middle" className="lh-t lh-b7" fill="#ffffff">
        {letter}
      </text>
      <text x={x} y={y - 18} textAnchor="middle" className="lh-t lh-b7" fill={fill}>
        {label}
      </text>
    </>
  );
}
