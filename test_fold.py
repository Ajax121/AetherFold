"""
test_fold.py - real-time kaleidoscopic gyroid raymarcher.

Usage:
    python test_fold.py
    python test_fold.py images/Screenshot.png
    python test_fold.py images

Controls:
    UP / DOWN  increase / decrease mirror fold count (2..32)
    I          toggle image texture influence
    G          toggle gyroid/fractal layer
    TAB        cycle the dominant source image
    B          toggle geometric multi-image collage / selected-image mode
    M          cycle connected mirror, full-image tiling, square, diamond, triangle, and polar layouts
    Left drag  locally warp the folded space (gesture prototype)
    WASD       refine the automatically chosen source anchor
    +/-        zoom folded image sampling in/out
    R          reset image pan/zoom
    SPACE      pause / resume time
    ESC        quit

Requires: pip install pygame moderngl numpy
"""
from pathlib import Path
import sys

import moderngl
import numpy as np
import pygame

WIDTH, HEIGHT = 1920, 1080
FPS = 60
FOLD_MIN, FOLD_MAX, FOLD_STEP = 2.0, 32.0, 1.0
PAN_STEP = 0.035
ZOOM_MIN, ZOOM_MAX, ZOOM_STEP = 0.35, 3.0, 1.12
MAX_IMAGES = 16
ATLAS_CELL_SIZE = 768
SUPPORTED_EXTENSIONS = {".avif", ".bmp", ".jpeg", ".jpg", ".png", ".tga", ".webp"}
PREFERRED_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".tga"}

VERTEX_SHADER = """
#version 330 core
in vec2 in_pos;
void main() {
    gl_Position = vec4(in_pos, 0.0, 1.0);
}
"""

FRAGMENT_SHADER = """
#version 330 core
uniform float u_time;
uniform vec2  u_resolution;
uniform float u_folds;
uniform sampler2D u_image;
uniform float u_has_image;
uniform float u_image_mix;
uniform vec2  u_image_center;
uniform float u_image_zoom;
uniform float u_gyroid_mix;
uniform vec2  u_atlas_grid;
uniform float u_image_count;
uniform float u_source_index;
uniform float u_blend_all;
uniform float u_cell_size;
uniform float u_pattern_mode;
uniform vec2  u_gesture;
uniform float u_gesture_strength;
out vec4 fragColor;

#define MAX_STEPS 128
#define MAX_DIST  20.0
#define SURF_EPS  0.001

mat2 rot(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, -s, s, c);
}

vec2 foldSymmetry(vec2 p, float folds) {
    float angle = 3.14159265359 / folds;
    float a = mod(atan(p.y, p.x), 2.0 * angle) - angle;
    return vec2(cos(a), abs(sin(a))) * length(p);
}

vec3 palette(float t) {
    vec3 a = vec3(0.5);
    vec3 b = vec3(0.5);
    vec3 c = vec3(1.0);
    vec3 d = vec3(0.00, 0.33, 0.67);
    return a + b * cos(6.28318530718 * (c * t + d));
}

vec3 preserveVisionaryColor(vec3 color) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, 1.35);
    color = (color - 0.5) * 1.16 + 0.5;
    return clamp(color, 0.0, 1.0);
}

vec2 mirrorTile(vec2 uv) {
    return abs(fract(uv) * 2.0 - 1.0);
}

// A local bend in texture space.  Mouse drag supplies the gesture now; this is
// deliberately a separate uniform so a camera/hand-tracking input can replace
// it later without changing the image-folding system.
vec2 gestureWarp(vec2 p) {
    vec2 delta = p - u_gesture;
    float radius = length(delta);
    vec2 direction = delta / max(radius, 0.0001);
    float falloff = exp(-radius * 3.5) * u_gesture_strength;
    float ripple = sin(radius * 22.0 - u_time * 4.0) * 0.045;
    return p + direction * (falloff + ripple * u_gesture_strength);
}

vec3 sampleAtlas(float index, vec2 uv) {
    float count = max(u_image_count, 1.0);
    float safe_index = mod(index, count);
    float col = mod(safe_index, u_atlas_grid.x);
    float row = floor(safe_index / u_atlas_grid.x);
    vec2 atlas_uv = (vec2(col, row) + clamp(uv, 0.001, 0.999)) / u_atlas_grid;
    return texture(u_image, atlas_uv).rgb;
}

vec3 sampleAtlasSharp(float index, vec2 uv) {
    vec2 px = vec2(1.0 / (u_atlas_grid.x * u_cell_size), 1.0 / (u_atlas_grid.y * u_cell_size));
    vec3 center = sampleAtlas(index, uv);
    vec3 blur = (
        sampleAtlas(index, uv + vec2(px.x, 0.0)) +
        sampleAtlas(index, uv - vec2(px.x, 0.0)) +
        sampleAtlas(index, uv + vec2(0.0, px.y)) +
        sampleAtlas(index, uv - vec2(0.0, px.y))
    ) * 0.25;
    return preserveVisionaryColor(center + (center - blur) * 0.65);
}

float autoImageIndex(vec2 p, float ring, float sector) {
    return sector + ring * 3.0 + floor(u_time * 0.05) + u_source_index;
}

float radialSeam(vec2 p) {
    float angle = atan(p.y, p.x) + 3.14159265359;
    float phase = fract(angle / 6.28318530718 * max(u_folds, 1.0));
    return 1.0 - smoothstep(0.0, 0.055, min(phase, 1.0 - phase));
}

vec3 sampleFoldedImage(vec2 p) {
    vec2 q = foldSymmetry(p, u_folds);
    q *= rot(-u_time * 0.025);
    q /= max(u_image_zoom, 0.05);

    vec2 tex_uv = mirrorTile(q * 0.42 + 0.5 + u_image_center);
    float angle = atan(p.y, p.x) + 3.14159265359;
    float sector = floor(angle / 6.28318530718 * max(u_folds, 1.0));
    float ring_coord = length(q) * 2.65;
    float ring = floor(ring_coord);
    float ring_phase = fract(ring_coord);

    float primary = mix(u_source_index, autoImageIndex(p, ring, sector), u_blend_all);
    vec3 base = sampleAtlasSharp(primary, tex_uv);
    vec3 wedge_neighbor = sampleAtlasSharp(primary + 1.0, mirrorTile(tex_uv.yx + vec2(0.17, 0.31)));
    vec3 ring_neighbor = sampleAtlasSharp(primary + 3.0, mirrorTile(tex_uv * 1.23 + vec2(0.11, 0.07)));

    float r_seam = radialSeam(p);
    float ring_seam = 1.0 - smoothstep(0.0, 0.08, min(ring_phase, 1.0 - ring_phase));
    vec3 collage = mix(base, wedge_neighbor, r_seam * 0.55);
    collage = mix(collage, ring_neighbor, ring_seam * 0.38);

    return mix(base, collage, u_blend_all);
}

// Every layout samples the same image through reflected coordinates.  The
// reflected boundaries make adjacent copies meet without an exposed hard edge.
// Mode 0 deliberately makes a 2x2 arrangement, like the supplied fashion
// reference: one image is reflected across both the horizontal and vertical
// axes.  The other modes use the same source for clear square, diamond, and
// triangular/repeated-wedge motifs.
vec3 sampleSymmetricImage(vec2 p) {
    if (u_pattern_mode < 0.5) {
        // This is a genuine connected four-way mirror: each axis starts at the
        // source's centre, so a face/body/shape touches its reflection at the
        // seam.  It avoids the blank source borders meeting in the middle.
        vec2 reach = abs(p * vec2(1.125, 2.0) / max(u_image_zoom, 0.05));
        vec2 anchor = clamp(vec2(0.5) + u_image_center, 0.02, 0.98);
        vec2 tex_uv = clamp(anchor + reach * (1.0 - anchor), 0.001, 0.999);
        return sampleAtlasSharp(u_source_index, tex_uv);
    }

    if (u_pattern_mode < 1.5) {
        // Two full mirrored image cells across each axis.  This retains the
        // complete outline, but works best when the subject is near an edge.
        vec2 cells = p * vec2(1.125, 2.0) / max(u_image_zoom, 0.05);
        return sampleAtlasSharp(u_source_index, mirrorTile(cells + u_image_center));
    }

    if (u_pattern_mode < 2.5) {
        // Square lattice: repeated image cells with alternating reflections.
        vec2 cells = p * 2.25 / max(u_image_zoom, 0.05);
        return sampleAtlasSharp(u_source_index, mirrorTile(cells + u_image_center));
    }

    if (u_pattern_mode < 3.5) {
        // The same seamless lattice, rotated into a diamond grid.
        vec2 cells = rot(0.78539816339) * p * 2.15 / max(u_image_zoom, 0.05);
        return sampleAtlasSharp(u_source_index, mirrorTile(cells + u_image_center));
    }

    // Polar wedges make repeated triangular facets.  This preserves the
    // fold-count control, so UP/DOWN directly changes the triangle density.
    vec2 wedge = foldSymmetry(p, max(u_folds, 3.0));
    wedge *= rot(-u_time * 0.025);
    wedge *= 1.55 / max(u_image_zoom, 0.05);
    return sampleAtlasSharp(u_source_index, mirrorTile(wedge + u_image_center));
}

float symmetrySeams(vec2 p) {
    vec2 q;
    if (u_pattern_mode < 0.5) {
        // The centre is already a continuous reflected seam; no drawn line.
        return 0.0;
    } else if (u_pattern_mode < 1.5) {
        q = p * vec2(1.125, 2.0) / max(u_image_zoom, 0.05);
    } else if (u_pattern_mode < 2.5) {
        q = p * 2.25 / max(u_image_zoom, 0.05);
    } else if (u_pattern_mode < 3.5) {
        q = rot(0.78539816339) * p * 2.15 / max(u_image_zoom, 0.05);
    } else if (u_pattern_mode < 4.5) {
        return radialSeam(p);
    }
    return 0.0;

    vec2 grid = abs(sin(3.14159265359 * q));
    float nearest_edge = min(grid.x, grid.y);
    return 1.0 - smoothstep(0.0, 0.028, nearest_edge);
}

float map(vec3 p) {
    // Rotate the whole space, then fold it into an N-fold kaleidoscope.
    p.xy *= rot(u_time * 0.20);
    p.yz *= rot(u_time * 0.13);
    p.xy = foldSymmetry(p.xy, u_folds);
    p.z += u_time * 0.4;

    float g = abs(dot(sin(p * 2.5), cos(p.zxy * 2.5))) - 0.25;
    // The gyroid field is not a true distance; scale it down for safe stepping.
    return g / 2.5 * 0.7;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;

    vec3 ro = vec3(0.0, 0.0, -3.5);
    vec3 rd = normalize(vec3(uv, 1.3));

    float t = 0.0;
    float glow = 0.0;
    int steps = 0;
    bool hit = false;

    for (int i = 0; i < MAX_STEPS; i++) {
        vec3 p = ro + rd * t;
        float dS = map(p);
        glow += 1.0 / (1.0 + abs(dS) * 12.0);
        steps = i;
        if (abs(dS) < SURF_EPS) { hit = true; break; }
        t += max(abs(dS), 0.002);
        if (t > MAX_DIST) break;
    }

    float stepRatio = float(steps) / float(MAX_STEPS);
    vec3 gyroid_col = palette(stepRatio * 1.5 + u_time * 0.08) * glow * 0.012;
    vec2 image_point = gestureWarp(uv * 1.45);
    vec3 image_col = u_pattern_mode < 4.5
        ? sampleSymmetricImage(image_point)
        : sampleFoldedImage(image_point);

    if (hit) {
        float fog = exp(-0.15 * t);
        vec3 hit_pos = ro + rd * t;
        image_point = gestureWarp(hit_pos.xy + hit_pos.z * 0.12);
        image_col = u_pattern_mode < 4.5
            ? sampleSymmetricImage(image_point)
            : sampleFoldedImage(image_point);
        gyroid_col += palette(t * 0.15 + u_time * 0.05 + 0.5) * fog * (1.0 - stepRatio);
    }

    image_col = pow(image_col, vec3(1.05));
    float vignette = smoothstep(1.35, 0.20, length(uv));
    float radial_lines = smoothstep(0.012, 0.0, abs(sin(atan(uv.y, uv.x) * u_folds)));
    float ring_lines = smoothstep(0.012, 0.0, abs(sin(length(uv) * 22.0 - u_time * 0.4)));
    float geometric_seams = symmetrySeams(image_point);
    vec3 col = image_col * (0.88 + glow * 0.0025) * (0.72 + vignette * 0.38);
    float triangle_mode = step(3.5, u_pattern_mode) - step(4.5, u_pattern_mode);
    col += palette(length(uv) + u_time * 0.04) * radial_lines * triangle_mode * 0.06;
    col += vec3(0.04, 0.055, 0.08) * geometric_seams;
    col += palette(length(uv) * 0.5 + 0.2) * ring_lines * u_blend_all * 0.035;
    col += gyroid_col * u_gyroid_mix * 0.65;
    col = mix(gyroid_col, col, u_has_image * u_image_mix);

    col = 1.0 - exp(-col * 1.4);        // tone map
    col = pow(col, vec3(0.4545));       // gamma
    fragColor = vec4(col, 1.0);
}
"""


def choose_image_sources():
    if len(sys.argv) > 1:
        source = Path(sys.argv[1])
    else:
        source = Path("images")

    if source.is_dir():
        png_stems = {
            path.stem
            for path in source.iterdir()
            if path.is_file() and path.suffix.lower() == ".png"
        }
        paths = []

        for path in sorted(source.iterdir()):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix in {".avif", ".webp"} and path.stem in png_stems:
                continue
            if suffix in PREFERRED_EXTENSIONS:
                paths.append(path)

        return paths[:MAX_IMAGES]

    if source.exists():
        png_path = source.with_suffix(".png")
        converted_path = source.parent / "converted" / f"{source.name}.png"
        if source.suffix.lower() in {".avif", ".webp"} and png_path.exists():
            return [png_path]
        if source.suffix.lower() == ".avif" and converted_path.exists():
            return [converted_path]
        return [source]

    return []


def contain_square(surface, size):
    width, height = surface.get_size()
    # Do not crop portraits or landscapes: the complete outline is important
    # when the image is reflected into a geometric pattern.
    scale = size / max(width, height)
    scaled_size = (round(width * scale), round(height * scale))
    scaled = pygame.transform.smoothscale(surface, scaled_size)
    square = pygame.Surface((size, size), pygame.SRCALPHA, 32)
    corners = (
        surface.get_at((0, 0)),
        surface.get_at((width - 1, 0)),
        surface.get_at((0, height - 1)),
        surface.get_at((width - 1, height - 1)),
    )
    matte = tuple(round(sum(color[channel] for color in corners) / 4) for channel in range(3))
    square.fill((*matte, 255))
    square.blit(scaled, ((size - scaled_size[0]) // 2, (size - scaled_size[1]) // 2))
    return square


def estimate_focal_anchor(surface):
    """Return a texture-space offset pointing at the image's detailed subject.

    A border-colour distance plus local edge energy is a lightweight substitute
    for segmentation.  It works well for a figure or eye on a plain backdrop
    and gives artists a useful default; WASD remains available to correct it.
    """
    analysis_size = 192
    preview = pygame.transform.smoothscale(surface, (analysis_size, analysis_size))
    pixels = pygame.surfarray.array3d(preview).astype(np.float32).transpose(1, 0, 2) / 255.0
    luminance = np.dot(pixels, np.array([0.2126, 0.7152, 0.0722], dtype=np.float32))

    grad_x = np.zeros_like(luminance)
    grad_y = np.zeros_like(luminance)
    grad_x[:, 1:-1] = np.abs(luminance[:, 2:] - luminance[:, :-2])
    grad_y[1:-1, :] = np.abs(luminance[2:, :] - luminance[:-2, :])
    edges = np.hypot(grad_x, grad_y)

    border = np.concatenate((pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]))
    background = np.median(border, axis=0)
    foreground = np.linalg.norm(pixels - background, axis=2)
    saliency = 0.55 * edges / max(float(edges.max()), 1e-6)
    saliency += 0.45 * foreground / max(float(foreground.max()), 1e-6)

    # Ignore broad low-detail backdrop values and use the remaining energy as a
    # weighted centre.  A centre fallback makes flat/abstract images stable.
    weights = np.maximum(saliency - np.percentile(saliency, 65.0), 0.0)
    total = float(weights.sum())
    if total < 1e-6:
        return (0.0, 0.0)

    ys, xs = np.indices(weights.shape, dtype=np.float32)
    x = float((weights * xs).sum() / total / (analysis_size - 1))
    y = float((weights * ys).sum() / total / (analysis_size - 1))
    # Texture coordinates run bottom-to-top after pygame.image.tostring(...,
    # True), while the analysis array runs top-to-bottom.
    return (min(0.42, max(-0.42, x - 0.5)), min(0.42, max(-0.42, 0.5 - y)))


def make_fallback_texture(ctx):
    pixels = np.array(
        [
            255, 255, 255, 255,
            210, 100, 255, 255,
            80, 220, 255, 255,
            255, 230, 90, 255,
        ],
        dtype=np.uint8,
    )
    texture = ctx.texture((2, 2), 4, pixels.tobytes())
    texture.build_mipmaps()
    texture.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
    texture.repeat_x = True
    texture.repeat_y = True
    return texture, (1, 1), 1, False, [(0.0, 0.0)]


def build_image_atlas(ctx, image_paths):
    loaded = []

    for path in image_paths:
        try:
            surface = pygame.image.load(str(path)).convert_alpha()
        except pygame.error as exc:
            print(f"Skipping {path}: {exc}")
            continue

        cell = contain_square(surface, ATLAS_CELL_SIZE)
        loaded.append((path, cell, estimate_focal_anchor(cell)))

        if len(loaded) >= MAX_IMAGES:
            break

    if not loaded:
        return make_fallback_texture(ctx)

    cols = int(np.ceil(np.sqrt(len(loaded))))
    rows = int(np.ceil(len(loaded) / cols))
    atlas = pygame.Surface((cols * ATLAS_CELL_SIZE, rows * ATLAS_CELL_SIZE), pygame.SRCALPHA, 32)

    for index, (_, surface, _) in enumerate(loaded):
        x = index % cols
        y = index // cols
        atlas.blit(surface, (x * ATLAS_CELL_SIZE, y * ATLAS_CELL_SIZE))

    pixels = pygame.image.tostring(atlas, "RGBA", True)
    texture = ctx.texture(atlas.get_size(), 4, pixels)
    texture.build_mipmaps()
    texture.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
    texture.repeat_x = False
    texture.repeat_y = False

    if hasattr(texture, "anisotropy"):
        texture.anisotropy = min(8.0, ctx.info.get("GL_MAX_TEXTURE_MAX_ANISOTROPY", 8.0))

    print(f"Loaded {len(loaded)} image(s) into {cols}x{rows} atlas:")
    anchors = []
    for index, (path, _, anchor) in enumerate(loaded):
        anchors.append(anchor)
        print(f"  {index:02d}: {path}  focal anchor {anchor[0]:+.2f}, {anchor[1]:+.2f}")

    return texture, (cols, rows), len(loaded), True, anchors


def main():
    pygame.init()
    pygame.display.gl_set_attribute(pygame.GL_CONTEXT_MAJOR_VERSION, 3)
    pygame.display.gl_set_attribute(pygame.GL_CONTEXT_MINOR_VERSION, 3)
    pygame.display.gl_set_attribute(pygame.GL_CONTEXT_PROFILE_MASK, pygame.GL_CONTEXT_PROFILE_CORE)
    pygame.display.gl_set_attribute(pygame.GL_CONTEXT_FORWARD_COMPATIBLE_FLAG, True)  # required on macOS
    pygame.display.set_mode((WIDTH, HEIGHT), pygame.OPENGL | pygame.DOUBLEBUF)
    pygame.display.set_caption(f"Kaleidoscopic Gyroid - test_fold.py ({WIDTH}x{HEIGHT})")
    pygame.key.set_repeat(250, 60)

    ctx = moderngl.create_context()
    prog = ctx.program(vertex_shader=VERTEX_SHADER, fragment_shader=FRAGMENT_SHADER)
    image_texture, atlas_grid, image_count, has_image, focal_anchors = build_image_atlas(
        ctx, choose_image_sources()
    )
    image_texture.use(location=0)

    # Full-screen quad as two triangles.
    quad = np.array([
        -1.0, -1.0,   1.0, -1.0,   1.0,  1.0,
        -1.0, -1.0,   1.0,  1.0,  -1.0,  1.0,
    ], dtype="f4")
    vbo = ctx.buffer(quad.tobytes())
    vao = ctx.vertex_array(prog, [(vbo, "2f", "in_pos")])

    prog["u_resolution"].value = (float(WIDTH), float(HEIGHT))
    prog["u_image"].value = 0
    prog["u_atlas_grid"].value = (float(atlas_grid[0]), float(atlas_grid[1]))
    prog["u_cell_size"].value = float(ATLAS_CELL_SIZE)

    clock = pygame.time.Clock()
    sim_time = 0.0
    folds = 6.0
    paused = False
    image_mix = 1.0 if has_image else 0.0
    # Keep the source readable by default; G restores/removes the richer field.
    gyroid_mix = 0.18
    image_center = list(focal_anchors[0])
    # Start slightly into the subject region: connected folds read as one
    # evolving organism rather than four pictures separated by background.
    image_zoom = 1.35
    source_index = 0
    blend_all = False
    pattern_mode = 0
    pattern_names = (
        "connected four-way mirror",
        "four full-image mirrors",
        "square lattice",
        "diamond lattice",
        "triangle kaleidoscope",
        "polar collage",
    )
    gesture_active = False
    gesture = [0.0, 0.0]
    print(f"Folds: {folds:.0f}")
    print(f"Pattern: {pattern_names[pattern_mode]}")

    running = True
    while running:
        dt = clock.tick(FPS) / 1000.0

        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                gesture_active = True
            elif event.type == pygame.MOUSEBUTTONUP and event.button == 1:
                gesture_active = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    running = False
                elif event.key == pygame.K_SPACE:
                    paused = not paused
                    print("Paused" if paused else "Resumed")
                elif event.key == pygame.K_i:
                    image_mix = 0.0 if image_mix > 0.0 else 1.0
                    print(f"Image texture: {'on' if image_mix > 0.0 else 'off'}")
                elif event.key == pygame.K_g:
                    gyroid_mix = 0.0 if gyroid_mix > 0.0 else 0.18
                    print(f"Gyroid layer: {'on' if gyroid_mix > 0.0 else 'off'}")
                elif event.key == pygame.K_TAB:
                    source_index = (source_index + 1) % max(image_count, 1)
                    image_center = list(focal_anchors[source_index])
                    print(
                        f"Source image: {source_index}; focal anchor "
                        f"{image_center[0]:+.2f}, {image_center[1]:+.2f}"
                    )
                elif event.key == pygame.K_b:
                    blend_all = not blend_all
                    print(
                        f"Image blend: {'multi-image' if blend_all else 'selected image'} "
                        "(used by polar collage)"
                    )
                elif event.key == pygame.K_m:
                    pattern_mode = (pattern_mode + 1) % len(pattern_names)
                    print(f"Pattern: {pattern_names[pattern_mode]}")
                elif event.key == pygame.K_r:
                    image_center = list(focal_anchors[source_index])
                    image_zoom = 1.35
                    print("Image anchor and zoom reset to the analysed focal region")
                elif event.key in (pygame.K_w, pygame.K_a, pygame.K_s, pygame.K_d):
                    if event.key == pygame.K_w:
                        image_center[1] += PAN_STEP
                    elif event.key == pygame.K_s:
                        image_center[1] -= PAN_STEP
                    elif event.key == pygame.K_a:
                        image_center[0] -= PAN_STEP
                    elif event.key == pygame.K_d:
                        image_center[0] += PAN_STEP
                    image_center[0] = min(0.5, max(-0.5, image_center[0]))
                    image_center[1] = min(0.5, max(-0.5, image_center[1]))
                    print(f"Image center: {image_center[0]:+.2f}, {image_center[1]:+.2f}")
                elif event.key in (pygame.K_EQUALS, pygame.K_PLUS, pygame.K_KP_PLUS):
                    image_zoom = min(ZOOM_MAX, image_zoom * ZOOM_STEP)
                    print(f"Image zoom: {image_zoom:.2f}x")
                elif event.key in (pygame.K_MINUS, pygame.K_UNDERSCORE, pygame.K_KP_MINUS):
                    image_zoom = max(ZOOM_MIN, image_zoom / ZOOM_STEP)
                    print(f"Image zoom: {image_zoom:.2f}x")
                elif event.key in (pygame.K_UP, pygame.K_DOWN):
                    delta = FOLD_STEP if event.key == pygame.K_UP else -FOLD_STEP
                    new_folds = min(FOLD_MAX, max(FOLD_MIN, folds + delta))
                    if new_folds != folds:
                        folds = new_folds
                        print(f"Folds: {folds:.0f}")

        if not paused:
            sim_time += dt

        # Use the real framebuffer size so Retina/HiDPI displays fill correctly.
        fb_w, fb_h = ctx.screen.size
        ctx.viewport = (0, 0, fb_w, fb_h)
        window_w, window_h = pygame.display.get_window_size()
        mouse_x, mouse_y = pygame.mouse.get_pos()
        gesture[0] = (mouse_x - 0.5 * window_w) / max(window_h, 1)
        gesture[1] = (0.5 * window_h - mouse_y) / max(window_h, 1)
        prog["u_resolution"].value = (float(fb_w), float(fb_h))
        prog["u_time"].value = sim_time
        prog["u_folds"].value = folds
        prog["u_has_image"].value = 1.0 if has_image else 0.0
        prog["u_image_mix"].value = image_mix
        prog["u_image_center"].value = tuple(image_center)
        prog["u_image_zoom"].value = image_zoom
        prog["u_gyroid_mix"].value = gyroid_mix
        prog["u_image_count"].value = float(image_count)
        prog["u_source_index"].value = float(source_index)
        prog["u_blend_all"].value = 1.0 if blend_all else 0.0
        prog["u_pattern_mode"].value = float(pattern_mode)
        prog["u_gesture"].value = tuple(gesture)
        prog["u_gesture_strength"].value = 0.26 if gesture_active else 0.0

        ctx.clear(0.0, 0.0, 0.0)
        image_texture.use(location=0)
        vao.render(moderngl.TRIANGLES)
        pygame.display.flip()

    vao.release()
    vbo.release()
    image_texture.release()
    prog.release()
    ctx.release()
    pygame.quit()
    sys.exit(0)


if __name__ == "__main__":
    main()
