// Turns whatever the player picked into the one avatar shape the account
// stores: a small square JPEG data URL. Cropping and compression happen here
// in the browser so the server only ever sees a bounded string (the worker
// re-checks the bound in its user-write gate).

export const AVATAR_SIZE = 256;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as an image."));
    };
    img.src = url;
  });
}

/** File → 256×256 center-cropped JPEG data URL, or a throw with a human message. */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Pick an image file.");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("That image is over 8MB — pick a smaller one.");

  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("That image is empty.");

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot process images.");

  // JPEG has no alpha — transparent sources land on the arena charcoal.
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}
