// CHECKITOUT: you can use this vertex shader for all of the renderers

@group(${bindGroup_scene}) @binding(0) var<uniform> camera: CameraUniforms;

@group(${bindGroup_model}) @binding(0) var<uniform> modelMat: mat4x4f;

struct VertexInput
{
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

struct VertexOutput
{
    // Keeping this position invariant is important when the same shader is used
    // by the depth prepass and the equal-depth lighting pass.
    @invariant @builtin(position) fragPos: vec4f,
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

@vertex
fn main(in: VertexInput) -> VertexOutput
{
    let modelPos = modelMat * vec4(in.pos, 1);

    var out: VertexOutput;
    out.fragPos = camera.viewProjMat * modelPos;
    out.pos = modelPos.xyz / modelPos.w;
    // The starter scene uses rigid/uniform transforms.  Transforming with w=0
    // keeps normals in world space without applying translation.
    out.nor = (modelMat * vec4f(in.nor, 0.0f)).xyz;
    out.uv = in.uv;
    return out;
}
