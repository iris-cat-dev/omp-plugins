// Adapted from OpenAGI js/flow-canvas.js (screenToWorld, fitView, linkD)
// and js/editor.js (edZoomAt). See LICENSE.openagi.
export interface Point { x: number; y: number }
export interface Viewport extends Point { zoom: number }
export interface Rect extends Point { width: number; height: number }
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.2;
export const MIN_IMAGE_WIDTH = 96;
export const MAX_IMAGE_WIDTH = 1200;

export function resizeImageWidth(width: number, aspectRatio: number, dx: number, dy: number): number {
  // Project the drag onto the corner's diagonal to preserve the aspect ratio.
  const slope = 1 / aspectRatio;
  return Math.round(Math.max(MIN_IMAGE_WIDTH, Math.min(MAX_IMAGE_WIDTH, width + (dx + dy * slope) / (1 + slope * slope))));
}

export function screenToWorld(point: Point, view: Viewport): Point {
  return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}

export function zoomAt(point: Point, view: Viewport, scale: number): Viewport {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
  if (zoom === view.zoom) return view;
  const world = screenToWorld(point, view);
  return { x: point.x - world.x * zoom, y: point.y - world.y * zoom, zoom };
}

export function fitView(boxes: readonly Rect[], width: number, height: number): Viewport {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  const w = right - left, h = bottom - top;
  const zoom = Math.max(MIN_ZOOM, Math.min(1.1, (width - 96) / w, (height - 96) / h));
  return { x: (width - w * zoom) / 2 - left * zoom, y: (height - h * zoom) / 2 - top * zoom, zoom };
}

export function linkD(a: Point, b: Point): string {
  const dx = Math.max(42, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
