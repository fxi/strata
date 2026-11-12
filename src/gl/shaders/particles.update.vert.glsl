#version 300 es
precision highp float;
precision highp sampler3D;

// One particle per vertex, advected through the horizontal currents of its depth
// (RK2) and written back with transform feedback. State: volume fractions
// (x east, y north, z down from the surface) and age in seconds. A frame's
// move is split so no sub-step goes further than half a cell; a particle past
// its life, or that reaches a dry cell, starts again at a random wet one.

in vec4 a_state;
out vec4 v_state;

uniform sampler3D u_u_a;       // eastward velocity, m/s, 0 where missing
uniform sampler3D u_u_b;
uniform sampler3D u_v_a;       // northward velocity
uniform sampler3D u_v_b;
uniform sampler3D u_mask;
uniform highp sampler2D u_depth;
uniform float u_depth_size;
uniform float u_mix;
uniform vec2 u_rate;           // volume fraction per (m/s · s) on x and y
uniform vec2 u_cell;           // cell size, volume fraction
uniform float u_dt;            // model seconds this frame
uniform float u_age;           // real seconds this frame
uniform float u_life;          // mean life, real seconds
uniform float u_seed;
uniform float u_depth_bias;    // > 1 puts more particles near the surface

float levelCoord(float depth) {
    float x = clamp(depth, 0.0, 1.0) * (u_depth_size - 1.0);
    int i = int(floor(x));
    int j = min(i + 1, int(u_depth_size) - 1);
    return mix(texelFetch(u_depth, ivec2(i, 0), 0).r, texelFetch(u_depth, ivec2(j, 0), 0).r, x - float(i));
}

// (u, v) in m/s and whether the point is wet.
vec3 flow(vec3 f) {
    vec3 t = vec3(f.xy, levelCoord(f.z));
    float m = texture(u_mask, t).r;
    if (m < 0.5) {
        return vec3(0.0);
    }
    vec2 s = vec2(
        mix(texture(u_u_a, t).r, texture(u_u_b, t).r, u_mix),
        mix(texture(u_v_a, t).r, texture(u_v_b, t).r, u_mix)
    );
    return vec3(s / m, 1.0);
}

// PCG integer hash: sin-based hashes repeat over 10⁵ particles on GPUs.
uint pcg(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

float rand(inout uint s) {
    s = pcg(s);
    return float(s) / 4294967295.0;
}

void main() {
    vec3 p = a_state.xyz;
    float age = a_state.w + u_age;
    uint id = uint(gl_VertexID);
    uint s = pcg(id ^ pcg(uint(u_seed) + 0x9e3779b9u));
    float life = u_life * (0.5 + float(pcg(id + 0x51ed27u)) / 4294967295.0);

    vec3 k1 = flow(p);
    bool wet = k1.z > 0.5;
    if (wet) {
        // Sub-steps of at most half a cell, at most sixteen of them (fast exports).
        vec2 move = abs(k1.xy * u_rate * u_dt) / u_cell;
        int n = int(clamp(ceil(max(move.x, move.y) * 2.0), 1.0, 16.0));
        float h = u_dt / float(n);
        for (int i = 0; i < 16; i++) {
            if (i >= n) {
                break;
            }
            vec3 a = flow(p);
            vec3 mid = p + vec3(a.xy * u_rate * h * 0.5, 0.0);
            vec3 b = flow(mid);
            if (a.z < 0.5 || b.z < 0.5) {
                wet = false;
                break;
            }
            // Never more than half a cell per sub-step, whatever the current.
            vec2 d = clamp(b.xy * u_rate * h, -0.5 * u_cell, 0.5 * u_cell);
            p += vec3(d, 0.0);
        }
    }
    bool outside = any(lessThan(p.xy, vec2(0.0))) || any(greaterThan(p.xy, vec2(1.0)));
    if (!wet || outside || age > life || flow(p).z < 0.5) {
        // A few tries for a wet cell; a dry pick waits for the next frame.
        vec3 q = p;
        bool found = false;
        for (int i = 0; i < 8; i++) {
            q = vec3(rand(s), rand(s), pow(rand(s), u_depth_bias));
            if (flow(q).z > 0.5) {
                found = true;
                break;
            }
        }
        p = q;
        // Unfound picks are old already, so they try again next frame.
        age = found ? -0.25 * rand(s) * u_life : 1e6;
    }
    v_state = vec4(p, age);
}
