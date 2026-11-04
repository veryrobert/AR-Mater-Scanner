# Change Log

## 2026-11-04 — Steadier, more forgiving marker detection, red outlines
- Markers are held for 10 frames (about 0.6s) after they're last seen, so one missed frame no longer drops the count or flickers
- Live detection runs at 640px instead of 480px, so smaller or further-away markers are found
- Each marker the camera finds gets a red outline (new `--marker` token)
- A marker whose inner shape touches the square is now accepted, if there's a clear gap elsewhere
- Looser outline checks for wobbly, rounded or slightly broken hand-drawn squares

## 2026-11-04 — mater scanner to main
- Corner-marker scanner: live camera overlay finds the four square markers, captures and rectifies the page
- Rebuilt on the starter template (React, Vite, shadcn shell), dimming everything outside the capture area
- Ink view removes paper, shadows and markers; Text view transcribes with the Claude API using the viewer's own key
- Export ink as PNG (white or clear), text as .txt, or the index thumbnail
- Export can email the scan (share sheet, or a mailto draft)
- Named mater, served from mater.robertfarrelly.com; README covers markers and files

## 2026-10-18 — Thumbnail export
- Export saves an index thumbnail: 1600 × 1000 (16:10), the work centred on black
