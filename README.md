# Roundabout

A browser-based 3D driving game that teaches the rules of Irish roundabouts. Navigate your car through clockwise roundabouts, pick the correct lane, signal at the right time, and take the assigned exit — or fail and try again.

Built with **React**, **Three.js**, and **Vite**. Deployed on Vercel.

---

## What it is

Irish roundabouts have strict rules around lane discipline and indicators that catch out learner drivers. This game simulates those rules in a low-poly 3D environment so you can practise them without the stakes of a real road.

Each mission assigns you a target exit. You must:

- Approach in the correct lane (outer for exit 1, inner for exit 3)
- Signal with the right indicator on approach
- Switch ring lanes at the right point
- Signal left before your exit
- Take the correct exit

Fail any of those within the grace period and the run ends. Complete the exit cleanly and you move on to the next mission.

---

## Maps

The game alternates between two roundabout layouts:

| Layout | Arms | Exits available |
|--------|------|----------------|
| **4-arm** | North / South / East / West | 1st (west), 2nd (north), 3rd (east) |
| **3-arm** | Y-shaped, arms 120° apart | 1st (upper-left / NW), 2nd (upper-right / NE) |

Each layout has its own physics engine (`engine.js` / `engine3arm.js`) and game component (`Game.jsx` / `Game3arm.jsx`).

---

## Controls

| Action | Keyboard | Mobile |
|--------|----------|--------|
| Accelerate | `↑` | D-pad up |
| Brake / Reverse | `↓` | D-pad down |
| Steer | `← →` | D-pad left / right |
| Left indicator | `Q` | Indicator button ◀ |
| Right indicator | `E` | Indicator button ▶ |

---

## Tech stack

- **Three.js** — 3D rendering, physics loop, procedural textures (asphalt, grass), GLTF/Draco model loading
- **React 19** — UI layer: HUD, overlays, start screen, squircle components
- **Vite** — dev server and production build with Brotli/gzip compression
- **Vercel Analytics** — page-view tracking
- **Web Audio API** — engine sound with pitch tied to speed, indicator ticks

### 3D assets

Low-poly GLB models loaded via Draco compression:

- Coloured cars (orange, purple, white, blue, green) — player + NPC traffic
- Buildings, trees, clouds, lamp posts, yield signs

---

## What was built

### v0 — Initial roundabout
Basic 3D roundabout with a drivable car, road geometry, and a first pass at mission logic.

### Performance pass
Optimised renderer settings, texture reuse, and draw-call reduction for smooth 60fps on mobile.

### Gameplay fixes
Corrected exit-detection logic so the mission state machine transitions reliably for all three exits.

### Mobile support
On-screen D-pad and indicator buttons (touch-only, hidden on desktop). Haptic feedback via `navigator.vibrate`.

### UI polish
- Rounded and squircle clip-path buttons/cards (Apple-style superellipse)
- Sound/refresh icon updates
- Consistent border-radius on all modals and overlays

### 3-arm roundabout
Added a second Y-shaped layout (arms 120° apart) with its own engine and game component. Missions now alternate 4-arm → 3-arm → 4-arm.

### Deployment
Fixed Vite `base` path for subdomain deployment on Vercel.

### Analytics
Added `@vercel/analytics` for visitor tracking.

---

## Development

```bash
npm install
npm run dev       # start dev server
npm run build     # production build (outputs to /dist)
npm run preview   # preview the production build
```
