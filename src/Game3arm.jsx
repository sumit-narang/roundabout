import { useEffect, useRef, useState } from 'react';
import { RoundaboutGame3arm } from './engine3arm';
import './Game.css';

const SQ_R = 40, SQ_N = 4;

const buildSquirclePath = (w, h, r, n) => {
  const cr = Math.min(r, w / 2, h / 2);
  if (cr === 0) return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  const f  = Math.pow(Math.SQRT1_2, 2 / n);
  const k  = Math.min((f - 0.5) / 0.375, 1);
  const kc = cr * k;
  const p  = v => v.toFixed(2);
  return [
    `M ${p(cr)} 0`,
    `L ${p(w - cr)} 0`,
    `C ${p(w - cr + kc)} 0 ${p(w)} ${p(cr - kc)} ${p(w)} ${p(cr)}`,
    `L ${p(w)} ${p(h - cr)}`,
    `C ${p(w)} ${p(h - cr + kc)} ${p(w - cr + kc)} ${p(h)} ${p(w - cr)} ${p(h)}`,
    `L ${p(cr)} ${p(h)}`,
    `C ${p(cr - kc)} ${p(h)} 0 ${p(h - cr + kc)} 0 ${p(h - cr)}`,
    `L 0 ${p(cr)}`,
    `C 0 ${p(cr - kc)} ${p(cr - kc)} 0 ${p(cr)} 0`,
    `Z`,
  ].join(' ');
};

function SquircleBox({ as: Tag = 'div', r = SQ_R, n = SQ_N, disabled = false, className, style, children, ...props }) {
  const ref = useRef(null);
  const [clipPath, setClipPath] = useState(undefined);
  useEffect(() => {
    if (disabled) { setClipPath(undefined); return; }
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.offsetWidth, h = el.offsetHeight;
      if (w > 0 && h > 0)
        setClipPath(`path("${buildSquirclePath(w, h, r, n)}")`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [r, n, disabled]);
  return (
    <Tag ref={ref} className={className} style={clipPath ? { ...style, clipPath, borderRadius: 0 } : style} {...props}>
      {children}
    </Tag>
  );
}

const BASE = import.meta.env.BASE_URL;

const ArrowKey = ({ deg = 0 }) => (
  <SquircleBox as="kbd" r={10}>
    <img src={`${BASE}icons/uparrow.svg`} alt="" style={{ width: 18, height: 18, transform: `rotate(${deg}deg)`, display: 'block' }} />
  </SquircleBox>
);

const ORDINALS = { 1: '1st', 2: '2nd' };
const IND_HINTS = {
  1: 'Indicate left on approach',
  2: 'Indicate right on approach. Signal left after passing the 1st exit',
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
  exit_right:     'Move to right lane',
  exit_left:      'Move to left lane',
};

export default function Game3arm() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const [hud, setHud] = useState({
    speed: 0, speedRatio: 0, gear: 'D', steer: 0,
    phase: 'approaching', targetExitNum: null,
    requiredLane: 'outer', leftIndicator: false, rightIndicator: false,
    approachLane: 'outer', ringLane: 'outer',
    graceActive: false, graceTimer: 0, graceRequired: null,
    failed: false, failReason: null, showComplete: false, missionIndex: 0,
  });
  const [started,      setStarted]      = useState(false);
  const [muted,        setMuted]        = useState(false);
  const [btnHovered,   setBtnHovered]   = useState(false);
  const [retryHovered, setRetryHovered] = useState(false);
  const [showIndHint,  setShowIndHint]  = useState(false);
  const indHintTimer = useRef(null);
  const glowStyle = hovered => ({
    boxShadow: hovered ? '0 0 16px 0px rgba(240,144,48,0.13), 0 0 78px 12px rgba(240,144,48,0.25)' : 'none',
  });
  const speedCfg = { strokeWidth: 7, color: '#00e5ff', bgOpacity: 0.1 };
  const haptic = pattern => { if (window.innerWidth < 600) navigator.vibrate?.(pattern); };

  useEffect(() => {
    const engine = new RoundaboutGame3arm(canvasRef.current, setHud);
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
    const cx = 40, cy = 40, r = 30, sw = speedCfg.strokeWidth;
    const ratio = hud.speedRatio, n = 20, segFrac = 0.72;
    const lit = Math.round(ratio * n), step = (2 * Math.PI) / n;
    const segs = Array.from({ length: n }, (_, i) => {
      const a0 = -Math.PI / 2 + i * step, a1 = a0 + step * segFrac;
      const x1 = (cx + r * Math.cos(a0)).toFixed(2), y1 = (cy + r * Math.sin(a0)).toFixed(2);
      const x2 = (cx + r * Math.cos(a1)).toFixed(2), y2 = (cy + r * Math.sin(a1)).toFixed(2);
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
            <p className="start-desc">Navigate a 3-arm Y-junction roundabout<br />and prove your driving skill</p>
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
                <div className="key-group"><SquircleBox as="kbd" r={10} className="key-qe">Q</SquircleBox><SquircleBox as="kbd" r={10} className="key-qe">E</SquircleBox></div>
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
          <SquircleBox className="top-hud">
            <div className="top-hud-speed">{renderSpeedo()}</div>
            <div className="top-hud-divider" />
            <div className="top-hud-mission">
              <div className="top-hud-exit">Take {ORDINALS[hud.targetExitNum]} Exit</div>
              <div className="top-hud-lane">
                {hud.targetExitNum === 2
                  ? 'Use right lane. Inner on roundabout'
                  : 'Use left lane. Outer on roundabout'}
              </div>
            </div>
            <div className="top-hud-divider" />
            <div className="top-hud-indicators">
              <div className={`ind-arrow ind-left${hud.leftIndicator ? ' on' : ''}`}>▶</div>
              <div className={`ind-arrow ind-right${hud.rightIndicator ? ' on' : ''}`}>▶</div>
            </div>
          </SquircleBox>

          {showIndHint && (
            <div className="ind-hint">{IND_HINTS[hud.targetExitNum]}</div>
          )}

          {(hud.graceActive && !hud.failed) && (
            <SquircleBox className="grace-warning">
              <img src={`${BASE}icons/warning.svg`} alt="" width={22} height={22} />
              <span className="grace-text">{GRACE_MSG[hud.graceRequired] ?? 'Signal Left'}</span>
              <span className="grace-timer">{Math.ceil(hud.graceTimer) || 3}s</span>
            </SquircleBox>
          )}

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

          {hud.showComplete && (
            <div className="result-overlay">
              <SquircleBox className="result-panel result-win">
                <div className="result-title">WELL DONE!</div>
                <div className="result-msg">Roundabout mastered!</div>
                <SquircleBox as="button"
                  className="start-btn"
                  onClick={() => { haptic(25); engineRef.current?.nextMission(); }}
                >
                  Next Mission
                </SquircleBox>
              </SquircleBox>
            </div>
          )}

          <button className="refresh-btn" onClick={() => window.location.reload()} onMouseDown={e => e.currentTarget.blur()}>
            <img src={`${BASE}icons/refresh.svg`} alt="Refresh" draggable="false" />
          </button>

          <button className="sound-btn"
            onClick={() => setMuted(engineRef.current?.toggleMute() ?? false)}
            onMouseDown={e => e.currentTarget.blur()}
          >
            <img src={muted ? `${BASE}icons/soundOFF.svg` : `${BASE}icons/soundON.svg`} alt={muted ? 'Unmute' : 'Mute'} draggable="false" />
          </button>

          <div className="touch-controls">
            <div className="touch-inds">
              <SquircleBox as="button" className="touch-btn touch-ind-btn" onPointerDown={() => { haptic(12); engineRef.current?.triggerIndicator('left'); }}>◀</SquircleBox>
              <SquircleBox as="button" className="touch-btn touch-ind-btn" onPointerDown={() => { haptic(12); engineRef.current?.triggerIndicator('right'); }}>▶</SquircleBox>
            </div>
            <div className="touch-dpad">
              <div className="touch-dpad-top">
                <SquircleBox as="button" className="touch-btn"
                  onPointerDown={e => { haptic(8); e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.pressKey('ArrowUp'); }}
                  onPointerUp={() => engineRef.current?.releaseKey('ArrowUp')}
                  onPointerCancel={() => engineRef.current?.releaseKey('ArrowUp')}
                ><img src={`${BASE}icons/uparrow.svg`} alt="Accelerate" style={{ width: 22, height: 22 }} /></SquircleBox>
              </div>
              <div className="touch-dpad-bottom">
                <SquircleBox as="button" className="touch-btn"
                  onPointerDown={e => { haptic(8); e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.pressKey('ArrowLeft'); }}
                  onPointerUp={() => engineRef.current?.releaseKey('ArrowLeft')}
                  onPointerCancel={() => engineRef.current?.releaseKey('ArrowLeft')}
                ><img src={`${BASE}icons/uparrow.svg`} alt="Left" style={{ width: 22, height: 22, transform: 'rotate(270deg)' }} /></SquircleBox>
                <SquircleBox as="button" className="touch-btn"
                  onPointerDown={e => { haptic(8); e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.pressKey('ArrowDown'); }}
                  onPointerUp={() => engineRef.current?.releaseKey('ArrowDown')}
                  onPointerCancel={() => engineRef.current?.releaseKey('ArrowDown')}
                ><img src={`${BASE}icons/uparrow.svg`} alt="Brake" style={{ width: 22, height: 22, transform: 'rotate(180deg)' }} /></SquircleBox>
                <SquircleBox as="button" className="touch-btn"
                  onPointerDown={e => { haptic(8); e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.pressKey('ArrowRight'); }}
                  onPointerUp={() => engineRef.current?.releaseKey('ArrowRight')}
                  onPointerCancel={() => engineRef.current?.releaseKey('ArrowRight')}
                ><img src={`${BASE}icons/uparrow.svg`} alt="Right" style={{ width: 22, height: 22, transform: 'rotate(90deg)' }} /></SquircleBox>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
