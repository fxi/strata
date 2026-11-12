#version 300 es
precision highp float;
precision highp sampler3D;

// One ray per fragment through the step's volume, composited front to back:
// the three slice planes and the first crossing of the isotherm as a shaded
// surface, with depth contours. Each field is a texture on the store's own
// levels, 0 where missing, and the mask is 1 where there is data: filtered
// field / filtered mask never mixes land into the water. Depth goes through a
// table (regular depth → level coordinate), so levels need not be regular.
// In anomaly mode the slices show A; the isotherm keeps the shape of T and turns neutral.

in vec3 v_world;
out vec4 o_color;

uniform vec3 u_half;
uniform vec3 u_ray;
uniform sampler3D u_t_a;        // T, current and next step
uniform sampler3D u_t_b;
uniform sampler3D u_a_a;        // anomaly A, current and next step
uniform sampler3D u_a_b;
uniform sampler3D u_mask;
uniform highp sampler2D u_depth; // level coordinate of regular depths
uniform float u_depth_size;
uniform float u_mix;
uniform sampler2D u_lut;
uniform vec2 u_domain;         // of the shown quantity: T, or A in anomaly mode
uniform float u_anomaly;       // 1 in anomaly mode
uniform vec3 u_slice;          // world x, y, z of the slice planes
uniform vec3 u_show;           // slices, isotherm, depth contours on the isotherm
uniform float u_bottom;        // depth of the box bottom, metres
uniform float u_iso;
uniform float u_step;          // march step, world units
uniform float u_land;          // 1: cells without data drawn as land on the slices; 0: left clear
uniform float u_bed;           // 1: shade the boundary of the data (lake bed, shore walls)
uniform vec3 u_cut;            // cut-away corner: per axis, its side of the slice plane (±1); 0: full planes

const vec3 LAND = vec3(0.13, 0.135, 0.14);
const float SLICE_ALPHA = 0.93;
const float ISO_ALPHA = 0.9;
const vec3 NEUTRAL = vec3(0.62);
const vec3 BED = vec3(0.42, 0.48, 0.56);
const float BED_ALPHA = 0.24;
// Depth contours drawn on the isotherm, metres: every MINOR, stronger every MAJOR.
const float MINOR = 25.0;
const float MAJOR = 100.0;
const int MAX_STEPS = 512;

float levelCoord(float depth) {
    float x = clamp(depth, 0.0, 1.0) * (u_depth_size - 1.0);
    int i = int(floor(x));
    int j = min(i + 1, int(u_depth_size) - 1);
    return mix(texelFetch(u_depth, ivec2(i, 0), 0).r, texelFetch(u_depth, ivec2(j, 0), 0).r, x - float(i));
}

vec3 uvw(vec3 p) {
    vec3 f = (p + u_half) / (2.0 * u_half);
    return vec3(f.x, f.y, levelCoord(1.0 - f.z));
}

// (filtered T, filtered mask): T = x / y, valid where y > 0.5.
vec2 field(vec3 p) {
    vec3 t = uvw(p);
    return vec2(mix(texture(u_t_a, t).r, texture(u_t_b, t).r, u_mix), texture(u_mask, t).r);
}

// The quantity the slices show: T, or the anomaly A in anomaly mode, with the validity.
vec2 shown(vec3 p) {
    vec3 t = uvw(p);
    float m = texture(u_mask, t).r;
    if (u_anomaly > 0.5) {
        return vec2(mix(texture(u_a_a, t).r, texture(u_a_b, t).r, u_mix), m);
    }
    return vec2(mix(texture(u_t_a, t).r, texture(u_t_b, t).r, u_mix), m);
}

float temperature(vec2 s) {
    return s.x / max(s.y, 1e-4);
}

float rampPosition(float t) {
    return clamp((t - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
}

vec3 ramp(float t) {
    return texture(u_lut, vec2(rampPosition(t), 0.5)).rgb;
}

void over(inout vec4 acc, vec3 color, float alpha) {
    acc.rgb += (1.0 - acc.a) * alpha * color;
    acc.a += (1.0 - acc.a) * alpha;
}

void slice(inout vec4 acc, vec3 p) {
    vec2 s = shown(p);
    if (s.y < 0.5) {
        if (u_land > 0.5) {
            over(acc, LAND, 0.8);
        }
        return;
    }
    over(acc, ramp(temperature(s)), SLICE_ALPHA);
}

vec3 isoNormal(vec3 p) {
    // A cell and a half each way: smooth enough not to show the cell edges.
    vec3 h = 3.0 * u_half / vec3(textureSize(u_mask, 0));
    float dx = temperature(field(p + vec3(h.x, 0, 0))) - temperature(field(p - vec3(h.x, 0, 0)));
    float dy = temperature(field(p + vec3(0, h.y, 0))) - temperature(field(p - vec3(0, h.y, 0)));
    float dz = temperature(field(p + vec3(0, 0, h.z))) - temperature(field(p - vec3(0, 0, h.z)));
    // Warm water is above: the surface faces up the gradient.
    vec3 g = vec3(dx / h.x, dy / h.y, dz / h.z);
    return length(g) > 0.0 ? normalize(g) : vec3(0.0, 0.0, 1.0);
}

// The data's boundary faces out of the valid cells: down the validity gradient.
vec3 bedNormal(vec3 p) {
    vec3 h = 1.5 * u_half / vec3(textureSize(u_mask, 0));
    float dx = field(p + vec3(h.x, 0, 0)).y - field(p - vec3(h.x, 0, 0)).y;
    float dy = field(p + vec3(0, h.y, 0)).y - field(p - vec3(0, h.y, 0)).y;
    float dz = field(p + vec3(0, 0, h.z)).y - field(p - vec3(0, 0, h.z)).y;
    vec3 g = -vec3(dx / h.x, dy / h.y, dz / h.z);
    return length(g) > 0.0 ? normalize(g) : vec3(0.0, 0.0, 1.0);
}

bool inCorner(vec3 p) {
    return u_cut != vec3(0.0) &&
        (p.x - u_slice.x) * u_cut.x > 0.0 &&
        (p.y - u_slice.y) * u_cut.y > 0.0 &&
        (p.z - u_slice.z) * u_cut.z > 0.0;
}

// With a cut-away, plane k only shows as a face of the corner.
bool onFace(int k, vec3 h) {
    if (u_cut == vec3(0.0)) {
        return true;
    }
    for (int j = 0; j < 3; j++) {
        if (j != k && (h[j] - u_slice[j]) * u_cut[j] <= 0.0) {
            return false;
        }
    }
    return true;
}

void main() {
    vec3 o = v_world;
    vec3 d = normalize(u_ray);

    // Exit of the box along the ray: the nearest far slab.
    float exit = 1e9;
    for (int i = 0; i < 3; i++) {
        if (abs(d[i]) > 1e-6) {
            exit = min(exit, ((d[i] > 0.0 ? u_half[i] : -u_half[i]) - o[i]) / d[i]);
        }
    }
    if (exit <= 0.0) {
        discard;
    }

    // Slice crossings, nearest first.
    float planes[3];
    for (int i = 0; i < 3; i++) {
        float t = abs(d[i]) > 1e-6 ? (u_slice[i] - o[i]) / d[i] : -1.0;
        bool shown = u_show.x > 0.5 && t >= 0.0 && t <= exit && onFace(i, o + d * t);
        planes[i] = shown ? t : 1e9;
    }
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2 - i; j++) {
            if (planes[j] > planes[j + 1]) {
                float swap = planes[j];
                planes[j] = planes[j + 1];
                planes[j + 1] = swap;
            }
        }
    }

    // Slices alone need no march: they are drawn after the loop.
    bool march = u_show.y > 0.5 || u_bed > 0.5;
    int steps = march ? min(MAX_STEPS, int(ceil(exit / u_step))) : 0;
    float dt = exit / float(max(steps, 1));
    vec4 acc = vec4(0.0);
    int next = 0;
    float before = 0.0;
    bool beforeValid = false;
    // The first (visible) isotherm hit: its depth, share of the pixel and color.
    float hitDepth = -1.0;
    float isoWeight = 0.0;
    vec3 isoColor = vec3(0.0);
    bool bedHit = false;
    bool beforeWet = false;
    bool beforeCorner = false;
    for (int i = 0; i < MAX_STEPS; i++) {
        if (i >= steps || acc.a > 0.97) {
            break;
        }
        float t0 = float(i) * dt;
        float t1 = t0 + dt;
        for (int k = 0; k < 3; k++) {
            if (next == k && planes[k] < t1) {
                slice(acc, o + d * planes[k]);
                next++;
            }
        }
        vec3 p = o + d * (t0 + 0.5 * dt);
        // The bed alone needs the mask only.
        vec2 s = u_show.y > 0.5 ? field(p) : vec2(0.0, texture(u_mask, uvw(p)).r);
        // The cut-away corner is empty.
        bool wet = s.y > 0.5;
        bool corner = inCorner(p);
        bool valid = wet && !corner;
        float temp = temperature(s);
        // Which side of the isotherm each sample is on. Half-float temperatures often equal the
        // isotherm exactly, where a sign product of zero would miss the crossing on both sides.
        bool warm = temp >= u_iso;
        if (u_show.y > 0.5 && valid && beforeValid && warm != (before >= u_iso)) {
            // Bisect between the two samples, so the surface does not band with the step.
            float a = t0 - 0.5 * dt;
            float b = t0 + 0.5 * dt;
            bool warmA = before >= u_iso;
            for (int k = 0; k < 5; k++) {
                float m = 0.5 * (a + b);
                if ((temperature(field(o + d * m)) >= u_iso) == warmA) {
                    a = m;
                } else {
                    b = m;
                }
            }
            vec3 hit = o + d * (0.5 * (a + b));
            vec3 n = isoNormal(hit);
            float light = 0.35 + 0.65 * abs(dot(n, normalize(vec3(-0.4, -0.5, 0.75))));
            float rim = pow(1.0 - abs(dot(n, -d)), 2.0);
            vec3 base = u_anomaly > 0.5 ? NEUTRAL : ramp(u_iso);
            vec3 color = base * light + vec3(0.35) * rim;
            if (hitDepth < 0.0) {
                hitDepth = (u_half.z - hit.z) / (2.0 * u_half.z) * u_bottom;
                isoWeight = (1.0 - acc.a) * ISO_ALPHA;
                isoColor = color;
            }
            over(acc, color, ISO_ALPHA);
        }
        if (u_bed > 0.5 && !bedHit && i > 0 && wet != beforeWet && !corner && !beforeCorner) {
            bedHit = true;
            vec3 n = bedNormal(p);
            float light = 0.4 + 0.6 * abs(dot(n, normalize(vec3(-0.4, -0.5, 0.75))));
            float rim = pow(1.0 - abs(dot(n, -d)), 3.0);
            over(acc, BED * light + vec3(0.25) * rim, BED_ALPHA);
        }
        before = temp;
        beforeValid = valid;
        beforeWet = wet;
        beforeCorner = corner;
    }
    // Slices behind the last step.
    for (int k = 0; k < 3; k++) {
        if (next == k && planes[k] <= exit) {
            slice(acc, o + d * planes[k]);
            next++;
        }
    }
    // Depth contours on the isotherm, outside the loop so the derivatives are defined:
    // under a pixel wide and faint, as the 2D isotherms; faded where the surface is too
    // steep for them to read.
    float width = fwidth(hitDepth);
    if (u_show.z > 0.5 && hitDepth >= 0.0) {
        float minor = abs(fract(hitDepth / MINOR + 0.5) - 0.5) * MINOR;
        float major = abs(fract(hitDepth / MAJOR + 0.5) - 0.5) * MAJOR;
        float line = max(
            0.2 * (1.0 - smoothstep(0.2 * width, 0.8 * width, minor)),
            0.42 * (1.0 - smoothstep(0.35 * width, 1.1 * width, major))
        );
        line *= 1.0 - smoothstep(4.0, 10.0, width);
        acc.rgb += isoWeight * line * (vec3(1.0) - isoColor);
    }
    o_color = acc;
}
