import { useEffect, useRef, useState } from 'react';
import { RoundaboutGame } from './engine';
import './Game.css';


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
  1: 'Indicate Left on Approach',
  2: 'No Indicator on Approach · Signal Left After 1st Exit',
  3: 'Indicate Right on Approach',
};
const GRACE_MSG = {
  left:           'Signal Left',
  right:          'Signal Right',
  none:           'Cancel Indicator',
  approach_outer: 'Move to Left (Outer) Lane',
  approach_inner: 'Move to Right (Inner) Lane',
  ring_outer:     'Move to Outer Ring Lane',
  ring_inner:     'Move to Inner Ring Lane',
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
  const glowStyle = hovered => ({
    boxShadow: hovered ? '0 0 16px 0px rgba(240,144,48,0.13), 0 0 78px 12px rgba(240,144,48,0.25)' : 'none',
  });
  const speedCfg = { size: 80, strokeWidth: 7, color: '#00e5ff', bgOpacity: 0.1, numSize: 1.35 };

  useEffect(() => {
    const engine = new RoundaboutGame(canvasRef.current, setHud);
    engineRef.current = engine;
    return () => engine.destroy();
  }, []);

  return (
    <div className="game-wrap">
      <canvas ref={canvasRef} className="game-canvas" />

      {/* ── Start screen ── */}
      {!started && (
        <div className="start-screen">
          <div className="start-vignette">
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
            <button
              className="start-btn"
              onClick={() => { setStarted(true); engineRef.current?.startGame(); }}
              onMouseEnter={() => setBtnHovered(true)}
              onMouseLeave={() => setBtnHovered(false)}
              style={glowStyle(btnHovered)}
            >
              Drive
            </button>

          </div>
        </div>
      )}

      {/* ── HUD ── */}
      {started && (
        <>
          {/* Top HUD card — speed + mission info */}
          <div className="top-hud">
            <div className="top-hud-speed" style={{ width: speedCfg.size, height: speedCfg.size }}>
              <svg className="top-hud-speed-ring" viewBox="0 0 80 80" style={{ width: speedCfg.size, height: speedCfg.size }}>
                <circle cx="40" cy="40" r="30" className="speed-ring-bg" strokeWidth={speedCfg.strokeWidth} style={{ stroke: `rgba(255,255,255,${speedCfg.bgOpacity})` }} />
                <circle cx="40" cy="40" r="30" className="speed-ring-fill" strokeWidth={speedCfg.strokeWidth} style={{ stroke: speedCfg.color }}
                  strokeDasharray={`${hud.speedRatio * 188.5} 188.5`} />
              </svg>
              <div className="top-hud-speed-text">
                <span className="top-hud-speed-num" style={{ fontSize: `${speedCfg.numSize}rem` }}>{hud.speed}</span>
                <span className="top-hud-speed-unit">Km/hr</span>
              </div>
            </div>

            <div className="top-hud-divider" />

            <div className="top-hud-mission">
              <div className="top-hud-exit">
                Take {ORDINALS[hud.targetExitNum]} Exit
              </div>
              <div className="top-hud-lane">
                {hud.requiredLane === 'either'
                  ? 'Use Either Lane'
                  : `Use ${hud.requiredLane === 'outer' ? 'Outer' : 'Inner'} Lane On Approach`}
              </div>
              <div className="top-hud-ind">{IND_HINTS[hud.targetExitNum]}</div>
            </div>
            
            <div className="top-hud-divider" />
            
            <div className="top-hud-indicators">
              <div className={`ind-arrow ind-left${hud.leftIndicator ? ' on' : ''}`}>▶</div>
              <div className={`ind-arrow ind-right${hud.rightIndicator ? ' on' : ''}`}>▶</div>
            </div>
          </div>

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
              <div className="result-panel result-fail">
                <div className="result-title">FAILED</div>
                <div className="result-msg">{hud.failReason}</div>
                <button
                  className="start-btn"
                  onClick={() => engineRef.current?.restart()}
                  onMouseEnter={() => setRetryHovered(true)}
                  onMouseLeave={() => setRetryHovered(false)}
                  style={glowStyle(retryHovered)}
                >
                  Try Again
                </button>
              </div>
            </div>
          )}

          {/* Mission complete overlay */}
          {hud.showComplete && (
            <div className="result-overlay">
              <div className="result-panel result-win">
                <div className="result-title">WELL DONE!</div>
                <div className="result-msg">Starting new mission…</div>
              </div>
            </div>
          )}




          {/* Refresh button */}
          <button className="refresh-btn" onClick={() => window.location.reload()}>
            <img src="/refresh.svg" alt="Refresh" width={20} height={20} />
          </button>

          {/* Sound toggle */}
          <button
            className="sound-btn"
            onClick={() => setMuted(engineRef.current?.toggleMute() ?? false)}
          >
            <img src={muted ? '/soundOFF.svg' : '/soundON.svg'} alt={muted ? 'Unmute' : 'Mute'} width={20} height={20} />
          </button>


        </>
      )}
    </div>
  );
}
