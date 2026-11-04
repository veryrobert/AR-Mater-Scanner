export type Point = { x: number; y: number }
export type Marker = { corners: Point[]; center: Point; size: number; score: number; blue: number }
export type CornerMode = 'outer' | 'center' | 'inner'

export function detectMarkers(img: ImageData, opts?: { k?: number; debug?: { x: number; y: number; why: string }[] }): Marker[]
/** Best four markers, ordered TL, TR, BR, BL; null if fewer than four. */
export function selectFour(markers: Marker[]): Marker[] | null
export function boardCorners(four: Marker[], mode: CornerMode): Point[]
/** Width / height of the real rectangle behind the four corners. */
export function estimateAspect(corners: Point[], imgW: number, imgH: number): number
export function homography(src: Point[], dst: Point[]): number[]
export function warp(src: ImageData, corners: Point[], outW: number, outH: number): ImageData
export function enhance(img: ImageData): ImageData
export function inkOnly(img: ImageData): ImageData
export function markerRegionsOut(four: Marker[], scale: number, corners: Point[], outW: number, outH: number, grow?: number): Point[][]
export function rectify(full: ImageData, detectImg: ImageData, scale: number, opts?: { cornerMode?: CornerMode; enhance?: boolean; maxDim?: number }):
  | { ok: false; markers: Marker[] }
  | { ok: true; image: ImageData; corners: Point[]; aspect: number; markers: Marker[]; four: Marker[] }
