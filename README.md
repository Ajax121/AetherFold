# AetherFold

**Shape the light. Let it sing.**

AetherFold is an interactive visual instrument for turning images into clear,
continuous kaleidoscopic compositions. One gesture bends a responsive 3D field
and performs ambient, microtonal sound at the same time.

**[Open the live app →](https://ajax121.github.io/AetherFold/)**

It runs entirely in the browser: image processing, WebGL2 rendering, and Web
Audio synthesis stay on the visitor's device. No account or server-side upload
is required.

![AetherFold desktop interface with a radial image composition, source preview, and live controls](artifacts/aetherfold-desktop.png)

*Desktop experience: a single source image reflected into a continuous radial
motif, with its connection anchor and composition controls visible.*

## Highlights

- **Image-led composition.** Upload an image or pick a bundled study. Automatic
  focal analysis proposes an anchor; you can place it precisely, then tune crop,
  rotation, and optional background removal. At Geometry morph `0`, source
  colours remain unaltered.
- **Five seamless symmetry modes.** Connected mirror, square lattice, diamond
  lattice, triangle prism, and radial flower share image coordinates at their
  reflection seams. A seam overlay makes joins easy to inspect.
- **Real-time spatial visuals.** Blend the image into a raymarched gyroid field.
  Pointer energy and pinch bring in parallax, depth, and glow, while an idle
  composition stays legible. Light, Balanced, and Fine detail quality tiers keep
  performance practical on a range of devices.
- **Gesture-controlled sound.** A single pointer, touch, or optional hand-tracked
  gesture controls spatial deformation and a polyphonic Web Audio instrument.
  Choose pentatonic, just-intonation, or microtonal harmonies; position shapes
  register, filter, and stereo field, while movement and pinch shape articulation
  and space.
- **Performance controls.** Switch atmosphere presets, folds, geometry amount,
  warp, image coverage, quality, volume, pause/resume, mute, and fullscreen.
  The interface reports live FPS.
- **Portable scenes.** Save a composition as JSON with its source image embedded,
  then load it later on another device. The current scene is also remembered
  locally in the browser when storage is available.

## Start playing

1. Open the **[live app](https://ajax121.github.io/AetherFold/)** in a current
   desktop or mobile browser with WebGL2.
2. Choose **Enter with sound** to start the audio engine from a user gesture, or
   **Explore silently** to begin with visuals only.
3. Move over the stage; drag with a pointer or squeeze with two touch points to
   deepen the spatial field.
4. Upload an image or select a sample. In the source preview, drag the anchor to
   choose the point where reflections meet, then adjust Crop scale and Layout
   rotation.
5. Set Geometry morph to `0` to inspect the pure image composition. Raise it to
   introduce the responsive 3D field, then choose an atmosphere and tuning.

Sound and camera access are always opt-in. Uploaded images are decoded and
processed in the browser; they are not sent to an AetherFold server.

**_For the best experience, use a desktop or laptop with a recent browser. It has
more room for the controls and more graphics and audio power for the live image
and sound._**

## Mobile preview

<p align="center">
  <img src="artifacts/aetherfold-mobile.png" width="320" alt="AetherFold mobile interface with the reflected artwork above a collapsible source and composition panel">
</p>

*Touch controls and a collapsible panel keep the artwork and source editor
accessible on smaller screens.*

## Controls

| Interaction | Effect |
| --- | --- |
| Move across the stage | Steer visual warp, pitch/register, filter, and stereo position |
| Hold and drag / squeeze two touch points | Increase pinch deformation and spatial effects |
| Drag in the source preview | Place the image connection anchor |
| Scroll over the source preview | Adjust crop scale |
| `Space` | Pause or resume motion |
| `↑` / `↓` | Change fold count in lattice and radial modes |
| `M` | Enable or mute sound |
| `R` | Restore the default scene |

Stage shortcuts apply only when an editor or form control is not focused. The
source preview also supports arrow keys to move its anchor and `+` / `-` to
change crop scale. Connected mirror uses fixed axes, so its fold count is not
adjustable.

## Requirements and privacy

- A current browser with **WebGL2** is required for the full renderer. The app
  displays a clear status message and uses a simpler mirror fallback when the
  full shader cannot compile.
- Web Audio must be started from a click or tap, as required by browsers. You
  can always use the visual instrument silently.
- Hand tracking is optional. It requests the camera only after you select
  **Enable hand tracking**, runs inference locally, and returns to pointer mode
  if a camera or model is unavailable. HTTPS is required for camera use outside
  localhost.
- Sample images ship with the app. Your own images and saved scene files stay
  local unless you independently share them.

## Run locally

Use Python 3.11 or newer and a browser with WebGL2 support:

```bash
python3 main.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The browser app needs no
npm installation, Python packages, or build step for local use.

The initial composition uses **Vision Study 02** with the **Velvet Void**
atmosphere, triangle symmetry, four folds, a 45° layout rotation, high render
quality, pentatonic tuning, and the saved source anchor from the reference scene.

Uploaded images are processed in your browser. Camera access starts only when
you enable it; tracking runs on your device and downloads its library and model
on demand. Pointer mode and the generated starter work without that download.

## Run with Docker

Start Docker Desktop (or Docker Engine with Compose), then run:

```bash
docker compose up --build -d
```

Open [http://localhost:8080](http://localhost:8080). Docker builds the static
site and serves it with Nginx; Python, Node.js and a GPU are not required on the
server at runtime. Rendering, audio and image processing run in the visitor's
browser. Camera tracking still downloads its model when enabled.

```bash
docker compose ps          # Container and health status
docker compose logs -f app # Server logs
docker compose down       # Stop and remove this app's container
```

To use another local port:

```bash
AETHERFOLD_PORT=8090 docker compose up --build -d
```

Or build and run the image without Compose:

```bash
docker build -t aetherfold:local .
docker run --rm -p 127.0.0.1:8080:8080 --read-only \
  --tmpfs /tmp:size=32m,mode=1777 aetherfold:local
```

The image runs as a non-root user, exposes port `8080`. The build context includes only the app's required source.

Compose binds to localhost by default. To make the service reachable on a
server's network interfaces, set `AETHERFOLD_BIND_HOST=0.0.0.0`. For public
hosting, route HTTPS traffic from your hosting platform or reverse proxy to
container port `8080`; camera access requires HTTPS outside localhost.
Building an image does not publish it or deploy the app.

The sample-image requirement in [Build a static site](#build-a-static-site)
also applies to Docker builds from a fresh clone.

## How it works

One shared interaction state carries position, movement energy, pinch, and depth
to both engines. WebGL2 renders the reflected image and 3D field; Web Audio
synthesizes the chords and effects. Optional MediaPipe tracking supplies the
same controls from a webcam.

| Component | Source |
| --- | --- |
| Image loading, focal analysis, and anchor editor | [image-source.js](web/image-source.js) |
| Symmetry and raymarched geometry | [renderer.js](web/renderer.js), [shaders.js](web/shaders.js) |
| Pointer, touch, and hand tracking | [input.js](web/input.js) |
| Chords, tuning, and audio effects | [audio.js](web/audio.js) |
| Live interface and integration | [index.html](web/index.html), [styles.css](web/styles.css), [app.js](web/app.js) |
| Presets and scene validation | [state.js](web/state.js) |

The renderer handles context loss and restoration, caps render allocation, and
keeps the animation loop at a 60 FPS target. Exact frame rate depends on the
device, image size, browser, and selected quality tier.

## Build a static site

With Node.js installed:

```bash
npm run build
```

The command prints a new `dist/site-*` directory containing the browser app,
its selected sample images, and a `.nojekyll` file. Serve or publish that directory
as a static site. Asset paths support hosting under a subdirectory.


## Development checks

The browser check uses headless Chrome and saves the desktop and mobile
screenshots in `artifacts/`.

The earlier Python rendering experiment is still available separately:

```bash
uv run python test_fold.py images
```

## Current limits

- You can save and load scenes, but exporting finished images, videos, or loops
  is not available yet.
- The app can suggest a good starting point in an image, but it cannot always
  tell what the main subject is. Move the anchor yourself for the best result.
- Hand tracking and sound can feel different on each phone, camera, speaker, or
  browser. The app is tested for reliable startup and fallbacks, but real-device
  testing is still needed to fine-tune responsiveness and sound quality.

