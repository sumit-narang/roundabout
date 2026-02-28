import { useEffect, useRef, useState } from 'react';
import { RoundaboutGame } from './engine';
import './Game.css';

const SQ_R = 50, SQ_N = 4.2;

const buildSquirclePath = (w, h, r, n) => {
  const cr = Math.min(r, w / 2, h / 2);
  const steps = 24;
  const corner = (cx, cy, a1, a2) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const t = a1 + (i / steps) * (a2 - a1);
      const c = Math.cos(t), s = Math.sin(t);
      const x = (cx + cr * Math.sign(c) * Math.pow(Math.abs(c), 2 / n)).toFixed(2);
      const y = (cy + cr * Math.sign(s) * Math.pow(Math.abs(s), 2 / n)).toFixed(2);
      return `${x} ${y}`;
    });
  const pts = [
    ...corner(cr,     cr,     -Math.PI,      -Math.PI / 2),
    ...corner(w - cr, cr,     -Math.PI / 2,  0),
    ...corner(w - cr, h - cr, 0,             Math.PI / 2),
    ...corner(cr,     h - cr, Math.PI / 2,   Math.PI),
  ];
  return `M ${pts.join(' L ')} Z`;
};

function SquircleBox({ as: Tag = 'div', r = SQ_R, n = SQ_N, className, style, children, ...props }) {
  const ref = useRef(null);
  const [size, setSize] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const clipPath = size
    ? `path("${buildSquirclePath(size.w, size.h, r, n)}")`
    : undefined;
  return (
    <Tag ref={ref} className={className} style={clipPath ? { ...style, clipPath } : style} {...props}>
      {children}
    </Tag>
  );
}

const ArrowKey = ({ deg = 0 }) => (
  <kbd>
    <img
      src="/uparrow.svg"
      alt=""
      style={{ width: 18, height: 18, transform: `rotate(${deg}deg)`, display: 'block' }}
    />
  </kbd>
);

const PHASE_LABELS = {
  approaching:   'Approaching',
  on_roundabout: 'On Roundabout',
  exiting:       'Exiting',
  completed:     'Completed!',
};
const ORDINALS = { 1: '1st', 2: '2nd', 3: '3rd' };
const IND_HINTS = {
  1: 'Indicate left on approach',
  2: 'No indicator on approach. Signal left after the 1st exit',
  3: 'Indicate right on approach',
};
const GRACE_MSG = {
  left:           'Signal left',
  right:          'Signal right',
  none:           'Cancel indicator',
  approach_outer: 'Move to left (outer) lane',
  approach_inner: 'Move to right (inner) lane',
  ring_outer:     'Move to outer ring lane',
  ring_inner:     'Move to inner ring lane',
  signal:         'Signal before changing lane',
};

export default function Game() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const [hud, setHud] = useState({
    speed: 0, speedRatio: 0, gear: 'D', steer: 0,
    phase: 'approaching', targetExit: null, targetExitNum: null,
    requiredLane: 'outer', leftIndicator: false, rightIndicator: false,
    approachLane: 'outer', ringLane: 'outer',
    graceActive: false, graceTimer: 0, graceRequired: null,
    failed: false, failReason: null, showComplete: false, missionIndex: 0,
  });
  const [started,        setStarted]        = useState(false);
  const [muted,          setMuted]          = useState(false);
  const [btnHovered,     setBtnHovered]     = useState(false);
  const [retryHovered,   setRetryHovered]   = useState(false);
  const [showIndHint,    setShowIndHint]    = useState(false);
  const indHintTimer = useRef(null);
  const glowStyle = hovered => ({
    boxShadow: hovered ? '0 0 16px 0px rgba(240,144,48,0.13), 0 0 78px 12px rgba(240,144,48,0.25)' : 'none',
  });
  const speedCfg = { strokeWidth: 7, color: '#00e5ff', bgOpacity: 0.1 };
  const haptic = pattern => { if (window.innerWidth < 600) navigator.vibrate?.(pattern); };

  useEffect(() => {
    const engine = new RoundaboutGame(canvasRef.current, setHud);
    engineRef.current = engine;
    return () => engine.destroy();
  }, []);

  useEffect(() => {
    if (!hud.targetExitNum) return;
    setShowIndHint(true);
    clearTimeout(indHintTimer.current);
    indHintTimer.current = setTimeout(() => setShowIndHint(false), 6000);
  }, [hud.targetExitNum]);

  useEffect(() => { if (hud.graceActive)   haptic([30, 20, 30]); },       [hud.graceActive]);
  useEffect(() => { if (hud.failed)        haptic([60, 40, 100]); },      [hud.failed]);
  useEffect(() => { if (hud.showComplete)  haptic([40, 20, 40, 20, 80]); }, [hud.showComplete]);

  const renderSpeedo = () => {
    const cx = 40, cy = 40, r = 30;
    const sw = speedCfg.strokeWidth;
    const ratio = hud.speedRatio;
    const n = 20, segFrac = 0.72;
    const lit = Math.round(ratio * n);
    const step = (2 * Math.PI) / n;
    const segs = Array.from({ length: n }, (_, i) => {
      const a0 = -Math.PI / 2 + i * step;
      const a1 = a0 + step * segFrac;
      const x1 = (cx + r * Math.cos(a0)).toFixed(2);
      const y1 = (cy + r * Math.sin(a0)).toFixed(2);
      const x2 = (cx + r * Math.cos(a1)).toFixed(2);
      const y2 = (cy + r * Math.sin(a1)).toFixed(2);
      return (
        <path key={i} d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`}
          fill="none" strokeWidth={sw} strokeLinecap="butt"
          stroke={i < lit ? '#00e5ff' : 'rgba(255,255,255,0.08)'} />
      );
    });
    return (
      <>
        <svg viewBox="4 4 72 72" style={{ width: '100%', height: '100%', display: 'block' }}>{segs}</svg>
        <div className="top-hud-speed-text">
          <span className="top-hud-speed-num">{hud.speed}</span>
          <span className="top-hud-speed-unit">km/h</span>
        </div>
      </>
    );
  };

  return (
    <div className="game-wrap">
      <canvas ref={canvasRef} className="game-canvas" />

      {/* ── Start screen ── */}
      {!started && (
        <div className="start-screen">
          <SquircleBox className="start-vignette">
            <h1>ROUNDABOUT</h1>
            <p className="start-desc">Master the madness of Ireland’s roundabouts and <br />prove your driving skill</p>
            <div className="key-guide">
              <div className="key-row">
                <span>Accelerate</span>
                <div className="key-group"><ArrowKey deg={0} /></div>
              </div>
              <div className="key-row">
                <span>Brake / Reverse</span>
                <div className="key-group"><ArrowKey deg={180} /></div>
              </div>
              <div className="key-row">
                <span>Steer</span>
                <div className="key-group"><ArrowKey deg={270} /><ArrowKey deg={90} /></div>
              </div>
              <div className="key-row">
                <span>Indicators</span>
                <div className="key-group"><kbd className="key-qe">Q</kbd><kbd className="key-qe">E</kbd></div>
              </div>
            </div>
            <SquircleBox as="button"
              className="start-btn"
              onClick={() => { haptic(25); setStarted(true); engineRef.current?.startGame(); }}
              onMouseEnter={() => setBtnHovered(true)}
              onMouseLeave={() => setBtnHovered(false)}
              style={glowStyle(btnHovered)}
            >
              Drive
            </SquircleBox>

          </SquircleBox>
        </div>
      )}

      {/* ── HUD ── */}
      {started && (
        <>
          {/* Top HUD card — speed + mission info */}
          <SquircleBox className="top-hud" r={32} n={2.6}>
            <div className="top-hud-speed">
              {renderSpeedo()}
            </div>

            <div className="top-hud-divider" />

            <div className="top-hud-mission">
              <div className="top-hud-exit">
                Take {ORDINALS[hud.targetExitNum]} Exit
              </div>
              <div className="top-hud-lane">
                {hud.requiredLane === 'either'
                  ? 'Use either lane'
                  : `Use ${hud.requiredLane === 'outer' ? 'outer' : 'inner'} lane on approach`}
              </div>
            </div>

            <div className="top-hud-divider" />

            <div className="top-hud-indicators">
              <div className={`ind-arrow ind-left${hud.leftIndicator ? ' on' : ''}`}>▶</div>
              <div className={`ind-arrow ind-right${hud.rightIndicator ? ' on' : ''}`}>▶</div>
            </div>
          </SquircleBox>

          {/* Indicator hint — appears below banner for 6s on each new mission */}
          {showIndHint && (
            <div className="ind-hint">{IND_HINTS[hud.targetExitNum]}</div>
          )}

          {/* Warning banner */}
          {(hud.graceActive && !hud.failed) && (
            <div className="grace-warning">
              <img src="/warning.svg" alt="" width={22} height={22} />
              <span className="grace-text">{GRACE_MSG[hud.graceRequired] ?? 'Signal Left'}</span>
              <span className="grace-timer">{Math.ceil(hud.graceTimer) || 3}s</span>
            </div>
          )}

          {/* Game-over overlay */}
          {hud.failed && (
            <div className="result-overlay">
              <SquircleBox className="result-panel result-fail">
                <div className="result-title">FAILED</div>
                <div className="result-msg">{hud.failReason}</div>
                <SquircleBox as="button"
                  className="start-btn"
                  onClick={() => engineRef.current?.restart()}
                  onMouseEnter={() => setRetryHovered(true)}
                  onMouseLeave={() => setRetryHovered(false)}
                  style={glowStyle(retryHovered)}
                >
                  Try Again
                </SquircleBox>
              </SquircleBox>
            </div>
          )}

          {/* Mission complete overlay */}
          {hud.showComplete && (
            <div className="result-overlay">
              <SquircleBox className="result-panel result-win">
                <div className="result-title">WELL DONE!</div>
                <div className="result-msg">Starting new mission…</div>
              </SquircleBox>
            </div>
          )}




          {/* Refresh button */}
          <button className="refresh-btn" onClick={() => window.location.reload()}>
            <img src="/refresh.svg" alt="Refresh" />
          </button>

          {/* Sound toggle */}
          <button
            className="sound-btn"
            onClick={() => setMuted(engineRef.current?.toggleMute() ?? false)}
          >
            <img src={muted ? '/soundOFF.svg' : '/soundON.svg'} alt={muted ? 'Unmute' : 'Mute'} />
          </button>

          {/* Touch controls — only visible on mobile via CSS */}
          <div className="touch-controls">
            {/* Left: indicator buttons */}
            <div className="touch-inds">
              <SquircleBox as="button" r={14} className="touch-btn touch-ind-btn" onPointerDown={() => { haptic(12); engineRef.current?.triggerIndicator('left'); }}>◀</SquircleBox>
              <SquircleBox as="button" r={14} className="touch-btn touch-ind-btn" onPointerDown={() => { haptic(12); engineRef.current?.triggerIndicator('right'); }}>▶</SquircleBox>
            </div>
            {/* Right: D-pad — top row: up; bottom row: left down right */}
            <div className="touch-dpad">
              <div className="touch-dpad-top">
                <SquircleBox as="button" r={14} className="touch-btn"
                  onPointerDown={e => { haptic(8); e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.pressKey('ArrowUp'); }}
                  onPointerUp={() => engineRef.current?.releaseKey('ArrowUp')}
                  onPointerCancel={() => engineRef.current?.releaseKey('ArrowUp')}
                ><img src="/uparrow.svg" alt="Accelerate" style={{ width: 22, height: 22 }} /></SquircleBox>
              </div>
              <div className="touch-dpad-bottom">
                <SquircleBox as="button" r={14} className="touch-btn"
                  onPointerDown={e => { haptic(8); e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.pressKey('ArrowLeft'); }}
                  onPointerUp={() => engineRef.current?.releaseKey('ArrowLeft')}
                  onPointerCancel={() => engineRef.current?.releaseKey('ArrowLeft')}
                ><img src="/uparrow.svg" alt="Left" style={{ width: 22, height: 22, transform: 'rotate(270deg)' }} /></SquircleBox>
                <SquircleBox as="button" r={14} className="touch-btn"
                  onPointerDown={e => { haptic(8); e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.pressKey('ArrowDown'); }}
                  onPointerUp={() => engineRef.current?.releaseKey('ArrowDown')}
                  onPointerCancel={() => engineRef.current?.releaseKey('ArrowDown')}
                ><img src="/uparrow.svg" alt="Brake" style={{ width: 22, height: 22, transform: 'rotate(180deg)' }} /></SquircleBox>
                <SquircleBox as="button" r={14} className="touch-btn"
                  onPointerDown={e => { haptic(8); e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.pressKey('ArrowRight'); }}
                  onPointerUp={() => engineRef.current?.releaseKey('ArrowRight')}
                  onPointerCancel={() => engineRef.current?.releaseKey('ArrowRight')}
                ><img src="/uparrow.svg" alt="Right" style={{ width: 22, height: 22, transform: 'rotate(90deg)' }} /></SquircleBox>
              </div>
            </div>
          </div>


        </>
      )}
    </div>
  );
}
