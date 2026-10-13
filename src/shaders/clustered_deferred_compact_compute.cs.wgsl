@group(3) @binding(0) var compactTexture: texture_2d<u32>;
@group(3) @binding(3) var depthTexture: texture_depth_2d;
@group(3) @binding(5) var outputTexture: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    if (globalId.x >= deferredUniforms.width || globalId.y >= deferredUniforms.height) {
        return;
    }

    let pixel = globalId.xy;
    let textureCoordinate = vec2i(pixel);
    let hardwareDepth = textureLoad(depthTexture, textureCoordinate, 0);
    if (hardwareDepth >= 1.0) {
        textureStore(outputTexture, textureCoordinate, vec4f(0.0));
        return;
    }

    let pixelCenter = vec2f(pixel) + vec2f(0.5);
    let words = textureLoad(compactTexture, textureCoordinate, 0);
    let positionWorld = reconstructWorldPosition(camera, pixelCenter, hardwareDepth);
    let normalWorld = unpackCompactNormal(words);
    let albedo = unpackCompactAlbedo(words);
    let color = deferredVisibleColor(pixelCenter, hardwareDepth, positionWorld, normalWorld, albedo);
    textureStore(outputTexture, textureCoordinate, color);
}
