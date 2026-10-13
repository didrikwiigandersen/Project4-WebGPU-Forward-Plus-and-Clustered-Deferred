@group(3) @binding(0) var compactTexture: texture_2d<u32>;
@group(3) @binding(3) var depthTexture: texture_depth_2d;

@fragment
fn main(@builtin(position) fragmentPosition: vec4f) -> @location(0) vec4f {
    let pixel = vec2u(floor(fragmentPosition.xy));
    let textureCoordinate = vec2i(pixel);
    let hardwareDepth = textureLoad(depthTexture, textureCoordinate, 0);
    if (hardwareDepth >= 1.0) {
        return vec4f(0.0);
    }

    let pixelCenter = vec2f(pixel) + vec2f(0.5);
    let words = textureLoad(compactTexture, textureCoordinate, 0);
    let positionWorld = reconstructWorldPosition(camera, pixelCenter, hardwareDepth);
    let normalWorld = unpackCompactNormal(words);
    let albedo = unpackCompactAlbedo(words);
    return deferredVisibleColor(pixelCenter, hardwareDepth, positionWorld, normalWorld, albedo);
}
