import { device } from './renderer';

export interface FrameMeasurement {
    frame: number;
    cpuMs: number;
    gpuMs: number | null;
    renderMs: number | null;
    passes: Record<string, number>;
    intervals?: Record<string, { startNs: string; endNs: string }>;
    metadata: Record<string, unknown>;
}

interface QuerySlot {
    querySet: GPUQuerySet;
    resolveBuffer: GPUBuffer;
    readBuffer: GPUBuffer;
    busy: boolean;
    count: number;
    labels: string[];
    measurement: FrameMeasurement;
    pending?: Promise<void>;
}

const queryCount = 64;

class GPUProfiler {
    private slots: QuerySlot[] = [];
    private active?: QuerySlot;
    private submitted?: QuerySlot;
    private frameId = 0;
    private unmeasured?: FrameMeasurement;
    readonly samples: FrameMeasurement[] = [];
    rejectedSamples = 0;
    onSample?: (sample: FrameMeasurement) => void;

    get supported(): boolean { return !!device?.features.has('timestamp-query'); }

    private initialize() {
        if (!this.supported || this.slots.length) return;
        for (let i = 0; i < 6; i++) {
            this.slots.push({
                querySet: device.createQuerySet({ label: `Frame timestamps ${i}`, type: 'timestamp', count: queryCount }),
                resolveBuffer: device.createBuffer({ label: `Query resolve ${i}`, size: queryCount * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
                readBuffer: device.createBuffer({ label: `Query readback ${i}`, size: queryCount * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
                busy: false, count: 0, labels: [],
                measurement: { frame: 0, cpuMs: 0, gpuMs: null, renderMs: null, passes: {}, metadata: {} },
            });
        }
    }

    beginFrame(metadata: Record<string, unknown> = {}) {
        this.initialize();
        this.active = undefined;
        this.submitted = undefined;
        const measurement: FrameMeasurement = { frame: ++this.frameId, cpuMs: 0, gpuMs: null, renderMs: null, passes: {}, metadata: { ...metadata } };
        const slot = this.slots.find(s => !s.busy);
        if (!slot) { this.unmeasured = measurement; return; }
        slot.busy = true;
        slot.count = 0;
        slot.labels = [];
        slot.measurement = measurement;
        this.active = slot;
        this.unmeasured = undefined;
    }

    pass(label: string): GPUComputePassTimestampWrites | undefined {
        const slot = this.active;
        if (!slot || slot.count + 2 > queryCount) return undefined;
        const beginningOfPassWriteIndex = slot.count;
        slot.count += 2;
        slot.labels.push(label);
        return { querySet: slot.querySet, beginningOfPassWriteIndex, endOfPassWriteIndex: beginningOfPassWriteIndex + 1 };
    }

    resolve(encoder: GPUCommandEncoder) {
        const slot = this.active;
        if (!slot || !slot.count) return;
        encoder.resolveQuerySet(slot.querySet, 0, slot.count, slot.resolveBuffer, 0);
        encoder.copyBufferToBuffer(slot.resolveBuffer, 0, slot.readBuffer, 0, slot.count * 8);
    }

    afterSubmit() {
        const slot = this.active;
        this.submitted = slot;
        this.active = undefined;
        if (!slot) return;
        if (!slot.count) { slot.busy = false; return; }
        slot.pending = slot.readBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const ticks = new BigUint64Array(slot.readBuffer.getMappedRange());
            let valid = true;
            for (let i = 0; i < slot.labels.length; i++) {
                const start = ticks[i * 2], end = ticks[i * 2 + 1];
                if (end < start) { valid = false; break; }
                slot.measurement.passes[slot.labels[i]] = Number(end - start) / 1e6;
                slot.measurement.intervals ??= {};
                slot.measurement.intervals[slot.labels[i]] = { startNs: start.toString(), endNs: end.toString() };
            }
            if (valid && ticks[slot.count - 1] >= ticks[0]) {
                slot.measurement.gpuMs = Number(ticks[slot.count - 1] - ticks[0]) / 1e6;
                const firstRender = slot.labels.findIndex(label => label !== 'Light movement');
                slot.measurement.renderMs = firstRender < 0 ? null : Number(ticks[slot.count - 1] - ticks[firstRender * 2]) / 1e6;
                this.emit(slot.measurement);
            } else this.rejectedSamples++;
        }).catch(error => {
            this.rejectedSamples++;
            console.error('GPU timing readback failed', error);
        }).finally(() => {
            if (slot.readBuffer.mapState === 'mapped') slot.readBuffer.unmap();
            slot.busy = false;
        });
    }

    endCPU(ms: number) {
        const measurement = this.submitted?.measurement ?? this.unmeasured;
        if (measurement) measurement.cpuMs = ms;
        if (this.unmeasured && !this.supported) {
            this.emit(this.unmeasured);
            this.unmeasured = undefined;
        }
    }

    private emit(sample: FrameMeasurement) {
        this.samples.push(sample);
        if (this.samples.length > 12000) this.samples.splice(0, 2000);
        this.onSample?.(sample);
    }

    async waitForCapacity() {
        this.initialize();
        if (this.slots.length && this.slots.every(s => s.busy)) {
            await Promise.race(this.slots.map(s => s.pending).filter((p): p is Promise<void> => !!p));
        }
    }

    async drain() {
        await Promise.all(this.slots.map(s => s.pending));
    }

    clear() { this.samples.length = 0; this.rejectedSamples = 0; }
}

export const profiler = new GPUProfiler();
