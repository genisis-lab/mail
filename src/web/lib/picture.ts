/**
 * A profile picture is cropped to a square and shrunk on the device before it's
 * uploaded: a phone photo is several MB, the picture needs a few KB.
 */
export async function squarePicture(file: File, size = 256): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('That file isn’t a picture Wren can read. Try a JPEG or PNG.');
    }
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx || !side) throw new Error('Couldn’t prepare the picture');
    // Transparent parts would turn black as JPEG.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t prepare the picture'))), 'image/jpeg', 0.9));
  } finally {
    URL.revokeObjectURL(url);
  }
}
