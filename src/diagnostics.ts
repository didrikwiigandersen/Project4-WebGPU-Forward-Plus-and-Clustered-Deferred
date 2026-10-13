import type { ProjectApp } from './app_api';
import { flatten, multiplyPoint, sliceIndex } from './cluster_math';
import { readBuffer, readTexture } from './gpu_io';
import { settings } from './settings';
import { Camera } from './stage/camera';

interface DiagnosticRendererResources {
    depthTexture?: GPUTexture;
    activeMaskBuffer?: GPUBuffer;
}

export interface ClusterDiagnostics {
    renderer: string;
    settingsMode: string;
    depthMode: 'off' | 'prepass' | 'culling';
    clusterGrid: string;
    clusterDimensions: [number, number, number];
    capacity: number;
    clusteringUsed: boolean;
    totalClusters: number;
    clusterRecordStrideBytes: number;
    logicalClusterBufferBytes: number;
    flagsBytes: number;
    activeMaskAllocated: boolean;
    activeMaskCullingEnabled: boolean;
    activeClusters: number;
    activeClusterFraction: number;
    overflowClusters: number | null;
    overflowClusterFraction: number | null;
    maxCount: number | null;
    meanListed: number | null;
    depthReadbackAvailable: boolean;
    depthFormat: string | null;
    depthWidth: number | null;
    depthHeight: number | null;
    visiblePixelCount: number | null;
    invalidDepthPixelCount: number | null;
    overflowVisiblePixels: number | null;
    overflowVisibleFraction: number | null;
}

/**
 * Reads a stable, already-rendered frame. The caller is responsible for pausing
 * rendering before collection so the GPU resources do not change mid-readback.
 */
export async function collectDiagnostics(app: ProjectApp): Promise<ClusterDiagnostics> {
    // Snapshot every CPU-side value before starting asynchronous GPU readbacks.
    const renderer = app.renderer;
    const rendererName = renderer.constructor.name || 'Renderer';
    const settingsMode = String(settings.mode);
    const depthMode = settings.depthMode;
    const clusterGrid = String(settings.clusterGrid);
    const dimensions = [...app.lights.clusterDimensions] as [number, number, number];
    const totalClusters = app.lights.clusterCount;
    const capacity = app.lights.capacity;
    const clusterRecordWords = 2 + capacity;
    const clusterRecordStrideBytes = clusterRecordWords * Uint32Array.BYTES_PER_ELEMENT;
    const clusterBuffer = app.lights.clusterSetStorageBuffer;
    const inverseProjection = Array.from(app.camera.invProjMat);

    const resources = renderer as typeof renderer & DiagnosticRendererResources;
    const depthTexture = resources.depthTexture;
    const activeMaskBuffer = resources.activeMaskBuffer;
    const flagsBytes = activeMaskBuffer?.size ?? 0;
    const activeMaskAllocated = activeMaskBuffer !== undefined;
    const clusteringUsed = settingsMode !== 'naive';
    const activeMaskCullingEnabled = clusteringUsed
        && settingsMode === 'forward+'
        && depthMode === 'culling';
    const useActiveMask = activeMaskCullingEnabled && activeMaskAllocated;

    const depthFormat = depthTexture?.format ?? null;
    const depthUsage = depthTexture?.usage ?? 0;
    const depthWidth = depthTexture?.width ?? null;
    const depthHeight = depthTexture?.height ?? null;
    const depthReadbackAvailable = depthTexture !== undefined
        && depthFormat === 'depth32float'
        && (depthUsage & GPUTextureUsage.COPY_SRC) !== 0;

    const logicalClusterBufferBytes = totalClusters * clusterRecordStrideBytes;
    if (clusteringUsed && clusterBuffer.size < logicalClusterBufferBytes) {
        throw new Error(
            `Cluster buffer is ${clusterBuffer.size} bytes; `
            + `${logicalClusterBufferBytes} bytes are required`,
        );
    }
    if (useActiveMask && flagsBytes < totalClusters * Uint32Array.BYTES_PER_ELEMENT) {
        throw new Error(
            `Active cluster mask is ${flagsBytes} bytes; `
            + `${totalClusters * Uint32Array.BYTES_PER_ELEMENT} bytes are required`,
        );
    }

    const clusterReadback: Promise<ArrayBuffer | null> = clusteringUsed
        ? readBuffer(clusterBuffer)
        : Promise.resolve(null);
    const flagsReadback: Promise<ArrayBuffer | null> = useActiveMask
        ? readBuffer(activeMaskBuffer!)
        : Promise.resolve(null);
    const depthReadback: Promise<Uint8Array | null> = depthReadbackAvailable
        ? readTexture(depthTexture!, Float32Array.BYTES_PER_ELEMENT, 'depth-only')
        : Promise.resolve(null);

    const [clusterBytes, flagBytes, depthBytes] = await Promise.all([
        clusterReadback,
        flagsReadback,
        depthReadback,
    ]);

    let clusterRecords: Uint32Array | null = null;
    let overflowClusters: number | null = null;
    let overflowClusterFraction: number | null = null;
    let maxCount: number | null = null;
    let meanListed: number | null = null;

    if (clusterBytes !== null) {
        if (clusterBytes.byteLength < logicalClusterBufferBytes) {
            throw new Error(
                `Cluster readback returned ${clusterBytes.byteLength} bytes; `
                + `${logicalClusterBufferBytes} bytes are required`,
            );
        }
        clusterRecords = new Uint32Array(clusterBytes);
        let listedLights = 0;
        let overflowing = 0;
        let largestList = 0;
        for (let cluster = 0; cluster < totalClusters; cluster++) {
            const recordOffset = cluster * clusterRecordWords;
            const count = clusterRecords[recordOffset];
            listedLights += count;
            largestList = Math.max(largestList, count);
            if (clusterRecords[recordOffset + 1] !== 0) {
                overflowing++;
            }
        }
        overflowClusters = overflowing;
        overflowClusterFraction = totalClusters > 0 ? overflowing / totalClusters : 0;
        maxCount = largestList;
        meanListed = totalClusters > 0 ? listedLights / totalClusters : 0;
    }

    let activeClusters = totalClusters;
    if (flagBytes !== null) {
        const requiredFlagBytes = totalClusters * Uint32Array.BYTES_PER_ELEMENT;
        if (flagBytes.byteLength < requiredFlagBytes) {
            throw new Error(
                `Active cluster mask readback returned ${flagBytes.byteLength} bytes; `
                + `${requiredFlagBytes} bytes are required`,
            );
        }
        const flags = new Uint32Array(flagBytes);
        activeClusters = 0;
        for (let cluster = 0; cluster < totalClusters; cluster++) {
            if (flags[cluster] !== 0) {
                activeClusters++;
            }
        }
    }
    const activeClusterFraction = totalClusters > 0 ? activeClusters / totalClusters : 0;

    let visiblePixelCount: number | null = null;
    let invalidDepthPixelCount: number | null = null;
    let overflowVisiblePixels: number | null = null;
    let overflowVisibleFraction: number | null = null;

    if (depthBytes !== null && depthWidth !== null && depthHeight !== null) {
        const pixelCount = depthWidth * depthHeight;
        const requiredDepthBytes = pixelCount * Float32Array.BYTES_PER_ELEMENT;
        if (depthBytes.byteLength < requiredDepthBytes) {
            throw new Error(
                `Depth readback returned ${depthBytes.byteLength} bytes; `
                + `${requiredDepthBytes} bytes are required`,
            );
        }

        const depthValues = new Float32Array(
            depthBytes.buffer,
            depthBytes.byteOffset,
            pixelCount,
        );
        visiblePixelCount = 0;
        invalidDepthPixelCount = 0;
        let overflowingPixels = 0;

        for (let y = 0; y < depthHeight; y++) {
            for (let x = 0; x < depthWidth; x++) {
                const depth = depthValues[x + y * depthWidth];
                if (!Number.isFinite(depth) || depth < 0 || depth > 1) {
                    invalidDepthPixelCount++;
                    continue;
                }
                if (depth === 1) {
                    continue;
                }

                visiblePixelCount++;
                if (clusterRecords === null) {
                    continue;
                }

                const pixelX = x + 0.5;
                const pixelY = y + 0.5;
                const ndcX = 2 * pixelX / depthWidth - 1;
                const ndcY = 1 - 2 * pixelY / depthHeight;
                const viewPosition = multiplyPoint(
                    inverseProjection,
                    [ndcX, ndcY, depth, 1],
                );
                const safeW = viewPosition[3] < 0
                    ? -Math.max(Math.abs(viewPosition[3]), 1e-8)
                    : Math.max(Math.abs(viewPosition[3]), 1e-8);
                const unclampedViewDepth = -viewPosition[2] / safeW;
                const viewDepth = Math.max(
                    Camera.nearPlane,
                    Math.min(Camera.farPlane, unclampedViewDepth),
                );
                const tileX = Math.max(0, Math.min(
                    dimensions[0] - 1,
                    Math.floor(pixelX / depthWidth * dimensions[0]),
                ));
                const tileY = Math.max(0, Math.min(
                    dimensions[1] - 1,
                    Math.floor(pixelY / depthHeight * dimensions[1]),
                ));
                const tileZ = sliceIndex(
                    viewDepth,
                    dimensions[2],
                    Camera.nearPlane,
                    Camera.farPlane,
                );
                const cluster = flatten(tileX, tileY, tileZ, dimensions);
                if (clusterRecords[cluster * clusterRecordWords + 1] !== 0) {
                    overflowingPixels++;
                }
            }
        }

        if (clusteringUsed) {
            overflowVisiblePixels = overflowingPixels;
            overflowVisibleFraction = visiblePixelCount > 0
                ? overflowingPixels / visiblePixelCount
                : 0;
        }
    }

    return {
        renderer: rendererName,
        settingsMode,
        depthMode,
        clusterGrid,
        clusterDimensions: dimensions,
        capacity,
        clusteringUsed,
        totalClusters,
        clusterRecordStrideBytes,
        logicalClusterBufferBytes,
        flagsBytes,
        activeMaskAllocated,
        activeMaskCullingEnabled,
        activeClusters,
        activeClusterFraction,
        overflowClusters,
        overflowClusterFraction,
        maxCount,
        meanListed,
        depthReadbackAvailable,
        depthFormat,
        depthWidth: depthReadbackAvailable ? depthWidth : null,
        depthHeight: depthReadbackAvailable ? depthHeight : null,
        visiblePixelCount,
        invalidDepthPixelCount,
        overflowVisiblePixels,
        overflowVisibleFraction,
    };
}
