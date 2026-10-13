struct ClusterAabb {
    min: vec4f,
    max: vec4f,
}

@group(0) @binding(0) var<storage, read> worldLightSet: LightSet;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<storage, read> viewLightPositions: array<vec4f>;
@group(0) @binding(3) var<storage, read> clusterBounds: array<ClusterAabb>;
@group(0) @binding(4) var<storage, read> activeClusters: array<u32>;
@group(0) @binding(5) var<storage, read_write> clusterSet: ClusterSet;

var<workgroup> hitCount: atomic<u32>;
var<workgroup> clusterIsActive: u32;

fn sphereIntersectsAabb(center: vec3f, radius: f32, bounds: ClusterAabb) -> bool {
    let closestPoint = clamp(center, bounds.min.xyz, bounds.max.xyz);
    let offset = center - closestPoint;
    return dot(offset, offset) <= radius * radius;
}

@compute
@workgroup_size(64)
fn main(
    @builtin(workgroup_id) workgroupId: vec3u,
    @builtin(local_invocation_index) lane: u32,
) {
    let clusterIndex = workgroupId.x;

    if (lane == 0u) {
        atomicStore(&hitCount, 0u);
        clusterIsActive = activeClusters[clusterIndex];
        clusterSet.clusters[clusterIndex].count = 0u;
        clusterSet.clusters[clusterIndex].overflow = 0u;
    }
    workgroupBarrier();

    // The mask only guards intersection work. Every invocation reaches both
    // barriers, and lane zero clears inactive records every frame.
    if (clusterIsActive != 0u) {
        let bounds = clusterBounds[clusterIndex];
        let availableLights = arrayLength(&worldLightSet.lights);
        let lightCount = min(worldLightSet.numLights, availableLights);
        let radius = f32(${lightRadius});

        for (var lightIndex = lane; lightIndex < lightCount; lightIndex += 64u) {
            let center = viewLightPositions[lightIndex].xyz;
            if (sphereIntersectsAabb(center, radius, bounds)) {
                let destination = atomicAdd(&hitCount, 1u);
                if (destination < ${clusterCapacity}u) {
                    clusterSet.clusters[clusterIndex].indices[destination] = lightIndex;
                }
            }
        }
    }
    workgroupBarrier();

    if (lane == 0u) {
        let totalHitCount = atomicLoad(&hitCount);
        clusterSet.clusters[clusterIndex].count = min(totalHitCount, ${clusterCapacity}u);
        clusterSet.clusters[clusterIndex].overflow = select(0u, 1u, totalHitCount > ${clusterCapacity}u);
    }
}
