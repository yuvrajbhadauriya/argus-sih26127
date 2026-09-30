// Snapshot of the current video frame (+ detection overlay) as a PNG download.

/** Draws the video frame and, if given, the overlay canvas scaled on top. Returns a PNG data URL. */
export function composeSnapshot(video: HTMLVideoElement, overlay?: HTMLCanvasElement | null): string {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h || video.readyState < 2) throw new Error('The feed has no frame to capture yet.');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.drawImage(video, 0, 0, w, h);
  if (overlay && overlay.width && overlay.height) ctx.drawImage(overlay, 0, 0, w, h);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    throw new Error('The video is served from another origin without CORS headers, so the frame cannot be exported.');
  }
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "VP-01_2026-09-30_15-04-05.png" (IST wall time). */
export function snapshotFilename(code: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${code}_${get('year')}-${get('month')}-${get('day')}_${get('hour')}-${get('minute')}-${get('second')}.png`;
}
