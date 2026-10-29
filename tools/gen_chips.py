"""用 Blender 无头渲染筹码堆 sprite。

用法：
  blender -b --python tools/gen_chips.py -- --denom 100 --count 6 --out /tmp/chip.png --px 256

设计约束（与 index.html 的实际尺寸对齐）：
- 牌桌是俯视椭圆，所以相机用正交 + 约 55° 仰角：能看到筹码顶面椭圆和侧面齿纹，
  又不至于像正前方平视。
- 透明背景（film_transparent），阴影用 shadow catcher 烘进 alpha，这样贴到任何
  底色上都成立，不需要在 CSS 里再补一层假阴影。
- 色管理用 Standard 而不是默认 AgX：AgX 会把筹码的红/绿压暗、饱和度漂移，
  导致 sprite 和 tokens.css 里的色值对不上。
"""
import math
import os
import random
import sys

import bpy
from mathutils import Vector

# 面额 → 主色 / 顶面镶片色。色相遵循赌场惯例（25 绿 / 100 黑 / 500 紫 / 1000 金），
# 但饱和度统一压低，符合克制拟物。
DENOMS = {
    50:   {'base': (0.035, 0.095, 0.290), 'inlay': (0.62, 0.61, 0.56)},
    100:  {'base': (0.045, 0.045, 0.050), 'inlay': (0.62, 0.61, 0.56)},
    500:  {'base': (0.115, 0.045, 0.190), 'inlay': (0.70, 0.69, 0.63)},
    1000: {'base': (0.560, 0.400, 0.070), 'inlay': (0.10, 0.10, 0.10)},
}
EDGE_SPOT = (0.60, 0.58, 0.52)      # 侧面边点色：不能太白，小尺寸会闪
RADIUS = 1.0
# 厚度刻意夸大：真实比例(3.3mm/39mm=0.085)在 24–30px 显示尺寸下，每加一枚
# 只高 1.2px，堆高信息等于丢失。0.28 => 每枚约 2.6px，8 枚可见 20px 落差。
THICK = 0.28
GAP = 0.014                         # 层间缝
STRIPES = 6                         # 侧面边点数量：6 个在 26px 下才不糊
ELEV_DEG = 55                       # 相机仰角：兼顾顶面可辨与侧面厚度


def parse_args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    opts = {'denom': 100, 'count': 1, 'out': '/tmp/chip.png', 'ppu': 96, 'samples': 64}
    it = iter(argv)
    for a in it:
        if a.startswith('--'):
            key = a[2:]
            val = next(it)
            opts[key] = int(val) if key in ('denom', 'count', 'ppu', 'samples') else val
    return opts


def new_material(name, base, rough=0.42, metallic=0.0, stripes=0):
    """stripes>0 时在侧面生成齿纹（边点）：用环向 UV 做条带遮罩。"""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metallic

    if not stripes:
        bsdf.inputs['Base Color'].default_value = (*base, 1.0)
        return mat

    # 圆柱侧面的 UV 的 U 轴正好环向一圈
    coord = nt.nodes.new('ShaderNodeTexCoord')
    wave = nt.nodes.new('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'X'
    wave.inputs['Scale'].default_value = stripes
    wave.inputs['Distortion'].default_value = 0.0
    nt.links.new(coord.outputs['UV'], wave.inputs['Vector'])

    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (*base, 1.0)
    ramp.color_ramp.elements[1].position = 0.62        # 边点比底色窄
    ramp.color_ramp.elements[1].color = (*EDGE_SPOT, 1.0)
    nt.links.new(wave.outputs['Color'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def build_chip(name, denom, idx):
    """单枚筹码：圆柱 + 倒角 + 顶面镶片，侧面带边点，面色按面额。"""
    spec = DENOMS[denom]
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=96, radius=RADIUS, depth=THICK, location=(0, 0, THICK / 2))
    chip = bpy.context.object
    chip.name = f'{name}_{idx}'

    bevel = chip.modifiers.new('bevel', 'BEVEL')
    bevel.width = 0.022
    bevel.segments = 2
    bpy.ops.object.modifier_apply(modifier=bevel.name)

    # 0 号材质给侧面（带边点），1 号给顶/底面（筹码本体色，比镶片深）
    edge_mat = new_material(f'edge_{idx}', spec['base'], rough=0.40, stripes=STRIPES)
    face_mat = new_material(f'face_{idx}', spec['base'], rough=0.34)
    chip.data.materials.append(edge_mat)
    chip.data.materials.append(face_mat)
    for poly in chip.data.polygons:
        # 侧面法线接近水平；顶/底面法线接近 ±Z
        poly.material_index = 1 if abs(poly.normal.z) > 0.6 else 0

    # 顶面镶片：内缩薄盘，用对比色，缩到游戏尺寸后仍能看出这是一枚筹码
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=64, radius=RADIUS * 0.55, depth=0.012, location=(0, 0, THICK + 0.004))
    inlay = bpy.context.object
    inlay.name = f'{name}_{idx}_inlay'
    inlay.data.materials.append(new_material(f'inlay_{idx}', spec['inlay'], rough=0.22))
    return [chip, inlay]


def setup_scene(opts):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = opts['samples']
    sc.cycles.use_denoising = True
    sc.render.film_transparent = True
    # 关掉 AgX，保留色值准确
    sc.view_settings.view_transform = 'Standard'
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'

    world = bpy.data.worlds.new('w')
    sc.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.22
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.40, 0.38, 1)


def add_shadow_catcher(z=0.0):
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, z))
    plane = bpy.context.object
    plane.name = 'shadow_catcher'
    plane.is_shadow_catcher = True
    return plane


def add_lights():
    """光从左上：和页面里所有阴影方向保持一致。"""
    key_data = bpy.data.lights.new('key', 'AREA')
    key_data.energy = 190
    key_data.size = 3.0
    key = bpy.data.objects.new('key', key_data)
    key.location = (-2.2, -2.6, 3.6)
    bpy.context.scene.collection.objects.link(key)

    fill_data = bpy.data.lights.new('fill', 'AREA')
    fill_data.energy = 45
    fill_data.size = 4.0
    fill = bpy.data.objects.new('fill', fill_data)
    fill.location = (2.8, -1.6, 1.4)
    bpy.context.scene.collection.objects.link(fill)
    return key, fill


def add_camera(target_z, ortho_scale):
    cam_data = bpy.data.cameras.new('cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = ortho_scale
    cam = bpy.data.objects.new('cam', cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    elev = math.radians(ELEV_DEG)
    dist = 12.0
    cam.location = (0, -dist * math.cos(elev), target_z + dist * math.sin(elev))
    direction = Vector((0, 0, target_z)) - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    return cam


def main():
    opts = parse_args()
    denom = opts['denom']
    count = max(1, opts['count'])
    if denom not in DENOMS:
        raise SystemExit(f'未知面额 {denom}，可选: {sorted(DENOMS)}')

    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup_scene(opts)
    add_lights()

    rng = random.Random(hash((denom, count)) & 0xFFFFFFFF)
    for i in range(count):
        parts = build_chip('chip', denom, i)
        # 叠放时给每枚一点点旋转/位移抖动，避免像用尺子摆的
        rot_z = math.radians(rng.uniform(-7, 7))
        dx = rng.uniform(-0.012, 0.012)
        dy = rng.uniform(-0.012, 0.012)
        for ob in parts:
            ob.rotation_euler[2] = rot_z
            ob.location.x += dx
            ob.location.y += dy
            # 层间留 0.014 的缝：没有缝的话 6 枚会糊成一个整块，看不出"一摞"
            ob.location.z += i * (THICK + GAP)

    # 不用 Cycles 的 shadow catcher：大面光源会让"阴影"铺满整帧，
    # 平铺到页面上就是一整块矩形脏边。接触阴影改在后期用 Pillow 画。
    stack_h = count * (THICK + GAP)
    # 固定像素/单位：所有档位共用同一比例，CSS 里换图不会跳动
    ppu = opts['ppu']
    elev = math.radians(ELEV_DEG)
    # 斜看的圆盘：屏幕纵向占位 = 顶面投影(2R·sin仰角) + 堆高投影(H·cos仰角)
    w_units = RADIUS * 2 + 0.34
    h_units = 2 * RADIUS * math.sin(elev) + stack_h * math.cos(elev) + 0.26
    sc = bpy.context.scene
    sc.render.resolution_x = int(round(w_units * ppu))
    sc.render.resolution_y = int(round(h_units * ppu))
    # Blender 的 ortho_scale 作用于较长的那一维
    ortho_scale = w_units if w_units >= h_units else h_units
    add_camera(target_z=stack_h / 2, ortho_scale=ortho_scale)

    out = os.path.abspath(opts['out'])
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    bpy.context.scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print(f'CHIP_RENDER_OK denom={denom} count={count} out={out}')


if __name__ == '__main__':
    main()
