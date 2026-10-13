struct ClusterAabb {
    min: vec4f,
    max: vec4f,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read_write> clusterBounds: array<ClusterAabb>;

@compute
@workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let clusterIndex = globalId.x;
    let dimensions = camera.clusterDims.xyz;
    let clusterCount = dimensions.x * dimensions.y * dimensions.z;
    if (clusterIndex >= clusterCount) {
        return;
    }

    let clustersPerSlice = dimensions.x * dimensions.y;
    let clusterZ = clusterIndex / clustersPerSlice;
    let indexWithinSlice = clusterIndex - clusterZ * clustersPerSlice;
    let clusterY = indexWithinSlice / dimensions.x;
    let clusterX = indexWithinSlice - clusterY * dimensions.x;

    let nearDistance = camera.depth.x
        * pow(camera.depth.y / camera.depth.x, f32(clusterZ) / f32(dimensions.z));
    let farDistance = camera.depth.x
        * pow(camera.depth.y / camera.depth.x, f32(clusterZ + 1u) / f32(dimensions.z));

    var minimum = vec3f(1e30);
    var maximum = vec3f(-1e30);

    // The low three bits choose one of the eight frustum-slice corners:
    // two screen X boundaries, two top-left-origin screen Y boundaries, and
    // the two logarithmic view-distance boundaries.
    for (var corner = 0u; corner < 8u; corner++) {
        let screenX = select(clusterX, clusterX + 1u, (corner & 1u) != 0u);
        let screenY = select(clusterY, clusterY + 1u, (corner & 2u) != 0u);
        let viewDistance = select(nearDistance, farDistance, (corner & 4u) != 0u);

        let ndcX = 2.0 * f32(screenX) / f32(dimensions.x) - 1.0;
        let ndcY = 1.0 - 2.0 * f32(screenY) / f32(dimensions.y);

        // WebGPU hardware depth is [0, 1]. Unproject a point on depth 1 to
        // obtain the view ray, then scale it to the desired negative view Z.
        let homogeneous = camera.invProjMat * vec4f(ndcX, ndcY, 1.0, 1.0);
        let pointOnRay = homogeneous.xyz / homogeneous.w;
        let cornerPosition = pointOnRay * (viewDistance / -pointOnRay.z);

        minimum = min(minimum, cornerPosition);
        maximum = max(maximum, cornerPosition);
    }

    // Enlarge rather than shrink at floating-point boundaries. The allowance
    // scales with depth because projection/unprojection error does as well.
    let conservativeEpsilon = max(1e-4, farDistance * 1e-3);
    minimum -= vec3f(conservativeEpsilon);
    maximum += vec3f(conservativeEpsilon);

    clusterBounds[clusterIndex].min = vec4f(minimum, 0.0);
    clusterBounds[clusterIndex].max = vec4f(maximum, 0.0);
}
