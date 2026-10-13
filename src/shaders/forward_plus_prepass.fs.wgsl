@group(${bindGroup_material}) @binding(0) var diffuseTexture: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseSampler: sampler;

// Keep the depth prepass coverage identical to the lighting pass. Sponza uses
// cutout materials, so treating every triangle as opaque would make the equal
// depth test reject visible texels during final shading.
@fragment
fn main(@location(2) uv: vec2f) {
    if (textureSample(diffuseTexture, diffuseSampler, uv).a < 0.5) {
        discard;
    }
}
