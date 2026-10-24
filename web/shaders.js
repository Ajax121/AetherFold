// All source coordinates, anchors and gestures use a TOP-LEFT origin.
// Upload without UNPACK_FLIP_Y_WEBGL. The sampler reflects at the source
// edges, including non-square sources; no padding or clamped crop is needed.

/** CPU reference for the shader's motif(), useful for seam acceptance tests.
 * point is {x,y} relative to canvas centre, measured in canvas heights, Y down.
 * sourceUV = anchor + {x: result.x / sourceAspect, y: result.y} / zoom.
 * Set warp=0 for exact GPU/CPU comparisons; an active warp changes both sides
 * of a seam identically. Coordinates are intentionally NOT clamped to [0,1].
 *
 * Mirror: F(x,y)=F(-x,y)=F(x,-y).
 * Square: in rotated lattice space, F(nL-e,y)=F(nL+e,y), L=2/folds.
 * Diamond: same, after rotating lattice coordinates by pi/4.
 * Triangle: square invariants plus F(x,y)=F(y,x).
 * Radial: angular period 2*pi/folds, reflection axes k*pi/folds.
 */
export function foldCoordinates(point, { pattern = 'radial', folds = 6, rotation = 0 } = {}) {
  const count = Math.round(Math.min(32, Math.max(2, Number.isFinite(folds) ? folds : 6)));
  const angle = Number.isFinite(rotation) ? rotation : 0;
  const mod = (n, d) => ((n % d) + d) % d;
  let x = Math.cos(angle) * point.x + Math.sin(angle) * point.y;
  let y = -Math.sin(angle) * point.x + Math.cos(angle) * point.y;
  if (pattern === 'mirror') return { x: Math.abs(x) * 1.5, y: Math.abs(y) * 1.5, seam: Math.min(Math.abs(x), Math.abs(y)) };
  if (pattern === 'square' || pattern === 'diamond' || pattern === 'triangle') {
    if (pattern === 'diamond') [x, y] = [(x - y) * Math.SQRT1_2, (x + y) * Math.SQRT1_2];
    const density = count * 0.5;
    let cx = 1 - Math.abs(mod(x * density, 2) - 1);
    let cy = 1 - Math.abs(mod(y * density, 2) - 1);
    let seam = Math.min(cx, cy, 1 - cx, 1 - cy) / density;
    if (pattern === 'triangle') {
      seam = Math.min(seam, Math.abs(cx - cy) / (density * Math.SQRT2));
      [cx, cy] = [Math.max(cx, cy), Math.min(cx, cy)];
    }
    return { x: cx * 0.65, y: cy * 0.65, seam };
  }
  const radius = Math.hypot(x, y);
  const wedge = Math.PI / count;
  const a = Math.abs(mod((radius > 0.000001 ? Math.atan2(y, x) : 0) + wedge, 2 * wedge) - wedge);
  return { x: Math.cos(a) * radius * 1.5, y: Math.sin(a) * radius * 1.5,
    seam: radius * Math.sin(Math.min(a, wedge - a)) };
}

export const VERTEX_SHADER = `#version 300 es
precision highp float;
void main() {
    // One oversized triangle has no internal rasterization seam or VBO.
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_imageAspect;
uniform vec2 u_anchor;
uniform float u_time;
uniform float u_zoom;
uniform float u_rotation;
uniform float u_folds;
uniform int u_pattern;
uniform float u_morph;
uniform float u_warp;
uniform float u_imageMix;
uniform vec2 u_pointer;
uniform float u_energy;
uniform float u_pinch;
uniform float u_depth;
uniform vec3 u_paletteA;
uniform vec3 u_paletteB;
uniform vec3 u_background;
uniform int u_steps;
uniform bool u_guides;
out vec4 outColor;

const float PI = 3.141592653589793;
const int MAX_STEPS = 160;

mat2 rotate2(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, s, -s, c);
}

// Continuous triangular wave: 0 at every even integer, 1 at odd integers.
// Unlike fract(), its left/right limits agree at *every* cell boundary.
vec2 reflectCell(vec2 p) {
    return 1.0 - abs(mod(p, 2.0) - 1.0);
}

// Return canonical motif coordinates and distance to its reflection seam.
// Every subsequent operation depends ONLY on these canonical coordinates,
// never on tile/sector identity. Adjacent copies therefore sample identical
// source coordinates at the seam, including during interaction and in 3D.
vec3 motif(vec2 point) {
    vec2 p = rotate2(-u_rotation) * point;
    if (u_pattern == 0) {
        return vec3(abs(p) * 1.5, min(abs(p.x), abs(p.y)));
    }
    if (u_pattern == 1 || u_pattern == 2 || u_pattern == 3) {
        if (u_pattern == 2) p = rotate2(PI * 0.25) * p;
        float density = u_folds * 0.5;
        vec2 cell = reflectCell(p * density);
        vec2 edge = min(cell, 1.0 - cell) / density;
        float seam = min(edge.x, edge.y);
        if (u_pattern == 3) {
            // Reflection in a square's diagonal gives a genuine tessellation
            // of right-isosceles triangles, with equal UVs on all three edges.
            seam = min(seam, abs(cell.x - cell.y) / (density * sqrt(2.0)));
            cell = vec2(max(cell.x, cell.y), min(cell.x, cell.y));
        }
        return vec3(cell * 0.65, seam);
    }
    float r = length(p);
    float wedge = PI / u_folds;
    float angle = r > 0.000001 ? atan(p.y, p.x) : 0.0;
    float a = abs(mod(angle + wedge, 2.0 * wedge) - wedge);
    float seam = r * sin(min(a, wedge - a));
    return vec3(vec2(cos(a), sin(a)) * r * 1.5, seam);
}

// Applying this continuous deformation to a shared motif coordinate makes
// gestures act on all its reflected counterparts. No post-fold tile offsets.
vec2 bendMotif(vec2 q, vec2 hand) {
    vec2 delta = q - hand;
    float radius2 = dot(delta, delta);
    float strength = u_warp * (0.32 * u_energy + 0.48 * u_pinch);
    float falloff = exp(-radius2 * 4.5);
    float twist = strength * falloff * (0.5 + u_pointer.x);
    vec2 bent = rotate2(twist) * delta;
    bent *= 1.0 - 0.24 * u_pinch * u_warp * falloff;
    return hand + bent + delta * (0.06 * strength * falloff
        * sin(radius2 * 16.0 - u_time * 1.3));
}

vec2 sourceUV(vec2 q) {
    // Divide by source aspect AFTER the Euclidean reflections. Source pixels
    // have equal physical size along both axes even for tall/wide images.
    return u_anchor + q / (vec2(u_imageAspect, 1.0) * u_zoom);
}

vec3 sourceColor(vec2 uv, vec2 dx, vec2 dy) {
    // MIRRORED_REPEAT operates on the unbounded UVs. Retaining these UVs also
    // gives the texture unit correct derivatives across reflected image edges.
    vec4 texel = textureGrad(u_image, uv, dx, dy);
    return mix(u_background, texel.rgb, texel.a);
}

vec3 palette(float t) {
    float wave = 0.5 + 0.5 * cos(6.28318530718 * t);
    return mix(u_paletteA, u_paletteB, wave);
}

vec3 bendSpace(vec3 p, vec2 hand) {
    float strength = u_warp * (0.55 * u_energy + 0.7 * u_pinch);
    vec2 delta = p.xy - hand * 2.0;
    float falloff = exp(-dot(delta, delta) * 0.65);
    // A depth-dependent rotation and dilation changes the 3D field itself.
    // X/Y steer bend direction; pinch opens the tunnel; energy increases curl.
    p.xy = rotate2(strength * sin(p.z * 0.65 + u_time * 0.18)
        * (u_pointer.x - 0.5 + falloff)) * p.xy;
    p.xy *= 1.0 - 0.18 * strength * falloff;
    p.x += strength * (u_pointer.x - 0.5) * sin(p.z * 1.1);
    p.y += strength * (u_pointer.y - 0.5) * cos(p.z * 0.9);
    p.z += strength * falloff * (u_depth - 0.5);
    p.yz = rotate2(u_time * 0.075) * p.yz;
    p.xz = rotate2(u_time * 0.055) * p.xz;
    return p;
}

float gyroid(vec3 p) {
    vec3 q = p * 2.5;
    return abs(dot(sin(q), cos(q.zxy))) - (0.24 + u_pinch * 0.08);
}

float field(vec3 p, vec2 hand) {
    // The gyroid is an implicit surface, not an exact distance function.
    // 2*k*sqrt(3) bounds its gradient; extra scaling allows for the bend.
    float derivativeBound = 8.660254 * (1.0 + 2.5 * u_warp);
    float shell = gyroid(bendSpace(p, hand)) / derivativeBound;
    return max(shell, length(p) - 2.65);
}

vec3 fieldNormal(vec3 p, vec2 hand) {
    const float e = 0.0025;
    vec3 n = vec3(
        field(p + vec3(e,0,0), hand) - field(p - vec3(e,0,0), hand),
        field(p + vec3(0,e,0), hand) - field(p - vec3(0,e,0), hand),
        field(p + vec3(0,0,e), hand) - field(p - vec3(0,0,e), hand)
    );
    return n / max(length(n), 0.00001);
}

vec3 renderField(vec2 q, vec2 hand, vec2 dx, vec2 dy, vec3 flatColor) {
    float activity = clamp(max(u_energy, u_pinch), 0.0, 1.0);
    vec3 origin = vec3(0.0, 0.0, -3.5 - (u_depth - 0.5) * 0.35 * u_warp);
    vec3 ray = normalize(vec3(q * 1.45, 1.65));
    float travel = 0.0;
    float glow = 0.0;
    bool hit = false;
    vec3 position = origin;
    for (int i = 0; i < MAX_STEPS; ++i) {
        if (i >= u_steps) break;
        position = origin + ray * travel;
        float d = field(position, hand);
        if (abs(d) < 0.0015) {
            hit = true;
            break;
        }
        float stride = max(abs(d) * 0.85, 0.0008);
        // Integrate by distance, not iteration count, so quality tiers do not
        // change the brightness of the same volume.
        glow += min(stride, 0.15) * exp(-travel * 0.18)
            / (1.0 + abs(d) * 12.0);
        travel += stride;
        if (travel > 8.5) break;
    }

    vec3 color = flatColor * mix(0.72, 0.58, activity);
    if (hit) {
        vec3 shaped = bendSpace(position, hand);
        // Real surface position and depth determine parallax and texture
        // placement. This is not a flat image with a gyroid glow overlaid.
        vec2 surface = shaped.xy * 0.4;
        surface += vec2(sin(shaped.z * 0.7), cos(shaped.z * 0.6)) * 0.08;
        float parallax = mix(0.18, 0.58, activity);
        vec2 uv = sourceUV(mix(q, surface, parallax));
        float footprint = max(0.55, travel * mix(0.38, 0.62, activity));
        vec3 image = sourceColor(uv, dx * footprint, dy * footprint);
        vec3 normal = fieldNormal(position, hand);
        float diffuse = max(dot(normal, normalize(vec3(-0.4, -0.5, -1.0))), 0.0);
        float facing = abs(dot(normal, -ray));
        float rim = pow(1.0 - facing, 3.0);
        vec3 material = mix(palette(shaped.z * 0.18 + u_time * 0.025), image, u_imageMix);
        color = material * (0.48 + 0.52 * diffuse);
        color += palette(travel * 0.12 + u_time * 0.035) * rim * 0.38 * (1.0 - u_imageMix);
        color = mix(color, flatColor, mix(0.45, 0.26, activity) * u_imageMix);
        color = mix(color, flatColor * 0.7, 1.0 - exp(-travel * 0.045));
    }
    // imageMix=1 disables palette glow; morph=0 bypasses all of this.
    color += palette(glow * 0.2 + u_time * 0.035) * (1.0 - exp(-glow * 0.8))
        * (1.0 - u_imageMix) * mix(0.24, 0.5, activity);
    return color;
}

void main() {
    vec2 screen = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
    vec2 point = (screen - u_resolution * 0.5) / u_resolution.y;
    vec2 pointer = (u_pointer - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
    vec3 folded = motif(point);
    vec2 hand = motif(pointer).xy;
    vec2 q = bendMotif(folded.xy, hand);
    vec2 uv = sourceUV(q);
    // Compute gradients outside the variable raymarch/visibility branches.
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    // Keep the un-morphed composition pixel-faithful.  The editor, saved
    // scenes, and visual probes all rely on morph=0 being the source image,
    // not a "helpfully" colour-graded approximation of it.
    vec3 color = sourceColor(uv, dx, dy);
    if (u_morph > 0.0) {
        float activity = clamp(max(u_energy, u_pinch), 0.0, 1.0);
        float spatialMix = u_morph * mix(0.42, 0.95, activity);
        color = mix(color, renderField(q, hand, dx, dy, color), spatialMix);
    }
    if (u_guides) {
        float width = 1.25 / u_resolution.y;
        float line = 1.0 - smoothstep(width, width * 2.0, folded.z);
        color = mix(color, vec3(0.2, 0.95, 0.85), line * 0.65);
    }
    // No gamma, saturation, vignette or tone-map on the photographic path.
    outColor = vec4(color, 1.0);
}
`;

// Independent, deliberately small recovery shader. A failed driver compiler
// leaves an interactive image mirror available while onError reports details.
export const FALLBACK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_imageAspect;
uniform vec2 u_anchor;
uniform float u_zoom;
uniform vec3 u_background;
out vec4 outColor;
void main() {
    vec2 point = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y)
        - u_resolution * 0.5) / u_resolution.y;
    vec2 uv = u_anchor + abs(point) * 1.5 / (vec2(u_imageAspect, 1.0) * u_zoom);
    vec4 source = texture(u_image, uv);
    outColor = vec4(mix(u_background, source.rgb, source.a), 1.0);
}
`;
