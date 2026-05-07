import Game from './Game';
import Game3arm from './Game3arm';

export default function App() {
  const is3arm = new URLSearchParams(window.location.search).get('map') === '3arm';
  return is3arm ? <Game3arm /> : <Game />;
}
