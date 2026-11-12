#version 300 es
precision mediump float;

// The previous trails, a little fainter. Straight color: alpha alone fades
// (scaling rgb in 8 bits drifts hue and darkens trails), floored so trails
// really end on 8-bit textures (as zartigl's fade.frag.glsl).
uniform sampler2D u_trails;
uniform float u_opacity;
in vec2 v_uv;
out vec4 o_color;

void main() {
    vec4 color = texture(u_trails, v_uv);
    float alpha = floor(color.a * 255.0 * u_opacity) / 255.0;
    o_color = vec4(color.rgb * step(1.0 / 255.0, alpha), alpha);
}
