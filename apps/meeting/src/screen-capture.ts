/**
 * Grabs one still frame from a live video stream (a shared screen) by playing it in an
 * offscreen video element and painting the first decoded frame onto a canvas.
 */

export interface CaptureOptions {
  maxWidth: number;
  format: 'jpeg' | 'png';
  quality: number;
}

export interface CapturedFrame {
  blob: Blob;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

const FRAME_TIMEOUT_MS = 5_000;

export async function captureVideoFrame(stream: MediaStream, options: CaptureOptions): Promise<CapturedFrame> {
  const track = stream.getVideoTracks().find((candidate) => candidate.readyState === 'live');
  if (!track) throw new Error('The shared screen has no live video track.');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    const firstFrame = waitForFrame(video);
    await Promise.all([video.play(), firstFrame]);
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) throw new Error('The shared screen has not produced a frame yet.');
    const scale = Math.min(1, options.maxWidth / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not draw the shared screen.');
    context.drawImage(video, 0, 0, width, height);
    const mime = options.format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, options.quality));
    if (!blob) throw new Error('The captured frame could not be encoded.');
    return { blob, width, height, sourceWidth, sourceHeight };
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('No frame arrived from the shared screen in time.')), FRAME_TIMEOUT_MS);
    const done = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    const withFrameCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
    if (typeof withFrameCallback.requestVideoFrameCallback === 'function') withFrameCallback.requestVideoFrameCallback(done);
    else video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('error', () => {
      window.clearTimeout(timer);
      reject(new Error('The shared screen could not be played.'));
    }, { once: true });
  });
}
