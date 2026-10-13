@group(${bindGroup_scene}) @binding(0) var<uniform> camera: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterSet: ClusterSet;

struct ForwardDebugUniforms {
    mode: u32,
    cullingEnabled: u32,
    padding1: u32,
    padding2: u32,
}

@group(${bindGroup_scene}) @binding(3) var<uniform> forwardDebug: ForwardDebugUniforms;
@group(${bindGroup_scene}) @binding(4) var<storage, read> activeMask: array<u32>;

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @builtin(position) fragPos: vec4f,
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

fn forwardClusterCoordinates(clusterIndex: u32) -> vec3u {
    let dimensions = max(camera.clusterDims.xyz, vec3u(1u));
    let clustersPerSlice = dimensions.x * dimensions.y;
    let clusterZ = clusterIndex / clustersPerSlice;
    let indexWithinSlice = clusterIndex - clusterZ * clustersPerSlice;
    let clusterY = indexWithinSlice / dimensions.x;
    let clusterX = indexWithinSlice - clusterY * dimensions.x;
    return vec3u(clusterX, clusterY, clusterZ);
}

fn forwardClusterCoordinateColor(clusterIndex: u32) -> vec3f {
    let dimensions = max(camera.clusterDims.xyz, vec3u(1u));
    let coordinates = forwardClusterCoordinates(clusterIndex);
    return (vec3f(coordinates) + vec3f(0.5f)) / vec3f(dimensions);
}

fn forwardClusterHashColor(clusterIndex: u32) -> vec3f {
    let value = f32(clusterIndex);
    return fract(vec3f(
        value * 0.1031f + 0.17f,
        value * 0.11369f + 0.43f,
        value * 0.13787f + 0.71f
    ));
}

fn forwardLightCountHeat(lightCount: u32) -> vec3f {
    let capacity = max(f32(camera.clusterDims.w), 1.0f);
    let amount = clamp(f32(lightCount) / capacity, 0.0f, 1.0f);
    return vec3f(
        clamp(3.0f * amount - 1.0f, 0.0f, 1.0f),
        clamp(1.5f - abs(3.0f * amount - 1.5f), 0.0f, 1.0f),
        clamp(1.0f - 3.0f * amount, 0.0f, 1.0f)
    );
}

@fragment
fn main(in: FragmentInput) -> @location(0) vec4f {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) {
        discard;
    }

    let debugMode = forwardDebug.mode;
    if (debugMode == 4u) {
        return vec4f(diffuseColor.rgb, 1.0f);
    }
    if (debugMode == 5u) {
        return vec4f(safeNormalize(in.nor) * 0.5f + vec3f(0.5f), 1.0f);
    }
    if (debugMode == 6u) {
        let viewPosition = reconstructViewPosition(camera, in.fragPos.xy, in.fragPos.z);
        let viewDepth = clamp(-viewPosition.z, camera.depth.x, camera.depth.y);
        let logarithmicDepth = clamp(
            (log(viewDepth) * camera.depth.z + camera.depth.w)
                / f32(max(camera.clusterDims.z, 1u)),
            0.0f,
            1.0f
        );
        return vec4f(vec3f(logarithmicDepth), 1.0f);
    }

    // The exact same helper is used by the active-cluster marker, so pixels on
    // logarithmic slice boundaries cannot disagree with light clustering.
    let clusterIndex = clusterIndexFromPixelDepth(camera, in.fragPos.xy, in.fragPos.z);
    if (debugMode == 1u) {
        return vec4f(forwardClusterCoordinateColor(clusterIndex), 1.0f);
    }

    if (debugMode == 2u || debugMode == 3u) {
        let clusterCount = arrayLength(&clusterSet.clusters);
        if (clusterCount == 0u) {
            return vec4f(0.0f, 0.0f, 0.0f, 1.0f);
        }
        let safeClusterIndex = min(clusterIndex, clusterCount - 1u);
        let lightCount = min(clusterSet.clusters[safeClusterIndex].count, camera.clusterDims.w);
        if (debugMode == 2u) {
            return vec4f(forwardLightCountHeat(lightCount), 1.0f);
        }

        let overflow = clusterSet.clusters[safeClusterIndex].overflow != 0u;
        let countAmount = f32(lightCount) / max(f32(camera.clusterDims.w), 1.0f);
        let statusColor = select(
            vec3f(0.0f, max(0.12f, countAmount), 0.0f),
            vec3f(1.0f, countAmount * 0.25f, 0.0f),
            overflow
        );
        return vec4f(statusColor, 1.0f);
    }

    if (debugMode == 8u) {
        var considered = true;
        if (forwardDebug.cullingEnabled != 0u) {
            let maskCount = arrayLength(&activeMask);
            considered = false;
            if (clusterIndex < maskCount) {
                considered = activeMask[clusterIndex] != 0u;
            }
        }
        if (!considered) {
            return vec4f(0.0f, 0.0f, 0.0f, 1.0f);
        }

        // Off/prepass modes consider every visible cluster. Culling mode reads
        // the marker's actual flag and only hashes clusters marked active.
        let activeColor = clamp(
            forwardClusterHashColor(clusterIndex) * 0.35f + vec3f(0.05f, 0.60f, 0.05f),
            vec3f(0.0f),
            vec3f(1.0f)
        );
        return vec4f(activeColor, 1.0f);
    }

    // Debug mode 7 is bloom, which is intentionally handled by PostProcessing.
    let lightContribution = shadeCluster(
        &lightSet,
        &clusterSet,
        clusterIndex,
        in.pos,
        in.nor
    );
    let color = clamp(diffuseColor.rgb * lightContribution, vec3f(0.0f), vec3f(65504.0f));
    return vec4f(color, 1.0f);
}
