#version 300 es
precision mediump float;

// The trails over the cube, premultiplied for the canvas blend.
uniform sampler2D u_trails;
in vec2 v_uv;
out vec4 o_color;

void main() {
    vec4 color = texture(u_trails, v_uv);
    o_color = vec4(color.rgb * color.a, color.a);
}
