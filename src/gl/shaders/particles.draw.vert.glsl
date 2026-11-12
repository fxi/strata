#version 300 es
precision highp float;
precision highp sampler3D;

// Each particle as the segment it moved this frame, from its previous state to
// its current one, drawn into the trail texture (see particles.ts): the
// trails are the accumulated segments, faded a little every frame. Colored by
// speed and faded with the distance to the viewer (depth cue: from above the
// surface is sharpest, from the side the near shore). A particle that just
// respawned draws nothing.

in vec4 a_prev;
in vec4 a_curr;
out vec3 v_world;
out vec4 v_color;
out float v_head;

uniform mat4 u_vp;
uniform vec3 u_half;
uniform sampler3D u_u_a;
uniform sampler3D u_u_b;
uniform sampler3D u_v_a;
uniform sampler3D u_v_b;
uniform sampler3D u_mask;
uniform highp sampler2D u_depth;
uniform float u_depth_size;
uniform float u_mix;
uniform vec2 u_cell;           // cell size, volume fraction: longer moves are respawns
uniform float u_speed_max;     // m/s at the top of the color ramp
uniform float u_life;
uniform vec3 u_ray;            // view direction, away from the viewer
uniform vec2 u_view_range;     // nearest and farthest dot(corner, ray) of the box
uniform float u_depth_cue;     // alpha left at the far side of the box
// Tinted (as projversor): color from the shown scalar through the palette over
// its domain, brightness from speed. Otherwise color from speed.
uniform bool u_tinted;
uniform sampler3D u_t_a;       // T, current and next step (0 where missing)
uniform sampler3D u_t_b;
uniform sampler3D u_a_a;       // anomaly A, current and next step
uniform sampler3D u_a_b;
uniform float u_anomaly;       // 1: tint with A
uniform sampler2D u_lut;
uniform vec2 u_domain;
uniform float u_point;          // > 0: a point of this size at the particle (slow water still leaves a trail)

float levelCoord(float depth) {
    float x = clamp(depth, 0.0, 1.0) * (u_depth_size - 1.0);
    int i = int(floor(x));
    int j = min(i + 1, int(u_depth_size) - 1);
    return mix(texelFetch(u_depth, ivec2(i, 0), 0).r, texelFetch(u_depth, ivec2(j, 0), 0).r, x - float(i));
}

vec3 world(vec3 f) {
    return vec3(-u_half.xy + f.xy * 2.0 * u_half.xy, u_half.z - f.z * 2.0 * u_half.z);
}

// Deep blue, cyan, white, warm: slow water stays dim.
vec3 ramp(float t) {
    vec3 a = vec3(0.16, 0.32, 0.75);
    vec3 b = vec3(0.35, 0.85, 1.0);
    vec3 c = vec3(1.0, 1.0, 1.0);
    vec3 d = vec3(1.0, 0.8, 0.45);
    return t < 0.4 ? mix(a, b, t / 0.4) : t < 0.8 ? mix(b, c, (t - 0.4) / 0.4) : mix(c, d, (t - 0.8) / 0.2);
}

void main() {
    vec3 p = a_curr.xyz;
    vec3 t = vec3(p.xy, levelCoord(p.z));
    float m = texture(u_mask, t).r;
    vec2 vel = vec2(
        mix(texture(u_u_a, t).r, texture(u_u_b, t).r, u_mix),
        mix(texture(u_v_a, t).r, texture(u_v_b, t).r, u_mix)
    ) / max(m, 1e-4);
    float speed = m > 0.5 ? length(vel) : 0.0;
    bool head = gl_VertexID == 1 || u_point > 0.0;
    // A respawn (age went back) or a jump draws nothing: no line across the lake.
    vec2 move = abs(a_curr.xy - a_prev.xy) / u_cell;
    bool fresh = a_curr.w < a_prev.w || a_curr.w < 0.0 || max(move.x, move.y) > 3.0
        || abs(a_curr.z - a_prev.z) > 1e-6;
    v_world = world(head ? a_curr.xyz : a_prev.xyz);
    v_head = head ? 1.0 : 0.6;
    float age = a_curr.w;
    float fade = smoothstep(0.0, 0.35, age) * (1.0 - smoothstep(1.2 * u_life, 1.5 * u_life, age));
    float k = clamp(speed / u_speed_max, 0.0, 1.0);
    // Still water fades, currents stand out; farther from the viewer is fainter.
    float far = (dot(world(a_curr.xyz), normalize(u_ray)) - u_view_range.x)
        / max(u_view_range.y - u_view_range.x, 1e-6);
    float cue = mix(1.0, u_depth_cue, smoothstep(0.0, 1.0, far));
    float alpha = (0.01 + 0.99 * sqrt(k)) * fade * cue * (fresh ? 0.0 : 1.0);
    vec3 color = ramp(sqrt(k));
    if (u_tinted && m > 0.5) {
        float value = (u_anomaly > 0.5
            ? mix(texture(u_a_a, t).r, texture(u_a_b, t).r, u_mix)
            : mix(texture(u_t_a, t).r, texture(u_t_b, t).r, u_mix)) / m;
        float position = clamp((value - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
        // Square-root speed, as projversor: still water darker, currents at full color.
        color = texture(u_lut, vec2(position, 0.5)).rgb * mix(0.45, 1.0, sqrt(k));
    }
    v_color = vec4(color, alpha);
    gl_Position = u_vp * vec4(v_world, 1.0);
    gl_PointSize = max(u_point, 1.0);
}
