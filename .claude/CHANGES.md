# Change Log

## 2026-11-04 — mater scanner to main
- Corner-marker scanner: live camera overlay finds the four square markers, captures and rectifies the page
- Rebuilt on the starter template (React, Vite, shadcn shell), dimming everything outside the capture area
- Ink view removes paper, shadows and markers; Text view transcribes with the Claude API using the viewer's own key
- Export ink as PNG (white or clear), text as .txt, or the index thumbnail
- Export can email the scan (share sheet, or a mailto draft)
- Named mater, served from mater.robertfarrelly.com; README covers markers and files

## 2026-10-18 — Thumbnail export
- Export saves an index thumbnail: 1600 × 1000 (16:10), the work centred on black

## 2026-10-18 — Shared panels, icons, order and Format
- Top right is places, the bottom is actions; Export leaves the toolbar
- Canvas panel with the shared Format list (formats.ts: 1:1, 4:5, 9:16, 16:9, A4), starting on 4:5; Design gets the shapes icon
- CLAUDE.md: panel order, one meaning per icon, Format and File, toolbar order
