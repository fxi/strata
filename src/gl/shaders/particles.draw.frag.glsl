#version 300 es
precision highp float;
precision highp sampler3D;

// Drawn into the trail texture. The cut-away: the corner of the box between the slice planes and the viewer
// is empty, its three faces show the slices. Particles inside that corner, or
// behind one of its faces (where the face holds water), are not drawn.

in vec3 v_world;
in vec4 v_color;
in float v_head;
out vec4 o_color;

uniform vec3 u_half;
uniform vec3 u_ray;
uniform vec3 u_slice;
uniform vec3 u_cut;            // per axis, the side of the plane the corner lies on (±1); 0: no cut
uniform sampler3D u_mask;      // 1 where there is data
uniform highp sampler2D u_depth;
uniform float u_depth_size;

float levelCoord(float depth) {
    float x = clamp(depth, 0.0, 1.0) * (u_depth_size - 1.0);
    int i = int(floor(x));
    int j = min(i + 1, int(u_depth_size) - 1);
    return mix(texelFetch(u_depth, ivec2(i, 0), 0).r, texelFetch(u_depth, ivec2(j, 0), 0).r, x - float(i));
}

bool wet(vec3 p) {
    vec3 f = (p + u_half) / (2.0 * u_half);
    return texture(u_mask, vec3(f.x, f.y, levelCoord(1.0 - f.z))).r > 0.5;
}

bool inCorner(vec3 p) {
    return u_cut != vec3(0.0) &&
        (p.x - u_slice.x) * u_cut.x > 0.0 &&
        (p.y - u_slice.y) * u_cut.y > 0.0 &&
        (p.z - u_slice.z) * u_cut.z > 0.0;
}

void main() {
    vec3 p = v_world;
    if (inCorner(p)) {
        discard;
    }
    if (u_cut != vec3(0.0)) {
        vec3 d = normalize(u_ray);
        // Toward the viewer: p - d * s, s > 0.
        for (int i = 0; i < 3; i++) {
            if (abs(d[i]) < 1e-6) {
                continue;
            }
            float s = (p[i] - u_slice[i]) / d[i];
            if (s <= 0.0) {
                continue;
            }
            vec3 h = p - d * s;
            if (any(greaterThan(abs(h), u_half))) {
                continue;
            }
            // The hit is on a face of the corner when its other two coordinates are on the corner's side.
            bool face = true;
            for (int j = 0; j < 3; j++) {
                if (j != i && (h[j] - u_slice[j]) * u_cut[j] <= 0.0) {
                    face = false;
                }
            }
            if (face && wet(h)) {
                discard;
            }
        }
    }
    // Straight color: the trail texture keeps it, the fade pass scales alpha only.
    o_color = vec4(v_color.rgb, v_color.a * v_head);
}
