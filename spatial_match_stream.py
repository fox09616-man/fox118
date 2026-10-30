#!/usr/bin/env python3
"""تنعيم مكاني عبر دليل منخفض الدقة، بلا DT أو ملفات إطارات وسيطة.

الحديث: الأصل -> دليل منخفض بارتفاع 9px مكبّر -> Joint Bilateral Filter على الأصل.
القديم: الأصل + LUT على الأصل -> دليل 9px من الأصل -> Joint Bilateral Filter على الأصل المصحح.
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

SVT_PARAMS = "tune=0:enable-qm=1:qm-min=0"


def probe_size(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path)],
        text=True).strip()
    w, h = out.split("x")
    return int(w), int(h)


def read_exact(pipe, count):
    data = bytearray()
    while len(data) < count:
        part = pipe.read(count - len(data))
        if not part:
            break
        data.extend(part)
    return bytes(data)


def filter_escape(path):
    value = str(path.resolve())
    for char in ("\\", ":", ",", "'", "[", "]"):
        value = value.replace(char, "\\" + char)
    return value


def even_dimensions(width, height, target_height):
    out_h = min(height, target_height) if target_height else height
    out_h = max(2, out_h // 2 * 2)
    out_w = max(2, int(round(width * out_h / height)) // 2 * 2)
    return out_w, out_h


def restore_clean_edges(reference, matched, strength):
    """Add a denoised, thin source-edge band-pass to the matched frame only."""
    if strength <= 0:
        return matched

    # BT.709 luma for edge detection; use mild bilateral denoising so grain is
    # not reintroduced as edge detail.
    b, g, r = cv2.split(reference.astype(np.float32))
    y = 0.0722 * b + 0.7152 * g + 0.2126 * r
    y8 = np.clip(np.rint(y), 0, 255).astype(np.uint8)
    clean = cv2.bilateralFilter(y8, d=5, sigmaColor=12, sigmaSpace=1.2)

    edge = cv2.Canny(clean, 30, 75, L2gradient=True)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(edge, 8)
    valid = stats[:, cv2.CC_STAT_AREA] >= 2
    valid[0] = False
    keep = (valid[labels].astype(np.uint8) * 255)

    # Thin the detected contour where contrib is available; otherwise retain
    # the cleaned Canny contour. A narrow feather avoids hard pasted outlines.
    if hasattr(cv2, "ximgproc") and hasattr(cv2.ximgproc, "thinning"):
        thin = cv2.ximgproc.thinning(keep)
    else:
        thin = keep
    band = cv2.dilate(thin, np.ones((3, 3), np.uint8), iterations=1)
    mask = cv2.GaussianBlur(band.astype(np.float32) / 255.0, (0, 0), 0.45)

    # A denoised Laplacian band-pass carries edge transitions, not source pixels.
    base = clean.astype(np.float32)
    detail = (cv2.GaussianBlur(base, (0, 0), 0.55) -
              cv2.GaussianBlur(base, (0, 0), 1.30))
    delta = np.clip(detail, -10.0, 10.0) * float(strength) * mask

    # Add the same offset to B/G/R: this changes luma while preserving channel
    # differences (chroma) unless a value reaches the legal 8-bit gamut limit.
    out = matched.astype(np.float32) + delta[..., None]
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--profile", choices=("modern", "old"), required=True,
                    help="modern: guide only؛ old: LUT ثم مطابقة مكانية")
    ap.add_argument("--lut3d", type=Path, default=None,
                    help="ملف CUBE؛ مطلوب لمسار old وممنوع لمسار modern")
    ap.add_argument("--crf", type=int, required=True, help="CRF بين 0 و63")
    ap.add_argument("--preset", type=int, default=4)
    ap.add_argument("--fps", default="24000/1001")
    ap.add_argument("--height", type=int, default=0,
                    help="ارتفاع الإخراج؛ 0 يحافظ على دقة المصدر بعد المطابقة")
    ap.add_argument("--guide-height", type=int, default=9,
                    help="ارتفاع دليل التصغير؛ الافتراضي 9 بكسلات لكلا مساري الأنمي")
    ap.add_argument("--edge-strength", type=float, default=0.65,
                    help="قوة استرجاع نطاق الحواف المنقّى من الأصل؛ 0 يعطّلها، والمدى المقترح 0.4-0.7")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--color-space", default="")
    ap.add_argument("--color-primaries", default="")
    ap.add_argument("--color-trc", default="")
    ap.add_argument("--color-range", default="")
    args = ap.parse_args()

    src = Path(args.input).resolve()
    dst = Path(args.output).resolve()
    if not src.is_file():
        raise FileNotFoundError(src)
    if args.profile == "old" and (args.lut3d is None or not args.lut3d.is_file()):
        raise FileNotFoundError("مسار القديم يتطلب LUT موجودًا؛ المتوقع grade_blend_warm_start16.cube")
    if args.profile == "modern" and args.lut3d is not None:
        raise ValueError("لا يُطبّق LUT في مسار الأنمي الحديث")
    if not 0 <= args.crf <= 63:
        raise ValueError("يجب أن يكون CRF بين 0 و63")
    if args.height < 0 or args.guide_height < 1 or args.threads < 1:
        raise ValueError("قيمة height أو guide-height أو threads غير صالحة")
    if not 0.0 <= args.edge_strength <= 1.0:
        raise ValueError("edge-strength يجب أن يكون بين 0 و1")
    if not hasattr(cv2, "ximgproc") or not hasattr(cv2.ximgproc, "jointBilateralFilter"):
        raise RuntimeError("يلزم opencv-contrib-python-headless مع ximgproc.jointBilateralFilter")

    width, height = probe_size(src)
    output_width, output_height = even_dimensions(width, height, args.height)
    guide_height = min(args.guide_height, height)
    guide_width = max(1, int(round(width * guide_height / height)))
    old = args.profile == "old"
    decode_width = width * 2 if old else width
    frame_bytes = decode_width * height * 3

    decoder = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(src)]
    if old:
        lut = filter_escape(args.lut3d)
        graph = (
            f"[0:v]fps={args.fps},split=2[original][graded];"
            "[original]format=bgr24[original_bgr];"
            f"[graded]lut3d=file={lut}:interp=tetrahedral,format=bgr24[graded_bgr];"
            "[original_bgr][graded_bgr]hstack=inputs=2[out]"
        )
        decoder += ["-filter_complex", graph, "-map", "[out]"]
    else:
        decoder += ["-vf", f"fps={args.fps},format=bgr24"]
    decoder += ["-fps_mode", "passthrough", "-an", "-f", "rawvideo",
                "-pix_fmt", "bgr24", "pipe:1"]

    encoder = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{output_width}x{output_height}",
               "-r", args.fps, "-i", "pipe:0", "-an", "-c:v", "libsvtav1",
               "-preset", str(args.preset), "-crf", str(args.crf), "-g", "240",
               "-pix_fmt", "yuv420p10le", "-svtav1-params", SVT_PARAMS]
    for option, value in (("-colorspace", args.color_space),
                          ("-color_primaries", args.color_primaries),
                          ("-color_trc", args.color_trc),
                          ("-color_range", args.color_range)):
        if value and value.lower() not in ("unknown", "unspecified", "n/a"):
            encoder.extend([option, value])
    encoder.append(str(dst))

    dst.parent.mkdir(parents=True, exist_ok=True)
    cv2.setUseOptimized(True)
    cv2.setNumThreads(min(args.threads, os.cpu_count() or 1))
    dec = subprocess.Popen(decoder, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    enc = subprocess.Popen(encoder, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    started = time.time()
    processed = 0
    print(f"المسار: {'أنمي قديم مع LUT' if old else 'أنمي حديث دون LUT'}؛ "
          f"دليل {guide_width}x{guide_height}؛ المصدر {width}x{height}؛ "
          f"المطابقة عند الدقة الأصلية ثم الإخراج {output_width}x{output_height}")

    try:
        while True:
            raw = read_exact(dec.stdout, frame_bytes)
            if len(raw) == 0:
                break
            if len(raw) != frame_bytes:
                raise RuntimeError(f"قراءة إطار غير مكتملة: {len(raw)} بدل {frame_bytes} بايت")
            if old:
                pair = np.frombuffer(raw, np.uint8).reshape(height, width * 2, 3)
                reference = pair[:, :width, :].copy()
                corrected = pair[:, width:, :].copy()
            else:
                reference = np.frombuffer(raw, np.uint8).reshape(height, width, 3).copy()
                corrected = reference
            small = cv2.resize(reference, (guide_width, guide_height), interpolation=cv2.INTER_AREA)
            guide = cv2.resize(small, (width, height), interpolation=cv2.INTER_CUBIC)
            matched = cv2.ximgproc.jointBilateralFilter(
                guide, corrected, d=9, sigmaColor=12.0, sigmaSpace=3.5,
                borderType=cv2.BORDER_REFLECT)
            matched = restore_clean_edges(reference, matched, args.edge_strength)
            if output_width != width or output_height != height:
                matched = cv2.resize(matched, (output_width, output_height),
                                      interpolation=cv2.INTER_AREA)
            enc.stdin.write(matched.tobytes())
            processed += 1
            if processed % 24 == 0:
                print(f"تمت مطابقة {processed} إطارًا؛ الزمن {time.time()-started:.1f} ثانية",
                      flush=True)
    finally:
        dec.stdout.close()
        dec_error = dec.stderr.read().decode("utf-8", "replace")
        dec_code = dec.wait()
        enc.stdin.close()
        enc_error = enc.stderr.read().decode("utf-8", "replace")
        enc_code = enc.wait()

    if dec_code or enc_code or processed == 0:
        raise RuntimeError(f"فشل خط المعالجة: فك FFmpeg={dec_code} {dec_error[-300:]}؛ "
                           f"ترميز FFmpeg={enc_code} {enc_error[-300:]}")
    print(f"اكتملت المعالجة: {processed} إطارًا؛ الحجم {dst.stat().st_size} بايت؛ "
          f"المدة {time.time()-started:.1f} ثانية")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, FileNotFoundError, subprocess.CalledProcessError,
            BrokenPipeError) as exc:
        print(f"خطأ: {exc}", file=sys.stderr)
        sys.exit(1)
