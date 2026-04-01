/**
 * Docker image pull manager with progress tracking.
 * Spawns `docker pull`, parses JSON output, and emits progress events.
 */

export interface PullProgress {
  status: string;
  layer?: string;
  percent?: number;
  message?: string;
}

interface CachedImage {
  image: string;
  pulledAt: number;
}

const IMAGE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const cachedImages = new Map<string, CachedImage>();

/** Check if an image was recently pulled and is likely available locally. */
export function isImageCached(image: string): boolean {
  const cached = cachedImages.get(image);
  if (!cached) return false;
  if (Date.now() - cached.pulledAt > IMAGE_CACHE_TTL_MS) {
    cachedImages.delete(image);
    return false;
  }
  return true;
}

/** Check if an image exists locally via `docker image inspect`. */
export async function imageExistsLocally(image: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "image", "inspect", image], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      cachedImages.set(image, { image, pulledAt: Date.now() });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Pull a Docker image with progress reporting.
 * @param image Docker image to pull (e.g. "campfire-dev:latest")
 * @param onProgress Callback for progress updates
 * @param timeout Maximum time to wait in ms (default 5 minutes)
 * @returns true if pull succeeded
 */
export async function pullImage(
  image: string,
  onProgress?: (progress: PullProgress) => void,
  timeout: number = 5 * 60 * 1000,
): Promise<boolean> {
  // Skip if recently pulled
  if (isImageCached(image)) {
    onProgress?.({ status: "cached", message: "Image already available" });
    return true;
  }

  // Check locally first
  if (await imageExistsLocally(image)) {
    onProgress?.({ status: "exists", message: "Image found locally" });
    return true;
  }

  onProgress?.({ status: "pulling", message: `Pulling ${image}...` });

  return new Promise<boolean>((resolve) => {
    const proc = Bun.spawn(["docker", "pull", image], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      onProgress?.({ status: "timeout", message: "Image pull timed out" });
      resolve(false);
    }, timeout);

    // Read stdout for progress
    const reader = proc.stdout?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = "";

      function pump() {
        reader!.read().then(({ done, value }) => {
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          // Parse line-by-line
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              const progress: PullProgress = {
                status: data.status || "pulling",
                layer: data.id,
              };
              if (data.progressDetail?.current && data.progressDetail?.total) {
                progress.percent = Math.round(
                  (data.progressDetail.current / data.progressDetail.total) * 100,
                );
              }
              if (data.progress) {
                progress.message = data.progress;
              }
              onProgress?.(progress);
            } catch {
              // Not JSON, just report as status
              onProgress?.({ status: "pulling", message: line.trim() });
            }
          }
          pump();
        }).catch(() => {});
      }
      pump();
    }

    proc.exited.then((exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        cachedImages.set(image, { image, pulledAt: Date.now() });
        onProgress?.({ status: "complete", message: "Image pulled successfully" });
        resolve(true);
      } else {
        onProgress?.({ status: "error", message: `Pull failed with exit code ${exitCode}` });
        resolve(false);
      }
    }).catch(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
