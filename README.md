# feeling free

An open-world bike ride in the browser. Pedal across a windy meadow of grass and white flowers, under an indigo cliff with a walled slope, toward a huge white city with a see-through arch. Catch air off the crests, find the twelve paper lanterns, and ride in through the city gate.

**Play:** https://arjunkshah12345-hash.github.io/feeling-free/

## Controls

| Key | Action |
| --- | --- |
| W | pedal |
| A / D | steer |
| Space | jump |
| Shift | sprint |
| S | brake |
| C | switch camera |
| M | sound on/off |
| R | back to start |
| Esc / P | pause |

Drag the mouse to look around. On phones there's a touch stick plus pedal and jump buttons.

## Run locally

There is no build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

## How it's made

Plain JavaScript on [Three.js](https://threejs.org) (r187, vendored in `vendor/`), with no bundler.

- `src/world.js`: the layout, and the height field shared by the terrain, physics and grass
- `src/grass.js`: about 118k instanced grass blades that stay anchored in world space, with wind and a push-away around the rider
- `src/city.js`, `src/sky.js`: the white city (modelled at one size, then scaled up about the keep), the sky and distant mountains
- `src/player.js`: fixed-step bike physics (leaning, airtime over crests, jumps, collisions)
- `src/rider.js`: the kid (tapered limbs, swept hair locks, rim-lit clothes) and the bike, posed with IK, plus a Verlet-cloth cape that reacts to wind and speed
- `src/cliff.js`: the striated cliff (shader bump detail), the castle wall, its turrets, and the baked wall-top heights used for the long wall shadows across the meadow
- `src/post.js`: bloom, speed blur that keeps the rider sharp, ACES tone mapping and color grade
- `src/music.js`: the soundtrack, a piece in D major for felt piano, strings, flute, bass and brushed drums, synthesised live in WebAudio with a generated hall reverb; layers come in as you ride faster
- `src/audio.js`: wind, freewheel ticks, landing thumps and lantern chimes

There are no audio or image assets: everything is generated in code. `window.__ff` in the console exposes the scene, player and camera if you want to poke around.

## License

MIT. See [LICENSE](LICENSE). Three.js is MIT licensed by the Three.js authors.
