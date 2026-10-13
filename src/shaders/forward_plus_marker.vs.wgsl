// An explicit two-triangle fullscreen quad. This intentionally uses six
// vertices (rather than a fullscreen triangle) so the depth-culling pass is
// directly inspectable as the project specification describes it.
const fullscreenQuad = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0),
);

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    return vec4f(fullscreenQuad[vertexIndex], 0.0, 1.0);
}
