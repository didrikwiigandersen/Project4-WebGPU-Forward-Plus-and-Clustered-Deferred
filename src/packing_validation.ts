import { readBuffer } from './gpu_io';
import { device } from './renderer';
import { processShaderRaw } from './shaders/shaders';

const shaderLabel = 'Compact G-buffer packing validation compute shader';
const workgroupSize = 64;
const seededRecordCount = 2048;
const inputStrideBytes = 32;
const outputStrideBytes = 48;

const angularErrorLimitDegrees = 0.02;
const rgbaErrorLimit = 0.5 / 255 + 1e-6;
const unitLengthErrorLimit = 2e-6;
const helperAlbedoErrorLimit = 2e-7;
const halfTieDistanceInByteUnits = 2e-5;

const packingValidationShader = /* wgsl */ `
struct PackingInput {
  normal: vec4f,
  albedo: vec4f,
}

struct PackingInputSet {
  records: array<PackingInput>,
}

struct PackingOutput {
  words: vec4u,
  normal: vec4f,
  albedo: vec4f,
}

struct PackingOutputSet {
  records: array<PackingOutput>,
}

@group(0) @binding(0) var<storage, read> packingInputs: PackingInputSet;
@group(0) @binding(1) var<storage, read_write> packingOutputs: PackingOutputSet;

@compute @workgroup_size(64)
fn validatePacking(@builtin(global_invocation_id) globalID: vec3u) {
  let recordIndex = globalID.x;
  if (recordIndex >= arrayLength(&packingInputs.records)) {
    return;
  }

  let inputRecord = packingInputs.records[recordIndex];
  let words = packCompactGBuffer(inputRecord.albedo, inputRecord.normal.xyz);
  packingOutputs.records[recordIndex].words = words;
  packingOutputs.records[recordIndex].normal = vec4f(unpackCompactNormal(words), 1.0);
  packingOutputs.records[recordIndex].albedo = unpackCompactAlbedo(words);
}
`;

type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];
type PackedWords = readonly [number, number, number, number];

interface PackingRecord {
  readonly label: string;
  readonly normal: Vec3;
  readonly albedo: Vec4;
  readonly knownWords?: PackedWords;
}

export interface PackingValidationReport {
  readonly passed: true;
  readonly countTotal: number;
  readonly countSeeded: number;
  readonly knownWordCaseCount: number;
  readonly maxAngularErrorDegrees: number;
  readonly maxRGBAError: number;
  readonly maxUnitLengthError: number;
  readonly maxNormalComponentError: number;
  readonly thresholds: {
    readonly angularErrorDegrees: number;
    readonly rgbaAbsoluteError: number;
    readonly unitLengthError: number;
    readonly helperAlbedoAbsoluteError: number;
    readonly halfTieDistanceInByteUnits: number;
  };
  readonly evidence: {
    readonly shaderLabel: string;
    readonly entryPoint: string;
    readonly helperFunctions: readonly string[];
    readonly workgroupSize: number;
    readonly inputStrideBytes: number;
    readonly outputStrideBytes: number;
    readonly compilationMessages: readonly string[];
    readonly deviceLabel: string;
    readonly deviceFeatures: readonly string[];
    readonly maxStorageBufferBindingSize: number;
    readonly readback: string;
  };
}

function fail(message: string): never {
  throw new Error(`Compact G-buffer packing validation failed: ${message}`);
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function withValidationErrorScope<T>(
  context: string,
  action: () => T | Promise<T>,
): Promise<T> {
  device.pushErrorScope('validation');

  let result!: T;
  let actionFailed = false;
  let actionError: unknown;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  let scopeFailed = false;
  let scopeError: unknown;
  let validationError: GPUError | null = null;
  try {
    validationError = await device.popErrorScope();
  } catch (error) {
    scopeFailed = true;
    scopeError = error;
  }

  if (actionFailed || scopeFailed || validationError !== null) {
    const details: string[] = [];
    if (actionFailed) {
      details.push(describeError(actionError));
    }
    if (scopeFailed) {
      details.push(`could not read the GPU validation scope: ${describeError(scopeError)}`);
    }
    if (validationError !== null) {
      details.push(`GPUValidationError: ${validationError.message}`);
    }
    throw new Error(`${context}: ${details.join('; ')}`);
  }

  return result;
}

function formatCompilationMessage(message: GPUCompilationMessage): string {
  const location = message.lineNum > 0
    ? `${shaderLabel}:${message.lineNum}:${message.linePos}`
    : shaderLabel;
  return `${location} [${message.type}]: ${message.message}`;
}

function normalizeVector(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z);
  requireCondition(Number.isFinite(length) && length > 0, `invalid source normal (${x}, ${y}, ${z})`);
  return [x / length, y / length, z / length];
}

function byteAlbedo(r: number, g: number, b: number, a: number): Vec4 {
  return [r / 255, g / 255, b / 255, a / 255];
}

function halfThreshold(byte: number, offsetInByteUnits = 0): number {
  return (byte + 0.5 + offsetInByteUnits) / 255;
}

function createRecords(): PackingRecord[] {
  const quantizerOffset = 5e-4;
  const t = 1 / 32767;
  const records: PackingRecord[] = [
    {
      label: 'known all-zero words',
      normal: [0, 0, 1],
      albedo: [0, 0, 0, 0],
      knownWords: [0, 0, 0, 0],
    },
    {
      label: 'known all-one words',
      normal: normalizeVector(-t, -t, 1 - 2 * t),
      albedo: [1, 1, 1, 1],
      knownWords: [0xffff, 0xffff, 0xffff, 0xffff],
    },
    {
      label: 'known mixed channel ordering',
      normal: [1, 0, 0],
      albedo: byteAlbedo(0x12, 0x34, 0x56, 0x78),
      knownWords: [0x3412, 0x7856, 0x7fff, 0],
    },
  ];

  const albedoPatterns: readonly Vec4[] = [
    byteAlbedo(1, 17, 128, 254),
    byteAlbedo(255, 0, 64, 193),
    [0, 1, 0, 1],
    [
      halfThreshold(0),
      halfThreshold(63),
      halfThreshold(127),
      halfThreshold(254),
    ],
    [
      halfThreshold(0, -quantizerOffset),
      halfThreshold(63, -quantizerOffset),
      halfThreshold(127, -quantizerOffset),
      halfThreshold(254, -quantizerOffset),
    ],
    [
      halfThreshold(0, quantizerOffset),
      halfThreshold(63, quantizerOffset),
      halfThreshold(127, quantizerOffset),
      halfThreshold(254, quantizerOffset),
    ],
    [0.1234, 0.8765, 0.314159, 0.618034],
  ];

  const curatedNormals: Array<{ readonly label: string; readonly normal: Vec3 }> = [
    { label: 'axis +X', normal: [1, 0, 0] },
    { label: 'axis -X', normal: [-1, 0, 0] },
    { label: 'axis +Y', normal: [0, 1, 0] },
    { label: 'axis -Y', normal: [0, -1, 0] },
    { label: 'axis +Z', normal: [0, 0, 1] },
    { label: 'axis -Z', normal: [0, 0, -1] },
    { label: 'negative-Z seam (-0,+0)', normal: [-0, 0, -1] },
    { label: 'negative-Z seam (+0,-0)', normal: [0, -0, -1] },
    { label: 'negative-Z seam (-0,-0)', normal: [-0, -0, -1] },
    { label: 'positive-Z signed zero', normal: [-0, -0, 1] },
  ];

  const seamEpsilon = 1e-7;
  const seamDirections: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  for (const [x, y] of seamDirections) {
    curatedNormals.push({
      label: `equator seam (${x},${y}) above`,
      normal: normalizeVector(x, y, seamEpsilon),
    });
    curatedNormals.push({
      label: `equator seam (${x},${y}) below`,
      normal: normalizeVector(x, y, -seamEpsilon),
    });
  }

  for (const [xSign, ySign] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    curatedNormals.push({
      label: `south-pole seam (${xSign},${ySign})`,
      normal: normalizeVector(xSign * seamEpsilon, ySign * seamEpsilon, -1),
    });
  }

  curatedNormals.forEach(({ label, normal }, index) => {
    records.push({
      label,
      normal,
      albedo: albedoPatterns[index % albedoPatterns.length],
    });
  });

  let randomState = 0x51f15e1d;
  const nextRandom = (): number => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };

  for (let index = 0; index < seededRecordCount; index += 1) {
    const z = nextRandom() * 2 - 1;
    const azimuth = nextRandom() * Math.PI * 2;
    const radial = Math.sqrt(Math.max(0, 1 - z * z));
    records.push({
      label: `seeded random ${index}`,
      normal: normalizeVector(radial * Math.cos(azimuth), radial * Math.sin(azimuth), z),
      albedo: [nextRandom(), nextRandom(), nextRandom(), nextRandom()],
    });
  }

  return records;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function independentlyQuantizeUnorm8(value: number): number {
  const scaled = clamp01(value) * 255;
  return Math.min(255, Math.max(0, Math.floor(scaled + 0.5)));
}

function isNearHalfInteger(value: number): boolean {
  const scaled = clamp01(value) * 255;
  const lower = Math.floor(scaled);
  return Math.abs(scaled - (lower + 0.5)) <= halfTieDistanceInByteUnits;
}

function validateKnownWords(record: PackingRecord, recordIndex: number, words: PackedWords): void {
  if (record.knownWords === undefined) {
    return;
  }
  for (let lane = 0; lane < 4; lane += 1) {
    requireCondition(
      words[lane] === record.knownWords[lane],
      `record ${recordIndex} (${record.label}) packed word lane ${lane} was 0x${words[lane].toString(16)}, expected 0x${record.knownWords[lane].toString(16)}`,
    );
  }
}

/**
 * Runs the project compact G-buffer helpers in a real compute pipeline and
 * validates their packed representation and reconstruction on the CPU.
 */
export async function validatePacking(): Promise<PackingValidationReport> {
  const records = createRecords();
  const knownWordCaseCount = records.reduce(
    (count, record) => count + (record.knownWords === undefined ? 0 : 1),
    0,
  );
  requireCondition(knownWordCaseCount === 3, `expected 3 known-word cases, found ${knownWordCaseCount}`);
  requireCondition(
    records.length >= seededRecordCount + 6,
    `expected at least six curated records plus ${seededRecordCount} seeded records`,
  );

  const inputData = new Float32Array(records.length * (inputStrideBytes / Float32Array.BYTES_PER_ELEMENT));
  requireCondition(
    inputData.byteLength === records.length * inputStrideBytes,
    `input byte length ${inputData.byteLength} does not match ${records.length * inputStrideBytes}`,
  );

  records.forEach((record, recordIndex) => {
    const base = recordIndex * 8;
    requireCondition(base + 7 < inputData.length, `record ${recordIndex} input indexing exceeds the typed array`);
    inputData[base] = record.normal[0];
    inputData[base + 1] = record.normal[1];
    inputData[base + 2] = record.normal[2];
    inputData[base + 3] = 0;
    inputData[base + 4] = record.albedo[0];
    inputData[base + 5] = record.albedo[1];
    inputData[base + 6] = record.albedo[2];
    inputData[base + 7] = record.albedo[3];
  });

  const processedShader = processShaderRaw(packingValidationShader);
  const shaderResult = await withValidationErrorScope(
    `${shaderLabel} compilation`,
    async () => {
      const shaderModule = device.createShaderModule({
        label: shaderLabel,
        code: processedShader,
      });
      const compilationInfo = await shaderModule.getCompilationInfo();
      const formattedMessages = compilationInfo.messages.map(formatCompilationMessage);
      const errors = compilationInfo.messages
        .filter((message) => message.type === 'error')
        .map(formatCompilationMessage);
      if (errors.length > 0) {
        throw new Error(`shader compilation errors:\n${errors.join('\n')}`);
      }
      return { shaderModule, formattedMessages };
    },
  );

  const pipelineResult = await withValidationErrorScope(
    'Compact G-buffer packing validation pipeline creation',
    async () => {
      const bindGroupLayout = device.createBindGroupLayout({
        label: 'Compact G-buffer packing validation bind group layout',
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: 'read-only-storage', minBindingSize: inputStrideBytes },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: 'storage', minBindingSize: outputStrideBytes },
          },
        ],
      });
      const pipelineLayout = device.createPipelineLayout({
        label: 'Compact G-buffer packing validation pipeline layout',
        bindGroupLayouts: [bindGroupLayout],
      });
      const pipeline = await device.createComputePipelineAsync({
        label: 'Compact G-buffer packing validation pipeline',
        layout: pipelineLayout,
        compute: {
          module: shaderResult.shaderModule,
          entryPoint: 'validatePacking',
        },
      });
      return { bindGroupLayout, pipeline };
    },
  );

  const outputByteLength = records.length * outputStrideBytes;
  requireCondition(
    inputData.byteLength <= device.limits.maxStorageBufferBindingSize,
    `input buffer size ${inputData.byteLength} exceeds maxStorageBufferBindingSize ${device.limits.maxStorageBufferBindingSize}`,
  );
  requireCondition(
    outputByteLength <= device.limits.maxStorageBufferBindingSize,
    `output buffer size ${outputByteLength} exceeds maxStorageBufferBindingSize ${device.limits.maxStorageBufferBindingSize}`,
  );

  let inputBuffer: GPUBuffer | undefined;
  let outputBuffer: GPUBuffer | undefined;
  try {
    const outputData = await withValidationErrorScope(
      'Compact G-buffer packing validation dispatch and readback',
      async () => {
        inputBuffer = device.createBuffer({
          label: 'Compact G-buffer packing validation input',
          size: inputData.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        outputBuffer = device.createBuffer({
          label: 'Compact G-buffer packing validation output',
          size: outputByteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        device.queue.writeBuffer(inputBuffer, 0, inputData);

        const bindGroup = device.createBindGroup({
          label: 'Compact G-buffer packing validation bind group',
          layout: pipelineResult.bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: inputBuffer } },
            { binding: 1, resource: { buffer: outputBuffer } },
          ],
        });
        const encoder = device.createCommandEncoder({
          label: 'Compact G-buffer packing validation encoder',
        });
        const pass = encoder.beginComputePass({
          label: 'Compact G-buffer packing validation pass',
        });
        pass.setPipeline(pipelineResult.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(records.length / workgroupSize));
        pass.end();
        device.queue.submit([encoder.finish()]);

        return readBuffer(outputBuffer, outputByteLength);
      },
    );

    requireCondition(
      outputData.byteLength === outputByteLength,
      `readback byte length ${outputData.byteLength} does not match ${outputByteLength}`,
    );
    const outputWords = new Uint32Array(outputData);
    const outputFloats = new Float32Array(outputData);
    const outputElementsPerRecord = outputStrideBytes / Uint32Array.BYTES_PER_ELEMENT;
    requireCondition(
      outputWords.length === records.length * outputElementsPerRecord,
      `output typed-array length ${outputWords.length} does not match ${records.length * outputElementsPerRecord}`,
    );

    let maxAngularErrorDegrees = 0;
    let maxRGBAError = 0;
    let maxUnitLengthError = 0;
    let maxNormalComponentError = 0;

    records.forEach((record, recordIndex) => {
      const outputBase = recordIndex * outputElementsPerRecord;
      const inputBase = recordIndex * 8;
      requireCondition(
        outputBase + outputElementsPerRecord - 1 < outputWords.length,
        `record ${recordIndex} (${record.label}) output indexing exceeds the typed array`,
      );

      const words: PackedWords = [
        outputWords[outputBase],
        outputWords[outputBase + 1],
        outputWords[outputBase + 2],
        outputWords[outputBase + 3],
      ];
      words.forEach((word, lane) => {
        requireCondition(
          Number.isInteger(word) && word >= 0 && word <= 0xffff,
          `record ${recordIndex} (${record.label}) packed word lane ${lane} is not a 16-bit unsigned integer: ${word}`,
        );
      });
      validateKnownWords(record, recordIndex, words);

      const rgbaWord = (words[0] | (words[1] << 16)) >>> 0;
      const normalWord = (words[2] | (words[3] << 16)) >>> 0;
      requireCondition(
        (rgbaWord >>> 0) === rgbaWord && (normalWord >>> 0) === normalWord,
        `record ${recordIndex} (${record.label}) failed unsigned packed-word reconstruction`,
      );
      const rgbaBytes = [
        rgbaWord & 0xff,
        (rgbaWord >>> 8) & 0xff,
        (rgbaWord >>> 16) & 0xff,
        (rgbaWord >>> 24) & 0xff,
      ];

      for (let channel = 0; channel < 4; channel += 1) {
        const source = inputData[inputBase + 4 + channel];
        const decoded = outputFloats[outputBase + 8 + channel];
        const decodedFromByte = rgbaBytes[channel] / 255;
        requireCondition(
          Number.isFinite(decoded),
          `record ${recordIndex} (${record.label}) albedo channel ${channel} is non-finite: ${decoded}`,
        );
        requireCondition(
          Math.abs(decoded - decodedFromByte) <= helperAlbedoErrorLimit,
          `record ${recordIndex} (${record.label}) helper albedo channel ${channel} (${decoded}) disagrees with packed byte ${rgbaBytes[channel]} (${decodedFromByte})`,
        );

        const expectedByte = independentlyQuantizeUnorm8(source);
        if (isNearHalfInteger(source)) {
          const scaled = clamp01(source) * 255;
          const lower = Math.min(255, Math.max(0, Math.floor(scaled)));
          const upper = Math.min(255, lower + 1);
          requireCondition(
            rgbaBytes[channel] === lower || rgbaBytes[channel] === upper,
            `record ${recordIndex} (${record.label}) albedo channel ${channel} near a half-integer produced byte ${rgbaBytes[channel]}, expected ${lower} or ${upper}`,
          );
        } else {
          requireCondition(
            rgbaBytes[channel] === expectedByte,
            `record ${recordIndex} (${record.label}) albedo channel ${channel} produced byte ${rgbaBytes[channel]}, expected ${expectedByte} from uploaded f32 ${source}`,
          );
        }

        const rgbaError = Math.abs(decoded - clamp01(source));
        maxRGBAError = Math.max(maxRGBAError, rgbaError);
        requireCondition(
          rgbaError <= rgbaErrorLimit,
          `record ${recordIndex} (${record.label}) albedo channel ${channel} error ${rgbaError} exceeds ${rgbaErrorLimit}`,
        );
      }

      const originalX = inputData[inputBase];
      const originalY = inputData[inputBase + 1];
      const originalZ = inputData[inputBase + 2];
      const originalLength = Math.hypot(originalX, originalY, originalZ);
      requireCondition(
        Number.isFinite(originalLength) && originalLength > 0,
        `record ${recordIndex} (${record.label}) uploaded normal has invalid length ${originalLength}`,
      );

      const decodedX = outputFloats[outputBase + 4];
      const decodedY = outputFloats[outputBase + 5];
      const decodedZ = outputFloats[outputBase + 6];
      const decodedW = outputFloats[outputBase + 7];
      requireCondition(
        Number.isFinite(decodedX) && Number.isFinite(decodedY) && Number.isFinite(decodedZ),
        `record ${recordIndex} (${record.label}) decoded normal is non-finite (${decodedX}, ${decodedY}, ${decodedZ})`,
      );
      requireCondition(
        Number.isFinite(decodedW) && Math.abs(decodedW - 1) <= Number.EPSILON,
        `record ${recordIndex} (${record.label}) decoded normal padding was ${decodedW}, expected 1`,
      );

      const decodedLength = Math.hypot(decodedX, decodedY, decodedZ);
      const unitLengthError = Math.abs(decodedLength - 1);
      maxUnitLengthError = Math.max(maxUnitLengthError, unitLengthError);
      requireCondition(
        Number.isFinite(decodedLength) && decodedLength > 0 && unitLengthError <= unitLengthErrorLimit,
        `record ${recordIndex} (${record.label}) decoded normal length ${decodedLength} has error ${unitLengthError}, exceeding ${unitLengthErrorLimit}`,
      );

      const originalUnit: Vec3 = [
        originalX / originalLength,
        originalY / originalLength,
        originalZ / originalLength,
      ];
      const decodedUnit: Vec3 = [
        decodedX / decodedLength,
        decodedY / decodedLength,
        decodedZ / decodedLength,
      ];
      const dot = Math.min(1, Math.max(-1,
        originalUnit[0] * decodedUnit[0]
        + originalUnit[1] * decodedUnit[1]
        + originalUnit[2] * decodedUnit[2]));
      const angularErrorDegrees = Math.acos(dot) * 180 / Math.PI;
      maxAngularErrorDegrees = Math.max(maxAngularErrorDegrees, angularErrorDegrees);
      requireCondition(
        angularErrorDegrees <= angularErrorLimitDegrees,
        `record ${recordIndex} (${record.label}) decoded normal angular error ${angularErrorDegrees} degrees exceeds ${angularErrorLimitDegrees}`,
      );
      for (let component = 0; component < 3; component += 1) {
        maxNormalComponentError = Math.max(
          maxNormalComponentError,
          Math.abs(originalUnit[component] - decodedUnit[component]),
        );
      }
    });

    return {
      passed: true,
      countTotal: records.length,
      countSeeded: seededRecordCount,
      knownWordCaseCount,
      maxAngularErrorDegrees,
      maxRGBAError,
      maxUnitLengthError,
      maxNormalComponentError,
      thresholds: {
        angularErrorDegrees: angularErrorLimitDegrees,
        rgbaAbsoluteError: rgbaErrorLimit,
        unitLengthError: unitLengthErrorLimit,
        helperAlbedoAbsoluteError: helperAlbedoErrorLimit,
        halfTieDistanceInByteUnits,
      },
      evidence: {
        shaderLabel,
        entryPoint: 'validatePacking',
        helperFunctions: [
          'packCompactGBuffer',
          'unpackCompactNormal',
          'unpackCompactAlbedo',
        ],
        workgroupSize,
        inputStrideBytes,
        outputStrideBytes,
        compilationMessages: shaderResult.formattedMessages,
        deviceLabel: device.label || 'unlabeled GPUDevice',
        deviceFeatures: Array.from(device.features, (feature) => String(feature)).sort(),
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        readback: 'gpu_io.readBuffer',
      },
    };
  } finally {
    inputBuffer?.destroy();
    outputBuffer?.destroy();
  }
}
