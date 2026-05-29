import { useState } from 'react';
import Game from './Game';
import Game3arm from './Game3arm';

export default function App() {
  const [mapIndex, setMapIndex] = useState(0);
  const [muted, setMuted] = useState(false);
  const onMissionComplete = () => setMapIndex(i => i + 1);
  const is3arm = mapIndex % 2 === 1;
  return is3arm
    ? <Game3arm key={mapIndex} autoStart={mapIndex > 0} onMissionComplete={onMissionComplete} initialMuted={muted} onMuteChange={setMuted} />
    : <Game    key={mapIndex} autoStart={mapIndex > 0} onMissionComplete={onMissionComplete} initialMuted={muted} onMuteChange={setMuted} />;
}
