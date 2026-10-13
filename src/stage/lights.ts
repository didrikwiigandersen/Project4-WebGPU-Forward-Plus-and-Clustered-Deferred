import { vec3 } from "wgpu-matrix";
import { canvas, device } from "../renderer";
import { profiler } from "../profiler";
import { clusterDimensions as configuredClusterDimensions, settings } from "../settings";

import * as shaders from "../shaders/shaders";
import clusterBoundsComputeRaw from "../shaders/cluster_bounds.cs.wgsl?raw";
import transformLightsComputeRaw from "../shaders/transform_lights.cs.wgsl?raw";
import { Camera } from "./camera";

// h in [0, 1]
function hueToRgb(h: number) {
    const f = (n: number, k = (n + h * 6) % 6) => 1 - Math.max(Math.min(k, 4 - k, 1), 0);
    return vec3.lerp(vec3.create(1, 1, 1), vec3.create(f(5), f(3), f(1)), 0.8);
}

export class Lights {
    private readonly camera: Camera;
    private lightCount = 500;

    static readonly maxNumLights = 5000;
    static readonly numFloatsPerLight = 8; // vec3f is aligned at 16 byte boundaries
    static readonly lightIntensity = 0.1;
    static readonly clusterCapacity = shaders.constants.clusterCapacity;

    private static readonly transformWorkgroupSize = 128;
    private static readonly boundsWorkgroupSize = 64;
    private static readonly clusterStride = (2 + Lights.clusterCapacity) * Uint32Array.BYTES_PER_ELEMENT;

    readonly capacity = Lights.clusterCapacity;
    readonly lightsArray = new Float32Array(Lights.maxNumLights * Lights.numFloatsPerLight);
    readonly lightSetStorageBuffer: GPUBuffer;
    readonly viewLightBuffer: GPUBuffer;
    readonly timeUniformBuffer: GPUBuffer;

    readonly moveLightsComputeBindGroupLayout: GPUBindGroupLayout;
    readonly moveLightsComputeBindGroup: GPUBindGroup;
    readonly moveLightsComputePipeline: GPUComputePipeline;

    private readonly transformLightsComputeBindGroupLayout: GPUBindGroupLayout;
    private readonly transformLightsComputeBindGroup: GPUBindGroup;
    private readonly transformLightsComputePipeline: GPUComputePipeline;

    private readonly clusterBoundsComputeBindGroupLayout: GPUBindGroupLayout;
    private clusterBoundsComputeBindGroup!: GPUBindGroup;
    private readonly clusterBoundsComputePipeline: GPUComputePipeline;

    private readonly clusteringComputeBindGroupLayout: GPUBindGroupLayout;
    private clusteringComputeBindGroup!: GPUBindGroup;
    private readonly clusteringComputePipeline: GPUComputePipeline;

    private currentClusterDimensions: [number, number, number] = [0, 0, 0];
    clusterCount = 0;
    private clusterBuffer!: GPUBuffer;
    private clusterBoundsBuffer!: GPUBuffer;
    private allActiveMaskBuffer!: GPUBuffer;
    private externalMaskBuffer?: GPUBuffer;
    private externalMaskBindGroup?: GPUBindGroup;

    private boundsInvalid = true;
    private lastProjection?: Float32Array;
    private lastViewportWidth = -1;
    private lastViewportHeight = -1;

    get numLights(): number {
        return this.lightCount;
    }

    set numLights(value: number) {
        const numericValue = Number(value);
        const integerValue = Number.isNaN(numericValue) ? 0 : Math.trunc(numericValue);
        this.lightCount = Math.max(0, Math.min(Lights.maxNumLights, integerValue));
    }

    get clusterDimensions(): [number, number, number] {
        return [...this.currentClusterDimensions];
    }

    get clusterSetStorageBuffer(): GPUBuffer {
        return this.clusterBuffer;
    }

    get clustersBuffer(): GPUBuffer {
        return this.clusterBuffer;
    }

    get boundsBuffer(): GPUBuffer {
        return this.clusterBoundsBuffer;
    }

    constructor(camera: Camera) {
        this.camera = camera;

        this.lightSetStorageBuffer = device.createBuffer({
            label: "World light set",
            size: 16 + this.lightsArray.byteLength, // 16-byte LightSet header
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this.populateLightsBuffer();
        this.updateLightSetUniformNumLights();

        this.timeUniformBuffer = device.createBuffer({
            label: "Light movement time uniform",
            size: Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.viewLightBuffer = device.createBuffer({
            label: "View-space light positions",
            size: Lights.maxNumLights * 4 * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        this.moveLightsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "Light movement bind group layout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" },
                },
            ],
        });

        this.moveLightsComputeBindGroup = device.createBindGroup({
            label: "Light movement bind group",
            layout: this.moveLightsComputeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.lightSetStorageBuffer } },
                { binding: 1, resource: { buffer: this.timeUniformBuffer } },
            ],
        });

        this.moveLightsComputePipeline = device.createComputePipeline({
            label: "Light movement pipeline",
            layout: device.createPipelineLayout({
                label: "Light movement pipeline layout",
                bindGroupLayouts: [this.moveLightsComputeBindGroupLayout],
            }),
            compute: {
                module: device.createShaderModule({
                    label: "Light movement shader",
                    code: shaders.moveLightsComputeSrc,
                }),
                entryPoint: "main",
            },
        });

        this.transformLightsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "Light transform bind group layout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
            ],
        });

        this.transformLightsComputeBindGroup = device.createBindGroup({
            label: "Light transform bind group",
            layout: this.transformLightsComputeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.lightSetStorageBuffer } },
                { binding: 1, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 2, resource: { buffer: this.viewLightBuffer } },
            ],
        });

        this.transformLightsComputePipeline = device.createComputePipeline({
            label: "Light transform pipeline",
            layout: device.createPipelineLayout({
                label: "Light transform pipeline layout",
                bindGroupLayouts: [this.transformLightsComputeBindGroupLayout],
            }),
            compute: {
                module: device.createShaderModule({
                    label: "Light transform shader",
                    code: shaders.processShaderRaw(transformLightsComputeRaw),
                }),
                entryPoint: "main",
            },
        });

        this.clusterBoundsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "Cluster bounds bind group layout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
            ],
        });

        this.clusterBoundsComputePipeline = device.createComputePipeline({
            label: "Cluster bounds pipeline",
            layout: device.createPipelineLayout({
                label: "Cluster bounds pipeline layout",
                bindGroupLayouts: [this.clusterBoundsComputeBindGroupLayout],
            }),
            compute: {
                module: device.createShaderModule({
                    label: "Cluster bounds shader",
                    code: shaders.processShaderRaw(clusterBoundsComputeRaw),
                }),
                entryPoint: "main",
            },
        });

        this.clusteringComputeBindGroupLayout = device.createBindGroupLayout({
            label: "Light clustering bind group layout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 5,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
            ],
        });

        this.clusteringComputePipeline = device.createComputePipeline({
            label: "Light clustering pipeline",
            layout: device.createPipelineLayout({
                label: "Light clustering pipeline layout",
                bindGroupLayouts: [this.clusteringComputeBindGroupLayout],
            }),
            compute: {
                module: device.createShaderModule({
                    label: "Light clustering shader",
                    code: shaders.clusteringComputeSrc,
                }),
                entryPoint: "main",
            },
        });

        // Renderers bind the cluster buffer during construction, so the initial
        // grid resources must exist before the Lights constructor returns.
        this.ensureClusterResources();
    }

    private populateLightsBuffer() {
        // Fixed, nonzero xorshift32 seed: deterministic colors across reloads.
        let colorState = 0x6d2b79f5;
        const nextHue = () => {
            colorState ^= colorState << 13;
            colorState ^= colorState >>> 17;
            colorState ^= colorState << 5;
            colorState >>>= 0;
            return colorState / 0x1_0000_0000;
        };

        for (let lightIdx = 0; lightIdx < Lights.maxNumLights; ++lightIdx) {
            // Light position is set by the movement compute shader.
            const lightColor = vec3.scale(hueToRgb(nextHue()), Lights.lightIntensity);
            this.lightsArray.set(lightColor, lightIdx * Lights.numFloatsPerLight + 4);
        }

        device.queue.writeBuffer(this.lightSetStorageBuffer, 16, this.lightsArray);
    }

    updateLightSetUniformNumLights() {
        // Reassign through the setter so callers that arrived through untyped UI
        // code still get an integer in the supported range, including zero.
        this.numLights = this.lightCount;
        device.queue.writeBuffer(
            this.lightSetStorageBuffer,
            0,
            new Uint32Array([this.lightCount]),
        );
    }

    private createClusteringBindGroup(activeMask: GPUBuffer): GPUBindGroup {
        return device.createBindGroup({
            label: "Light clustering bind group",
            layout: this.clusteringComputeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.lightSetStorageBuffer } },
                { binding: 1, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 2, resource: { buffer: this.viewLightBuffer } },
                { binding: 3, resource: { buffer: this.clusterBoundsBuffer } },
                { binding: 4, resource: { buffer: activeMask } },
                { binding: 5, resource: { buffer: this.clusterBuffer } },
            ],
        });
    }

    /**
     * Reallocates resources whose sizes depend on settings.clusterGrid.
     * Call this before recreating renderer bind groups after a grid change.
     */
    ensureClusterResources(): boolean {
        const dimensions = configuredClusterDimensions();
        if (
            dimensions[0] === this.currentClusterDimensions[0]
            && dimensions[1] === this.currentClusterDimensions[1]
            && dimensions[2] === this.currentClusterDimensions[2]
        ) {
            return false;
        }

        const dimensionLabel = dimensions.join("x");
        const nextClusterCount = dimensions[0] * dimensions[1] * dimensions[2];
        const nextClusterBufferByteSize = nextClusterCount * Lights.clusterStride;
        const nextBoundsBufferByteSize = nextClusterCount * 2 * 4 * Float32Array.BYTES_PER_ELEMENT;
        const nextActiveMaskBufferByteSize = nextClusterCount * Uint32Array.BYTES_PER_ELEMENT;
        const supportedClusterBufferLimit = Math.min(
            device.limits.maxStorageBufferBindingSize,
            device.limits.maxBufferSize,
        );

        if (
            !Number.isSafeInteger(nextClusterCount)
            || nextClusterCount < 1
            || !Number.isSafeInteger(nextClusterBufferByteSize)
            || nextClusterBufferByteSize > supportedClusterBufferLimit
        ) {
            throw new Error(
                `Unsupported cluster grid ${dimensionLabel}: capacity ${Lights.clusterCapacity}, `
                + `requested ${nextClusterBufferByteSize} bytes for ${nextClusterCount} clusters, `
                + `but the device supports at most ${supportedClusterBufferLimit} bytes `
                + `(maxStorageBufferBindingSize=${device.limits.maxStorageBufferBindingSize}, `
                + `maxBufferSize=${device.limits.maxBufferSize})`,
            );
        }

        if (
            !Number.isSafeInteger(nextBoundsBufferByteSize)
            || !Number.isSafeInteger(nextActiveMaskBufferByteSize)
        ) {
            throw new Error(
                `Unsupported cluster grid ${dimensionLabel}: derived allocation size is not a safe integer`,
            );
        }

        const workgroupLimit = device.limits.maxComputeWorkgroupsPerDimension;
        if (typeof workgroupLimit === "number" && nextClusterCount > workgroupLimit) {
            throw new Error(
                `Unsupported cluster grid ${dimensionLabel}: ${nextClusterCount} clustering workgroups `
                + `exceed the device limit of ${workgroupLimit}`,
            );
        }

        const nextClusterBuffer = device.createBuffer({
            label: `Cluster set ${dimensionLabel}`,
            size: nextClusterBufferByteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        const nextBoundsBuffer = device.createBuffer({
            label: `Cluster view-space bounds ${dimensionLabel}`,
            size: nextBoundsBufferByteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const nextAllActiveMaskBuffer = device.createBuffer({
            label: `All-active cluster mask ${dimensionLabel}`,
            size: nextActiveMaskBufferByteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(
            nextAllActiveMaskBuffer,
            0,
            new Uint32Array(nextClusterCount).fill(1),
        );

        const oldClusterBuffer = this.clusterBuffer;
        const oldBoundsBuffer = this.clusterBoundsBuffer;
        const oldAllActiveMaskBuffer = this.allActiveMaskBuffer;

        this.currentClusterDimensions = [...dimensions];
        this.clusterCount = nextClusterCount;
        this.clusterBuffer = nextClusterBuffer;
        this.clusterBoundsBuffer = nextBoundsBuffer;
        this.allActiveMaskBuffer = nextAllActiveMaskBuffer;

        this.clusterBoundsComputeBindGroup = device.createBindGroup({
            label: "Cluster bounds bind group",
            layout: this.clusterBoundsComputeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.clusterBoundsBuffer } },
            ],
        });
        this.clusteringComputeBindGroup = this.createClusteringBindGroup(this.allActiveMaskBuffer);
        this.externalMaskBuffer = undefined;
        this.externalMaskBindGroup = undefined;
        this.invalidateBounds();

        // WebGPU defers the physical release until already-submitted commands
        // no longer reference these buffers; no CPU/GPU synchronization is needed.
        oldClusterBuffer?.destroy();
        oldBoundsBuffer?.destroy();
        oldAllActiveMaskBuffer?.destroy();
        return true;
    }

    invalidateBounds(): void {
        this.boundsInvalid = true;
    }

    private clusterBoundsNeedUpdate(): boolean {
        if (
            this.boundsInvalid
            || this.lastViewportWidth !== canvas.width
            || this.lastViewportHeight !== canvas.height
            || !this.lastProjection
        ) {
            return true;
        }

        for (let index = 0; index < 16; index++) {
            if (this.lastProjection[index] !== this.camera.projMat[index]) {
                return true;
            }
        }
        return false;
    }

    private encodeClusterBounds(encoder: GPUCommandEncoder) {
        const computePass = encoder.beginComputePass({
            label: "Cluster bounds compute pass",
            timestampWrites: profiler.pass("Cluster bounds"),
        });
        computePass.setPipeline(this.clusterBoundsComputePipeline);
        computePass.setBindGroup(0, this.clusterBoundsComputeBindGroup);
        computePass.dispatchWorkgroups(
            Math.ceil(this.clusterCount / Lights.boundsWorkgroupSize),
        );
        computePass.end();

        this.boundsInvalid = false;
        this.lastProjection = new Float32Array(this.camera.projMat);
        this.lastViewportWidth = canvas.width;
        this.lastViewportHeight = canvas.height;
    }

    private encodeLightTransform(encoder: GPUCommandEncoder) {
        const workgroupCount = Math.ceil(this.lightCount / Lights.transformWorkgroupSize);
        if (workgroupCount === 0) {
            return;
        }

        const computePass = encoder.beginComputePass({
            label: "Light transform compute pass",
            timestampWrites: profiler.pass("Light transform"),
        });
        computePass.setPipeline(this.transformLightsComputePipeline);
        computePass.setBindGroup(0, this.transformLightsComputeBindGroup);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();
    }

    doLightClustering(encoder: GPUCommandEncoder, activeMask?: GPUBuffer) {
        this.ensureClusterResources();

        if (activeMask && activeMask.size < this.clusterCount * Uint32Array.BYTES_PER_ELEMENT) {
            throw new Error(
                `Active cluster mask is ${activeMask.size} bytes; `
                + `${this.clusterCount * Uint32Array.BYTES_PER_ELEMENT} bytes are required`,
            );
        }

        if (this.clusterBoundsNeedUpdate()) {
            this.encodeClusterBounds(encoder);
        }
        this.encodeLightTransform(encoder);

        let bindGroup = this.clusteringComputeBindGroup;
        if (activeMask) {
            if (activeMask !== this.externalMaskBuffer || !this.externalMaskBindGroup) {
                this.externalMaskBuffer = activeMask;
                this.externalMaskBindGroup = this.createClusteringBindGroup(activeMask);
            }
            bindGroup = this.externalMaskBindGroup;
        }

        const computePass = encoder.beginComputePass({
            label: "Light clustering compute pass",
            timestampWrites: profiler.pass("Clustering"),
        });
        computePass.setPipeline(this.clusteringComputePipeline);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(this.clusterCount);
        computePass.end();
    }

    // Light movement deliberately remains a separate submission so render-only
    // measurements can exclude it while retaining queue-order synchronization.
    onFrame(time: number) {
        const movementTime = settings.freezeLights ? settings.fixedTime : time;
        device.queue.writeBuffer(
            this.timeUniformBuffer,
            0,
            new Float32Array([movementTime]),
        );

        const workgroupCount = Math.ceil(this.lightCount / shaders.constants.moveLightsWorkgroupSize);
        if (workgroupCount === 0) {
            return;
        }

        const encoder = device.createCommandEncoder({ label: "Light movement command encoder" });
        const computePass = encoder.beginComputePass({
            label: "Light movement compute pass",
            timestampWrites: profiler.pass("Light movement"),
        });
        computePass.setPipeline(this.moveLightsComputePipeline);
        computePass.setBindGroup(0, this.moveLightsComputeBindGroup);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();
        device.queue.submit([encoder.finish()]);
    }
}
