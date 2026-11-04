# NEXUS Character Development Studio — Phase 1 Report

Founder review copy · built 2026-11-04 · nothing deployed, pushed, merged or published.

## 1. What this is

A working 3D development environment for Genesis, Savannah and Aria, served by the existing NEXUS dashboard at:

```
http://127.0.0.1:4000/character-studio/
```

Everything lives in `dashboard/public/character-studio/`. **No existing file was modified.** The dashboard already serves everything in `dashboard/public/`, so the studio needs no server change.

## 2. Exact files created

| File | Size | Purpose |
|---|---|---|
| `index.html` | 1.5 KB | Page shell (no inline scripts, so it passes the dashboard's security policy) |
| `studio.css` | 9.3 KB | NEXUS blue/emerald interface, phone and desktop layouts |
| `src/main.js` | 30 KB | Wires the modules together: scene, selection, camera, controls, panels |
| `src/scene/environment.js` | 7.7 KB | Studio architecture, lighting, reflections, particles, character pads |
| `src/characters/profiles.js` | 9.7 KB | Identities and profiles (data only), including official voice profiles |
| `src/characters/builder.js` | 22.6 KB | Procedural 3D character builder and skeleton |
| `src/animation/controller.js` | 19.4 KB | Per-character animation: idle, look, blink, turn, gesture, walk, stop |
| `src/voice/voice.js` | 12.9 KB | Speech out, speech in, voice settings, mouth movement |
| `src/conversation/adapters.js` | 4.0 KB | Intelligence connection interfaces (all NOT CONNECTED) |
| `src/status/status.js` | 5.3 KB | Development status registry and live device checks |
| `tests/studio.test.mjs` | 15.6 KB | 26 automated tests |
| `vendor/three.module.min.js` | 692 KB (171 KB gzipped) | Three.js r170 |
| `vendor/OrbitControls.js` | 32 KB | Three.js camera controls (import path pointed at the local copy) |
| `vendor/LICENSE-three.txt` | 1 KB | Three.js MIT licence and attribution |
| `README.md` | — | This report |
| `package.json` | 0.2 KB | Marks only this folder as ES modules so its tests run in Node (`dashboard/package.json` says `commonjs`). Not used by the browser. |

Total ≈ 880 KB on disk.

## 3. Dependencies

| Dependency | Version | Licence | Cost | Why |
|---|---|---|---|---|
| Three.js | r170 (git `beab9e8`, 2024-10-31) | MIT, © three.js authors | Free | Browser 3D rendering. Stored locally, so it works offline and needs no CDN. |
| OrbitControls | from Three.js r170 | MIT | Free | Touch and mouse camera rotate, zoom and pan |
| Web Speech API | built into the browser | — | Free | Speech output and input. No OpenAI or Anthropic keys anywhere. |

Nothing was added to `package.json`. No npm install is needed.

## 4. Launch from Termux

```bash
cd ~/Nexus
npm run dashboard
```

Then open **http://127.0.0.1:4000/character-studio/** in Chrome on the same phone.

Run the tests (any Node 18 or newer):

```bash
cd ~/Nexus
node --test dashboard/public/character-studio/tests/studio.test.mjs
```

## 5. Test results

**Unit tests (Node 22): 26 / 26 pass.** They cover:

- identities, and that the three are not one model recoloured
- every character's skull-top height matches her profile height to within 5 mm
- skeleton joints
- idle, walk, measured arrival, stop, turn
- the 4-waypoint course, collision blocking, stage bounds
- gestures, look-around, look-at, blinking, expressions, jaw
- speech start, end, cancel and no-start reporting
- mouth envelope and voice selection
- NOT CONNECTED with no invented replies; the studio refuses all actions
- handshake rules, and that the status registry can't overstate intelligence features

**Browser tests: 23 / 23 pass.** These ran in headless Chrome at Android phone size (412 × 915, touch), behind a test server sending the dashboard's exact Content-Security-Policy copied from `server.js`. Verified by real taps, drags, wheel and joystick input:

- boots with no errors and no security-policy violations
- chip tap and tapping a body in 3D both select the character
- drag orbits the camera, zoom changes distance
- joystick walks Genesis and releasing it stops her
- Return to pad arrives within 3.7 cm
- About-face completes
- signature gesture and look-around complete
- navigation course: 4/4 waypoints, max error 4 cm, 6.8 s
- tap on floor walks there and arrives
- Talk shows NOT CONNECTED, and a sent message gets no invented reply and no speech
- voice sliders are present
- speech outcome is logged honestly
- Status lists every NOT CONNECTED intelligence

Bugs the tests caught and that are now fixed:

- the tests failed once installed inside the repo, because `dashboard/package.json` declares `commonjs`; fixed with a folder-local `package.json`
- characters were taller than their stated heights (Savannah measured 1.79 m instead of 1.68 m)
- Savannah's hair poked above her head
- a speech line that never started was being logged as "ended"
- braking after releasing the joystick was sluggish

**Not tested on a real Android phone.** Rendering, touch and voices on your actual devices still need your check.

## 6. Android browser compatibility

| Item | Expected on Android Chrome | Tested here? |
|---|---|---|
| 3D rendering (WebGL 2) | Supported on modern Android Chrome | Yes, in desktop Chrome with a software GPU. **Not on your phone.** |
| Touch: orbit, pinch zoom, joystick, tap | Supported | Yes, with emulated touch at phone size |
| Phone quality mode | Auto-selected on touch screens; lower pixel ratio, fewer particles, smaller shadows | Mode switch tested; performance on your phone not measured |
| Speech output | Supported; uses the voices installed on the phone | **No.** The headless browser had 0 voices, so it correctly reported an error rather than pretending to speak. |
| Speech input (microphone) | Supported in Chrome; 127.0.0.1 counts as a secure page | **No.** Needs a real microphone. |
| Other browsers (Firefox Android, Samsung Internet) | 3D likely works; speech input may be missing | Not tested |

## 7. Offline vs internet

| Works fully offline | Needs internet | Depends on the browser |
|---|---|---|
| 3D scene, all three characters, camera, movement, gestures, expressions, status, log, tests | Speech **input** in Chrome (audio goes to Google's servers) | Which voices exist; whether a voice is on-device or network (the Voice tab labels each one); whether the browser reports word timing for mouth movement |
| Speech output with on-device voices | Speech output with network voices | Speech input exists at all |

## 8. Implemented (working, covered by tests)

- Studio scene: NEXUS blue and emerald architecture, colonnade with light strips, halo rings, reflective floor, image-based reflections, energy particles, per-character pads (emerald, purple, pink)
- Character selection by chips, tapping the body, or keys 1, 2 and 3
- Camera: orbit, zoom, pan, full / face / side / back views, orbit-inspect, follow; keeps the character centred in the area the panel doesn't cover
- Idle breathing, weight sway and glances, at each character's own tempo
- Head and neck look-around, look-at-camera, eye direction, blinking
- Turn in place (±45°, about-face, face camera)
- Walking from real controls: joystick, tap-to-walk, WASD/arrows; Space stops
- Measured arrivals, stops, collision blocking and stage bounds; navigation test course
- Voice picker plus pitch, rate and volume per character; preview, speak typed line, stop
- Truthful event log: only measured or received events, never claimed actions
- NOT CONNECTED shown for all three intelligences, with the reason

## 9. Prototype (works, simplified)

- **Characters:** procedural, stylized models. Each has her own proportions, height, face shape, hair build (Genesis swept-up wave and chignon, Savannah shoulder-length waved curtain, Aria high crown and top knot), suit cut (tailored / structured with high collar / flared peplum) and accessories. Rigid segments, no skinned mesh, so joints show seams and the jaw shows a faint line.
- **Walk cycle:** procedural; feet can slide slightly.
- **Gestures:** signatures per character (Genesis explaining, Savannah assessing with folded arms, Aria hand to heart), plus wave and nod.
- **Expressions:** brows, lids and mouth corners only.
- **Mouth movement:** jaw envelope driven by word timing, or a syllable rhythm when the browser gives none. **Not lip-sync.**
- **Speech:** browser voices with adjusted pitch and rate only.

## 10. Placeholder

- Aria's eye colour (studio default warm brown) and Genesis's and Aria's heights (1.70 m and 1.65 m) are studio defaults awaiting your confirmation.
- Aria's greeting line ("Hi. I'm Aria. How are you, really?") is a placeholder. Genesis's and Savannah's greetings are yours.

## 11. Not connected / not started

- **NOT CONNECTED:** Genesis, Savannah and Aria runtimes, and spoken responses from an intelligence. The pipeline exists but nothing produces replies.
- **NOT STARTED:**
  - production models (sculpted, textured, skinned rig)
  - interchangeable wardrobe (required for Savannah)
  - phoneme lip-sync
  - accent voices
  - memory systems

**Accents:** browser voices cannot produce Genesis's 65% North Jersey / 35% Persian blend or Savannah's North Jersey with Kurdish/Persian influence. Both official profiles are stored in full in `profiles.js` and shown in the Voice tab for a future voice engine.

## 12. Boundaries preserved

- No Genesis, Orb, Savannah, Warden, Authority or dashboard file was changed.
- The studio has no authority: adapters refuse every action, make no network calls and call no tools.
- A runtime can only show CONNECTED after a successful handshake that names the right runtime. An Orb handshake for Genesis is rejected.
- Aria having a character does not make her an operational agent. She is not in Warden's `KNOWN_AGENTS`.
- **Flagged for your decision, not changed:** `src/genesis/core/GenesisBrain.ts` routes EVOLVE mode through `runOrb()`, so Genesis currently depends on Orb.
- `window.__studio` is a read-only handle used by the browser tests. It exposes no new authority.

## 13. Next construction steps (each awaits your approval)

1. **Your phone check:** launch in Termux, try all three characters, Voice preview and Listen, and note frame rate and anything that looks wrong.
2. **Confirm placeholders:** Genesis's and Aria's heights, Aria's eye colour, Aria's greeting and her voice direction.
3. **Wardrobe system:** outfits as swappable modules, starting with Savannah (casual, professional, relaxed, formal).
4. **Better models:** decide between sculpting proper rigged models (e.g. Blender, glTF) or continuing to refine the procedural ones.
5. **Voice engine:** evaluate a free on-device speech engine that can be tuned toward the accent profiles. Report honestly whether it gets close.
6. **Genesis independence from Orb:** your decision on `GenesisBrain.ts` before any runtime connection.
7. **Phase 5 connections:** a read-only, Key-Authority-respecting status endpoint first, then conversation, one character at a time.
