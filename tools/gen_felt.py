#!/usr/bin/env python3
"""程序化生成无缝平铺的赌桌织物 (baize) 纹理。

为什么用程序化生成而不是找素材：确定性、可复现、参数可调、零授权风险，
且不依赖任何生成模型或 GPU。

无缝原理：所有噪声层都在频域做高斯滤波（等价于周期卷积），因此任何频率
成分在 512×512 边界上都严格周期；斜纹组织用整数波数合成，同样周期。
所以 3×3 平铺时接缝处不会出现断线或网格。

三层结构：
  1. 低频色斑 —— 布料受光不均、染色深浅
  2. 中频纤维 —— 绒面毛羽
  3. 斜纹组织 —— 36° twill 织纹（赌桌织物的识别特征）
  + 高频颗粒 —— 极细噪点，避免大面积色块显假

用法：
  python3 tools/gen_felt.py              # 生成纹理
  python3 tools/gen_felt.py --check      # 生成纹理并输出接缝一致性度量
"""
import os
import sys

import numpy as np
from PIL import Image

SIZE = 512
SEED = 7
# 中间调绿：具体明暗/聚光交给 CSS 渐变，纹理本身保持中性，便于换色
BASE = np.array([38.0, 104.0, 70.0])
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'public', 'assets', 'tex')
OUT_NAME = 'felt-512-v1.webp'


def periodic_lowpass(noise, sigma):
    """频域高斯低通：结果在边界上严格周期，保证平铺无缝。"""
    n = noise.shape[0]
    fy = np.fft.fftfreq(n)[:, None]
    fx = np.fft.fftfreq(n)[None, :]
    radius2 = fx ** 2 + fy ** 2
    gauss = np.exp(-2.0 * (np.pi ** 2) * (sigma ** 2) * radius2)
    return np.real(np.fft.ifft2(np.fft.fft2(noise) * gauss))


def normalize(a):
    lo, hi = float(a.min()), float(a.max())
    if hi - lo < 1e-9:
        return np.zeros_like(a)
    return (a - lo) / (hi - lo) * 2.0 - 1.0


def build(size=SIZE, seed=SEED):
    rng = np.random.default_rng(seed)

    # 1. 低频色斑：sigma 大 => 只剩大块明暗。幅度压低，否则平铺后能看出 512 的重复块
    low = normalize(periodic_lowpass(rng.normal(size=(size, size)), 42.0))

    # 2. 中频纤维（绒面毛羽）
    fiber = normalize(periodic_lowpass(rng.normal(size=(size, size)), 1.9))

    # 3. 斜纹组织：整数波数 => 周期。k1/k2 比决定织纹角度(≈36°)
    x = np.arange(size, dtype=np.float64)[None, :]
    y = np.arange(size, dtype=np.float64)[:, None]
    k1, k2 = 72, 52
    phase = 2.0 * np.pi * (k1 * x + k2 * y) / size
    twill = np.sin(phase) + 0.32 * np.sin(2.0 * phase)
    # 交叉横纹：打散斜纹的过度规则感，更像绒面而不是条纹布
    cross_phase = 2.0 * np.pi * (-38 * x + 61 * y) / size
    cross = np.sin(cross_phase) + 0.28 * np.sin(2.0 * cross_phase)

    # 4. 高频颗粒：逐像素白噪声，离散采样本身就是周期的
    grain = rng.normal(size=(size, size))

    shade = (1.0
             + 0.028 * low          # 受光不均（压弱，避免可见重复）
             + 0.070 * fiber        # 毛羽：主要质感来源
             + 0.055 * twill        # 织纹（斜）
             + 0.026 * cross        # 交叉横纹
             + 0.040 * grain)       # 颗粒

    rgb = BASE[None, None, :] * shade[..., None]

    # 轻微色相漂移：织物染色深浅时偏黄/偏青，避免纯灰度缩放显得死板
    rgb[..., 0] *= 1.0 + 0.012 * low
    rgb[..., 1] *= 1.0 + 0.010 * fiber

    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), 'RGB')


def seam_report(img):
    """量接缝：比较跨边界像素差与内部相邻像素差。两者接近 => 无缝。"""
    a = np.asarray(img, dtype=np.float64)
    across_x = float(np.abs(a[:, 0, :] - a[:, -1, :]).mean())
    across_y = float(np.abs(a[0, :, :] - a[-1, :, :]).mean())
    inner_x = float(np.abs(a[:, 1:, :] - a[:, :-1, :]).mean())
    inner_y = float(np.abs(a[1:, :, :] - a[:-1, :, :]).mean())
    print(f'  接缝(左右): {across_x:.3f}  内部相邻列差: {inner_x:.3f}')
    print(f'  接缝(上下): {across_y:.3f}  内部相邻行差: {inner_y:.3f}')
    ok = (across_x <= inner_x * 1.6 + 0.5) and (across_y <= inner_y * 1.6 + 0.5)
    print('  判定: ' + ('无缝（接缝差与内部差同量级）' if ok else '存在接缝，需调整'))
    return ok


def main():
    check = '--check' in sys.argv
    img = build()
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, OUT_NAME)
    img.save(out, 'WEBP', quality=86, method=6)
    print(f'已生成: {out}  ({os.path.getsize(out) / 1024:.1f} KB, {img.size[0]}×{img.size[1]})')

    if check:
        print('接缝度量:')
        seam_report(img)
        # 3×3 平铺效果图，供肉眼复核
        tile = Image.new('RGB', (SIZE * 3, SIZE * 3))
        for row in range(3):
            for col in range(3):
                tile.paste(img, (col * SIZE, row * SIZE))
        tile_path = '/tmp/felt-tile-check.png'
        tile.save(tile_path)
        print(f'平铺校验图: {tile_path}')
        # 放大校验图：裁 160×160 最近邻放大 3 倍，用来确认织纹结构没有被压平
        crop = img.crop((176, 176, 336, 336)).resize((480, 480), Image.NEAREST)
        zoom_path = '/tmp/felt-zoom-check.png'
        crop.save(zoom_path)
        print(f'放大校验图: {zoom_path}')


if __name__ == '__main__':
    main()
