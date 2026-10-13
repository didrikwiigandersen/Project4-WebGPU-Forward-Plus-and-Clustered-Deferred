import { context, device, canvas, canvasFormat } from './renderer';

export async function readBuffer(buffer: GPUBuffer, size = buffer.size): Promise<ArrayBuffer> {
    const copySize = Math.ceil(size / 4) * 4;
    const copy = device.createBuffer({
        label: 'Validation buffer readback',
        size: copySize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    let mapped = false;
    try {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, copy, 0, copySize);
        device.queue.submit([encoder.finish()]);
        await copy.mapAsync(GPUMapMode.READ);
        mapped = true;
        return copy.getMappedRange().slice(0, size);
    } finally {
        if (mapped) {
            try {
                copy.unmap();
            } finally {
                copy.destroy();
            }
        } else {
            copy.destroy();
        }
    }
}

export async function readTexture(
    texture: GPUTexture,
    bytesPerPixel: number,
    aspect: GPUTextureAspect = 'all',
): Promise<Uint8Array> {
    const unpaddedBytesPerRow = texture.width * bytesPerPixel;
    const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
    const copy = device.createBuffer({
        label: 'Validation texture readback',
        size: bytesPerRow * texture.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    let mapped = false;
    try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture, aspect },
            { buffer: copy, bytesPerRow, rowsPerImage: texture.height },
            [texture.width, texture.height],
        );
        device.queue.submit([encoder.finish()]);
        await copy.mapAsync(GPUMapMode.READ);
        mapped = true;

        const source = new Uint8Array(copy.getMappedRange());
        const packed = new Uint8Array(unpaddedBytesPerRow * texture.height);
        for (let row = 0; row < texture.height; row++) {
            const sourceOffset = row * bytesPerRow;
            const destinationOffset = row * unpaddedBytesPerRow;
            packed.set(
                source.subarray(sourceOffset, sourceOffset + unpaddedBytesPerRow),
                destinationOffset,
            );
        }
        return packed;
    } finally {
        if (mapped) {
            try {
                copy.unmap();
            } finally {
                copy.destroy();
            }
        } else {
            copy.destroy();
        }
    }
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
        for (let i = 0; i < bytes.length; i += 4) {
            const red = bytes[i];
            bytes[i] = bytes[i + 2];
            bytes[i + 2] = red;
        }
    }
    return bytes;
}

export async function pngBlob(
    bytes: Uint8Array,
    width = canvas.width,
    height = canvas.height,
): Promise<Blob> {
    const image = document.createElement('canvas');
    image.width = width;
    image.height = height;
    const drawing = image.getContext('2d');
    if (!drawing) throw new Error('PNG encoding requires a 2D canvas context.');
    drawing.putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
    return new Promise((resolve, reject) => image.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')),
        'image/png',
    ));
}
