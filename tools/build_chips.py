#!/usr/bin/env python3
"""批量生成筹码堆 sprite：Blender 渲染 → Pillow 后处理（裁边 + 接触阴影）→ WebP。

为什么阴影在后期画而不是用 Blender 的 shadow catcher：
shadow catcher 用大面光源时会产出一层铺满整帧的半透明阴影，裁到画幅边界
就是一条矩形硬边，贴到页面上非常明显。后期画椭圆阴影完全可控，且所有档位
阴影一致。

用法：
  python3 tools/build_chips.py                 # 全量
  python3 tools/build_chips.py --denom 100     # 只跑一个面额
  python3 tools/build_chips.py --preview       # 额外输出拼版预览图
"""
import argparse
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLENDER_SCRIPT = os.path.join(ROOT, 'tools', 'gen_chips.py')
OUT_DIR = os.path.join(ROOT, 'public', 'assets', 'chips')

DENOMS = [50, 100, 500, 1000]
# 高度档：1–6 覆盖绝大多数下注组合，8 档留给大注
HEIGHTS = [1, 2, 3, 4, 5, 6, 8]
# 文件名里的版本号：服务端对 /assets/chips/ 下发 immutable 长缓存，
# 所以改了渲染参数必须递增这个号，否则老用户永远看到旧图。
# 前端 public/index.html 的 ASSET_VERSION 必须同步。
CHIP_VERSION = 1
PPU = 96
SAMPLES = 48

SHADOW_ALPHA = 105
SHADOW_OFFSET_X = 0.055      # 光来自左上 → 阴影偏右下
SHADOW_OFFSET_Y = 0.030


def render(denom, count, dst):
    cmd = [
        'blender', '-b', '--python', BLENDER_SCRIPT, '--',
        '--denom', str(denom), '--count', str(count),
        '--out', dst, '--ppu', str(PPU), '--samples', str(SAMPLES),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or 'CHIP_RENDER_OK' not in res.stdout:
        raise RuntimeError(f'渲染失败 denom={denom} count={count}\n{res.stdout[-800:]}\n{res.stderr[-800:]}')


def trim(img, threshold=8):
    alpha = img.getchannel('A')
    mask = np.asarray(alpha) > threshold
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if len(rows) == 0 or len(cols) == 0:
        raise RuntimeError('渲染结果全透明')
    return img.crop((int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1))


def add_contact_shadow(chip):
    """在筹码下方画一枚柔和椭圆阴影，返回带阴影的新图。

    垫边由阴影几何反推（ry + 偏移 + 2×模糊半径），保证阴影完全落在画幅内——
    否则底部被裁掉一条，贴到页面上就是一道淡边。
    """
    w, h = chip.size
    blur = max(1.5, w * 0.035)
    rx = w * 0.50
    ry = rx * 0.42
    off_x = w * SHADOW_OFFSET_X
    off_y = w * SHADOW_OFFSET_Y

    pad_x = int(max(4, off_x + blur * 2))
    pad_top = int(max(3, h * 0.02))
    pad_bottom = int(ry + off_y + blur * 2 + 2)

    canvas_w = w + pad_x * 2
    canvas_h = h + pad_top + pad_bottom
    canvas = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))

    cx = canvas_w / 2 + off_x
    cy = pad_top + h + off_y          # 影子中心压在筹码底部接触线上

    shadow = Image.new('L', (canvas_w, canvas_h), 0)
    ImageDraw.Draw(shadow).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=SHADOW_ALPHA)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=blur))

    shadow_layer = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    shadow_layer.putalpha(shadow)
    canvas = Image.alpha_composite(canvas, shadow_layer)
    canvas.alpha_composite(chip, (pad_x, pad_top))
    return canvas


def build_one(denom, count, workdir, preview=False):
    raw = os.path.join(workdir, f'{denom}_{count}.png')
    render(denom, count, raw)
    chip = trim(Image.open(raw).convert('RGBA'))
    sprite = add_contact_shadow(chip)
    name = f'chip-{denom}-x{count}-v{CHIP_VERSION}.webp'
    dst = os.path.join(OUT_DIR, name)
    sprite.save(dst, 'WEBP', quality=88, method=6)
    size_kb = os.path.getsize(dst) / 1024
    print(f'  {name:<22} {sprite.size[0]}×{sprite.size[1]}  {size_kb:5.1f} KB')
    return dst, sprite, size_kb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--denom', type=int, default=None)
    ap.add_argument('--preview', action='store_true')
    args = ap.parse_args()

    denoms = [args.denom] if args.denom else DENOMS
    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0.0
    made = []

    for denom in denoms:
        print(f'面额 {denom}:')
        for count in HEIGHTS:
            with tempfile.TemporaryDirectory() as work:
                dst, sprite, kb = build_one(denom, count, work, args.preview)
                total += kb
                made.append((denom, count, sprite))
    print(f'合计 {len(made)} 个 sprite，{total:.1f} KB')

    if args.preview:
        # 拼版预览：按面额分行，按高度档从左到右，全部底对齐
        cell_w = max(s.width for _, _, s in made) + 12
        cell_h = max(s.height for _, _, s in made) + 12
        sheet = Image.new('RGBA', (cell_w * len(HEIGHTS) + 12, cell_h * len(denoms) + 12),
                          (23, 96, 61, 255))
        for row, denom in enumerate(denoms):
            for col, count in enumerate(HEIGHTS):
                sp = next(s for d, c, s in made if d == denom and c == count)
                x = 12 + col * cell_w + (cell_w - 12 - sp.width) // 2
                y = 12 + row * cell_h + (cell_h - 12 - sp.height)
                sheet.alpha_composite(sp, (x, y))
        out = '/tmp/chips-preview.png'
        sheet.convert('RGB').save(out)
        print(f'预览图: {out}  {sheet.size[0]}×{sheet.size[1]}')


if __name__ == '__main__':
    sys.exit(main())
