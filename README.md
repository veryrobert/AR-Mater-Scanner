# scanner

Point your phone at a board marked with the four corner markers (a black square frame with a black glyph inside, on a blue sticky note). The app shows the markers live, takes the photo, straightens it, and gives back:

- **Ink**: just the handwriting. The paper, shadows and the markers themselves are removed.
- **Text**: a transcription of the writing, from Claude.

Built on `veryrobert/starter`: React, Vite, Tailwind, shadcn. Style rules are in `CLAUDE.md`.

## Use

- **Capture**: available once all 4 markers are found. **Your photo** straightens an existing picture instead.
- **Scan**: choose where to crop (the markers' outer corners, their centres or their inner corners) and turn on auto capture, which takes the photo once the markers have stayed still.
- **Settings**: your Claude API key. The key is stored only in this browser and sent straight to the Claude API.
- **Export**: save the ink as a PNG (white or transparent background), the text as a .txt file, or the index thumbnail.

## Run

```bash
npm install
npm run dev
```

Phones only allow camera access over HTTPS. The Pages workflow deploys from `main`: set Pages → Source to **GitHub Actions**, and point the `public/CNAME` subdomain (`scan.materlabs.ie`) at `veryrobert.github.io`.

## How it works

`src/lib/scanner.js` is plain JavaScript and runs entirely on the device:

1. Adaptive threshold, then connected components of the dark pixels.
2. For each component, fit a convex hull and then a quadrilateral. It counts as a marker only if it is a square ring with a solid border, a light gap and a dark glyph in the middle. A blue backing raises its score.
3. Pick the best 4, ordered TL, TR, BR, BL.
4. Estimate the board's true aspect ratio from the perspective (Zhang & He's whiteboard method), then warp it straight with a homography.
5. For the ink view: even out the lighting, turn the paper transparent, and cut out each marker and its sticky note.

`src/lib/transcribe.ts` sends the straightened photo to `claude-opus-5-5` and streams the text back.
