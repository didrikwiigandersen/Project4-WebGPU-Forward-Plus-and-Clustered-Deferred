import { context, device, canvas, canvasFormat } from './renderer';
export async function readBuffer(buffer: GPUBuffer, size = buffer.size): Promise<ArrayBuffer> {
    const copy = device.createBuffer({ label: 'Validation buffer readback', size: Math.ceil(size / 4) * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, copy, 0, Math.ceil(size / 4) * 4);
    device.queue.submit([encoder.finish()]);
    await copy.mapAsync(GPUMapMode.READ);
    const result = copy.getMappedRange().slice(0, size);
    copy.unmap(); copy.destroy();
    return result;
}
export async function readTexture(texture: GPUTexture, bytesPerPixel: number, aspect: GPUTextureAspect = 'all'): Promise<Uint8Array> {
    const row = Math.ceil(texture.width * bytesPerPixel / 256) * 256;
    const copy = device.createBuffer({ label: 'Validation texture readback', size: row * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture, aspect }, { buffer: copy, bytesPerRow: row, rowsPerImage: texture.height }, [texture.width, texture.height]);
    device.queue.submit([encoder.finish()]);
    await copy.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(copy.getMappedRange());
    const packed = new Uint8Array(texture.width * texture.height * bytesPerPixel);
    for (let y = 0; y < texture.height; y++) packed.set(source.subarray(y * row, y * row + texture.width * bytesPerPixel), y * texture.width * bytesPerPixel);
    copy.unmap(); copy.destroy();
    return packed;
}
export function halfToFloat(value: number): number {
    const sign = value & 0x8000 ? -1 : 1;
    const exponent = (value >>> 10) & 31;
    const mantissa = value & 1023;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
export async function readHDR(texture: GPUTexture): Promise<Float32Array> {
    const bytes = await readTexture(texture, 8);
    const words = new Uint16Array(bytes.buffer);
    const values = new Float32Array(words.length);
    for (let i = 0; i < words.length; i++) values[i] = halfToFloat(words[i]);
    return values;
}
export async function canvasPixels(): Promise<Uint8Array> {
    const texture = context.getCurrentTexture();
    const bytes = await readTexture(texture, 4);
    if (canvasFormat.startsWith('bgra')) {
        for (let i = 0; i < bytes.length; i += 4) { const r = bytes[i]; bytes[i] = bytes[i + 2]; bytes[i + 2] = r; }
    }
    return bytes;
}
export async function pngBlob(bytes: Uint8Array, width = canvas.width, height = canvas.height): Promise<Blob> {
    const image = document.createElement('canvas'); image.width = width; image.height = height;
    const drawing = image.getContext('2d')!;
    drawing.putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
    return new Promise((resolve, reject) => image.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'));
}
