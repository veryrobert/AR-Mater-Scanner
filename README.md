# AR Marker Scanner

Phone-camera prototype that finds the four corner markers (a thick black square frame with a black glyph inside, on a blue sticky note), shows them live as an AR overlay, takes a photo and straightens it.

Everything runs on the device in plain JavaScript, with no libraries and no server.

## Use it on your phone

Browsers only allow camera access on HTTPS pages, so host it with GitHub Pages:

1. Repo **Settings → Pages → Build and deployment → Deploy from a branch**, then pick this branch and `/ (root)`.
2. Open `https://<user>.github.io/<repo>/` on your phone and allow camera access.

Without camera access, **Photo** lets you take or choose a picture, and it gets straightened the same way.

## Controls

- **Live view**: markers are outlined (green means it's one of the 4 in use). The dots show how many were found. The shutter turns green when all 4 are visible.
- **Auto**: takes the photo by itself once the markers have stayed still for about a second.
- **Crop to**: crop at the markers' outer corners, their centres, or their inner corners.
- **Clean**: evens out the lighting so the paper comes out white.
- **Save image**: opens the phone's share sheet (Save to Photos, etc.), or downloads the file.

## How it works (`scanner.js`)

1. Grayscale, then an adaptive threshold using the local mean from an integral image.
2. Connected components of dark pixels.
3. For each component, fit a convex hull and then a quadrilateral. Keep it only if it's a square-ish **ring** with a solid border, a light gap and a dark glyph in the middle. A blue backing raises its score.
4. Pick the best 4 that form a convex layout and order them TL, TR, BR, BL.
5. Estimate the real aspect ratio from the perspective (Zhang & He whiteboard method, with fallback to the side lengths), then warp with a homography and bilinear sampling.

Run locally with `python3 -m http.server` and open `http://localhost:8000`. Camera access works on localhost.
