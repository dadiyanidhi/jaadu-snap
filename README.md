# Jaadu Snap

Magic gestures for your video calls. 🫰

| Gesture | Effect |
| --- | --- |
| Snap | You turn to dust, Endgame style, and the empty room shows where you were. Snap again to come back |
| Snap twice | It rains cash |
| Both hands up | Absolute cinema |
| Facepalm | The room goes gloomy, thunder flashes, and a storm cloud rains on you |

No green screen, no editing, no virtual-camera app. The effects are drawn into your camera feed, so everyone in the call sees them live. Everything runs on your computer.

![Dust, cash rain and absolute cinema on Chrome's test camera](docs/effects.png)

## Where it works

Any video call that runs in Chrome (or another Chromium browser):

- Google Meet
- Microsoft Teams in the browser
- Zoom's web client (choose **Join from your browser**)
- FaceTime links opened in Chrome, Whereby, Discord in the browser, and other web calls

It works by changing the camera feed inside a browser tab, so it can't reach desktop or phone apps (the Zoom, Teams or FaceTime apps, or WhatsApp on a phone). Join from the browser to use it.

## Install

1. Download this repo: **Code → Download ZIP**, then unzip it somewhere permanent (not Downloads, which gets cleaned up). Or `git clone` it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Pin the extension, then reload any open call tabs.

Works in Chrome and other Chromium browsers (Edge, Brave, Arc). It needs Chrome 94 or newer.

## Use it

Join a call with your camera on and keep the camera still for about 10 seconds while the extension loads hand tracking and learns your room. The popup says **Ready** when it's done.

- **Snap:** raise your hand to face or chest height, palm toward the camera, press your thumb and middle finger together, and snap. You turn to dust and stay gone. Snap again any time, even while the dust is still flying, and it flies back together.
- **Double snap:** two snaps within about two-thirds of a second. A single snap waits that long before it fires, in case a second one is coming. If you turn off double snap, single snaps fire instantly.
- **Absolute cinema:** both hands up at your sides, palms open, fingers up. Hold for half a second. It lasts as long as you hold the pose.
- **Facepalm:** cover your face with an open palm for half a second.

Every effect has a **Test** button in the popup and a keyboard shortcut in the call tab: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>1</kbd> vanish/return, <kbd>2</kbd> cash, <kbd>3</kbd> cinema, <kbd>4</kbd> rain.

### How snaps are detected

A snap is too fast for the camera alone: the click happens between two video frames. So the extension listens to your mic for the snap's sharp click and only counts it if, at the same moment, the camera sees a real snap:

- the hand has been in view for a moment (a hand coming into frame often looks pinched for a frame or two)
- thumb and middle finger were pressed together
- the middle finger slams into the palm (or flies away from the thumb and lands there), and is still there a frame later

Raising or waving a hand, typing, claps, beeps and holding a pen don't trigger it.

The mic is only used if the call already has mic access, so the extension never causes a mic permission prompt. The audio is analysed on your computer for loudness spikes and never recorded or sent anywhere. Without the mic (or with **Use snap sound to confirm** turned off), it falls back to camera-only detection, which misses more snaps.

### The empty room

When you vanish, the extension paints the room behind you over where you are. It builds that picture from what the camera sees around you, keeping a safe margin from your outline so no part of you ends up in it. The part it has never seen (right behind you) is filled with a smooth blend of the surrounding wall plus matching grain, and [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN), an AI inpainting model running locally, continues textures in from the edges.

- On a plain wall this looks like you were never there. In a busy room (shelves, posters), the spot behind you comes out soft and blurry, because nothing can know what's there.
- For a perfect result in any room, click **Capture empty room** and step out of frame for about 5 seconds.
- **Keep the camera still.** If you move it, click **Relearn room**.

### Customize

- Change the cinema and facepalm captions.
- Turn on **Show detection overlay** to see the hand landmarks, mic levels and snap measurements. This is handy for tuning **Snap sensitivity**.

## Good to know

- Most call apps mirror your self-view, so captions look backwards to you. Everyone else sees them the right way round.
- Effects are only visible to others while your camera is on. Your mic audio in the call is untouched; the extension opens its own copy of the mic just to hear snaps.
- Snap detection relies on the camera seeing your hand clearly. Good lighting and a hand that isn't cut off by the frame edge help a lot.
- If the call app's own background effects (blur, virtual backgrounds) are on, they're applied on top of the extension's output.

## Tech stack

Plain JavaScript in a Chrome extension (Manifest V3). There's no framework, no build step, no server, and no cloud AI service: every model runs inside your browser.

| Part | What does it |
| --- | --- |
| Hand, face and person detection | [MediaPipe](https://ai.google.dev/edge/mediapipe) Tasks Vision (Google), WebAssembly + WebGL |
| Filling in the room behind you | [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) inpainting model (Picsart) on [ONNX Runtime Web](https://onnxruntime.ai/) (Microsoft), WebAssembly |
| Live video processing | The browser's `MediaStreamTrackProcessor` / `MediaStreamTrackGenerator` (insertable streams) and `OffscreenCanvas` |
| Effects | Canvas 2D |
| Snap sound | Web Audio API (high-pass filter + analyser) |

All libraries and models are bundled in `vendor/` and `models/`, because Manifest V3 extensions can't load remote code. To update them, run `npm run update-vendor`.

## How it works with live video

```
camera ──► getUserMedia (patched in the page)
            │
            ├─► every frame: draw to canvas + active effect ──► processed track ──► the call
            │
            └─► downscaled frame ──postMessage──► hidden extension iframe
                                                   MediaPipe: hands, face, person mask
                                    ◄── landmarks + mask ──┘   MI-GAN (worker): room fill
mic ──► high-pass analyser ──► snap clicks ──┘
```

1. When the call site asks Chrome for your camera, the extension's script hands it a replacement video track instead of the raw camera.
2. Every camera frame (about 30 a second) is drawn onto a canvas, the active effect is painted on top, and the result goes out as the next frame of that track. The call sends it to everyone like any camera.
3. About 15–20 times a second, a small 320 px copy of the frame goes to a hidden extension page, where MediaPipe finds your hands, face and outline. Only landmarks and a small mask come back.
4. In the background, the extension builds a picture of the empty room from the parts of the frame you're not covering, and MI-GAN fills in the rest every 15 seconds in a worker, so it never stalls the video.
5. A separate copy of the mic goes through a high-pass filter; a sharp click within 0.4 s of the camera seeing a snap counts as one.

The files:

- `src/camera.js` runs in the call page. It wraps `navigator.mediaDevices.getUserMedia` and rebuilds the video track, which keeps running when the tab is in the background. Some apps (Meet) keep several clones of the camera track and stop the originals, so the real camera only stops once every clone is stopped, and one person mask and room picture are shared across all clones.
- `detector/` is an extension page loaded in a hidden iframe. Many call sites enforce Trusted Types, which blocks MediaPipe's WASM loader in the page itself, so inference runs in the extension's own origin.
- `src/gestures.js` turns landmarks into snap, double snap, cinema and facepalm events. It's plain JS with tests: `npm test`.
- `src/effects.js` draws the four effects.
- `src/bridge.js` passes settings and popup buttons between the extension and the page.

## Is it safe?

- **Nothing leaves your computer.** There are no servers, analytics, accounts or network requests. Video only goes out through your call app, exactly as it would without the extension.
- **Minimal permissions.** It only asks for `storage`, to keep your settings. Because it has to work on any call site, Chrome warns that it can "read and change your data on all websites". In practice it only wraps the camera function, and until a site turns on your camera it does nothing else.
- **Mic.** It only listens where the call already has mic access, measures loudness spikes, and never records or stores audio.
- **No remote code.** Every library and model is in this repo, so what you read here is exactly what runs.
- **Open source.** You can read every line, and load it straight from this folder instead of trusting a download.

## Development

```sh
npm test            # gesture logic tests (Node 18+)
npm run package     # dist/jaadu-snap-<version>.zip for the Chrome Web Store
```

After editing, click the reload icon on the extension in `chrome://extensions` and refresh the call tab.

## Credits

Hand tracking and segmentation by [MediaPipe](https://ai.google.dev/edge/mediapipe), room inpainting by [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) on [ONNX Runtime Web](https://onnxruntime.ai/). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Not affiliated with Google, Microsoft, Zoom, Apple or Marvel.

## License

[MIT](LICENSE)
