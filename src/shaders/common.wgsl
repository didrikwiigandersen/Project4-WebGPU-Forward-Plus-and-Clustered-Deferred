requires unrestricted_pointer_parameters;

// CHECKITOUT: code that you add here will be prepended to all shaders

struct Light {
    pos: vec3f,
    color: vec3f,
}

struct LightSet {
    numLights: u32,
    lights: array<Light>,
}

struct ClusterRecord {
    count: u32,
    overflow: u32,
    indices: array<u32, 256>,
}

struct ClusterSet {
    clusters: array<ClusterRecord>,
}

// Keep this layout synchronized with CameraUniforms in stage/camera.ts.
struct CameraUniforms {
    viewProjMat: mat4x4f,
    viewMat: mat4x4f,
    invProjMat: mat4x4f,
    invViewProjMat: mat4x4f,
    viewport: vec4f,
    depth: vec4f,
    clusterDims: vec4u,
}

const maxHdrValue = 65504.0;

fn safeNormalize(value: vec3f) -> vec3f {
    let lengthSquared = dot(value, value);
    let normalized = value * inverseSqrt(max(lengthSquared, 1e-20));
    return select(vec3f(0.0), normalized, lengthSquared > 1e-20);
}

// CHECKITOUT: this special attenuation function ensures lights don't affect geometry outside the maximum light radius
fn rangeAttenuation(distance: f32) -> f32 {
    let safeDistance = max(distance, 1e-4);
    let rangeFalloff = clamp(1.0 - pow(safeDistance / ${lightRadius}, 4.0), 0.0, 1.0);
    return min(rangeFalloff / (safeDistance * safeDistance), maxHdrValue);
}

fn calculateLightContrib(light: Light, posWorld: vec3f, nor: vec3f) -> vec3f {
    let vecToLight = light.pos - posWorld;
    let distanceSquared = max(dot(vecToLight, vecToLight), 1e-8);
    let distToLight = sqrt(distanceSquared);
    let directionToLight = vecToLight * inverseSqrt(distanceSquared);
    let lambert = max(dot(safeNormalize(nor), directionToLight), 0.0);
    let contribution = max(light.color, vec3f(0.0)) * lambert * rangeAttenuation(distToLight);
    return clamp(contribution, vec3f(0.0), vec3f(maxHdrValue));
}

fn shadeAllLights(
    lightSet: ptr<storage, LightSet, read>,
    posWorld: vec3f,
    normal: vec3f,
) -> vec3f {
    let availableLights = arrayLength(&(*lightSet).lights);
    let lightCount = min((*lightSet).numLights, availableLights);
    var illumination = vec3f(0.0);

    for (var lightIndex = 0u; lightIndex < lightCount; lightIndex++) {
        illumination = min(
            illumination + calculateLightContrib((*lightSet).lights[lightIndex], posWorld, normal),
            vec3f(maxHdrValue),
        );
    }
    return illumination;
}

fn shadeCluster(
    lightSet: ptr<storage, LightSet, read>,
    clusterSet: ptr<storage, ClusterSet, read>,
    clusterIndex: u32,
    posWorld: vec3f,
    normal: vec3f,
) -> vec3f {
    let availableClusters = arrayLength(&(*clusterSet).clusters);
    if (availableClusters == 0u) {
        return vec3f(0.0);
    }

    let safeClusterIndex = min(clusterIndex, availableClusters - 1u);
    let cluster = &(*clusterSet).clusters[safeClusterIndex];

    // An overflowing record is incomplete, so use the exact naive path once.
    if ((*cluster).overflow != 0u) {
        return shadeAllLights(lightSet, posWorld, normal);
    }

    let availableLights = arrayLength(&(*lightSet).lights);
    let lightCount = min((*lightSet).numLights, availableLights);
    let clusterLightCount = min((*cluster).count, 256u);
    var illumination = vec3f(0.0);

    for (var entryIndex = 0u; entryIndex < clusterLightCount; entryIndex++) {
        let lightIndex = (*cluster).indices[entryIndex];
        if (lightIndex < lightCount) {
            illumination = min(
                illumination + calculateLightContrib((*lightSet).lights[lightIndex], posWorld, normal),
                vec3f(maxHdrValue),
            );
        }
    }
    return illumination;
}

fn reconstructViewPosition(
    camera: CameraUniforms,
    pixelXY: vec2f,
    hardwareDepth: f32,
) -> vec3f {
    let uv = clamp(pixelXY * camera.viewport.zw, vec2f(0.0), vec2f(1.0));
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let homogeneous = camera.invProjMat * vec4f(ndc, clamp(hardwareDepth, 0.0, 1.0), 1.0);
    let safeW = select(-max(abs(homogeneous.w), 1e-8), max(abs(homogeneous.w), 1e-8), homogeneous.w >= 0.0);
    return homogeneous.xyz / safeW;
}

fn reconstructWorldPosition(
    camera: CameraUniforms,
    pixelXY: vec2f,
    hardwareDepth: f32,
) -> vec3f {
    let uv = clamp(pixelXY * camera.viewport.zw, vec2f(0.0), vec2f(1.0));
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let homogeneous = camera.invViewProjMat * vec4f(ndc, clamp(hardwareDepth, 0.0, 1.0), 1.0);
    let safeW = select(-max(abs(homogeneous.w), 1e-8), max(abs(homogeneous.w), 1e-8), homogeneous.w >= 0.0);
    return homogeneous.xyz / safeW;
}

fn clusterIndexFromPixelDepth(
    camera: CameraUniforms,
    pixelXY: vec2f,
    hardwareDepth: f32,
) -> u32 {
    let dimensions = max(camera.clusterDims.xyz, vec3u(1u));

    let clusterXFloat = floor(pixelXY.x * camera.viewport.z * f32(dimensions.x));
    let clusterYFloat = floor(pixelXY.y * camera.viewport.w * f32(dimensions.y));
    let clusterX = u32(clamp(clusterXFloat, 0.0, f32(dimensions.x - 1u)));
    let clusterY = u32(clamp(clusterYFloat, 0.0, f32(dimensions.y - 1u)));

    let viewPosition = reconstructViewPosition(camera, pixelXY, hardwareDepth);
    let positiveViewDepth = clamp(-viewPosition.z, camera.depth.x, camera.depth.y);
    let clusterZFloat = floor(log(positiveViewDepth) * camera.depth.z + camera.depth.w);
    let clusterZ = u32(clamp(clusterZFloat, 0.0, f32(dimensions.z - 1u)));

    return clusterX
        + clusterY * dimensions.x
        + clusterZ * dimensions.x * dimensions.y;
}

fn octahedralSign(value: vec2f) -> vec2f {
    return select(vec2f(-1.0), vec2f(1.0), value >= vec2f(0.0));
}

fn encodeOctahedral(normal: vec3f) -> vec2f {
    let unitNormal = safeNormalize(normal);
    var octahedral = unitNormal / max(abs(unitNormal.x) + abs(unitNormal.y) + abs(unitNormal.z), 1e-20);
    if (octahedral.z < 0.0) {
        octahedral = vec3f(
            (vec2f(1.0) - abs(octahedral.yx)) * octahedralSign(octahedral.xy),
            octahedral.z,
        );
    }
    return clamp(octahedral.xy, vec2f(-1.0), vec2f(1.0));
}

fn decodeOctahedral(encoded: vec2f) -> vec3f {
    let safeEncoded = clamp(encoded, vec2f(-1.0), vec2f(1.0));
    var normal = vec3f(safeEncoded, 1.0 - abs(safeEncoded.x) - abs(safeEncoded.y));
    let fold = clamp(-normal.z, 0.0, 1.0);
    normal.x += select(fold, -fold, normal.x >= 0.0);
    normal.y += select(fold, -fold, normal.y >= 0.0);
    return safeNormalize(normal);
}

fn packCompactGBuffer(albedo: vec4f, normal: vec3f) -> vec4u {
    let albedoWord = pack4x8unorm(clamp(albedo, vec4f(0.0), vec4f(1.0)));
    let normalWord = pack2x16snorm(encodeOctahedral(normal));
    return vec4u(
        albedoWord & 0xffffu,
        (albedoWord >> 16u) & 0xffffu,
        normalWord & 0xffffu,
        (normalWord >> 16u) & 0xffffu,
    );
}

fn unpackCompactAlbedo(words: vec4u) -> vec4f {
    let albedoWord = (words.x & 0xffffu) | ((words.y & 0xffffu) << 16u);
    return unpack4x8unorm(albedoWord);
}

fn unpackCompactNormal(words: vec4u) -> vec3f {
    let normalWord = (words.z & 0xffffu) | ((words.w & 0xffffu) << 16u);
    return decodeOctahedral(unpack2x16snorm(normalWord));
}
