#!/usr/bin/env python3
"""
DT المزدوج المتصل على الدقة الكاملة للمصدر، بلا ملفات وسيطة.

ffmpeg (فك + تحويل المعدل قبل الاختيار) -> Python (DT + قناع زمني) -> ffmpeg (AV1)
الصوت لا يُعالَج هنا؛ يُدمج لاحقاً في مرحلة الدمج من الملف الصوتي المستقل.
"""
import argparse
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

SIGMA_SPATIAL = 40
SIGMA_COLOR_1 = 18
SIGMA_COLOR_2 = 60
EMA = 0.6
SVT_PARAMS = "tune=0:enable-overlays=1:sharpness=4:film-grain=0:enable-tf=0:lp=4"


def probe_size(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path)],
        text=True).strip()
    w, h = out.split("x")
    return int(w), int(h)


def read_exact(pipe, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = pipe.read(n - len(buf))
        if not chunk:
            break
        buf.extend(chunk)
    return bytes(buf)


def interior_weight(frame):
    g = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (0, 0), 2.0)
    e = cv2.Canny(g, 40, 100)
    e = cv2.dilate(e, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    e = cv2.GaussianBlur(e.astype(np.float32) / 255.0, (0, 0), 3.0)
    return np.clip(1.0 - e * 1.5, 0.0, 1.0)


def dt(frame, sigma_color):
    return cv2.ximgproc.dtFilter(guide=frame, src=frame,
                                 sigmaSpatial=SIGMA_SPATIAL,
                                 sigmaColor=sigma_color,
                                 mode=cv2.ximgproc.DTF_RF, numIters=3)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--crf", type=int, required=True, help="كرف الترميز النهائي 0-63")
    ap.add_argument("--preset", type=int, default=4)
    ap.add_argument("--fps", default="24000/1001", help="معدل الإخراج قبل الاختيار")
    ap.add_argument("--start-frame", type=int, default=0)
    ap.add_argument("--frames", type=int, default=0, help="0 = حتى النهاية")
    ap.add_argument("--warmup-frames", type=int, default=1)
    args = ap.parse_args()

    if not 0 <= args.crf <= 63:
        raise ValueError("CRF يجب أن يكون بين 0 و63")
    src = Path(args.input).resolve()
    dst = Path(args.output).resolve()
    if not src.is_file():
        raise FileNotFoundError(src)
    if not hasattr(cv2, "ximgproc") or not hasattr(cv2.ximgproc, "dtFilter"):
        raise RuntimeError("يلزم opencv-contrib-python-headless")

    W, H = probe_size(src)
    frame_bytes = W * H * 3
    context = min(max(args.warmup_frames, 0), args.start_frame)
    seek_frame = args.start_frame - context
    # البحث الدقيق إلى إطار من شبكة المعدل المطلوب، ثم تُحسب الإطارات من هذه النقطة
    num, den = (args.fps.split("/") + ["1"])[:2]
    seek_sec = seek_frame * int(den) / int(num)
    if args.frames:
        select = f"between(n\\,0\\,{context + args.frames - 1})"
    else:
        select = None
    vf = f"fps={args.fps}" + (f",select='{select}'" if select else "")
    dec_cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if seek_frame > 0:
        dec_cmd += ["-ss", f"{seek_sec:.6f}"]
    dec_cmd += ["-i", str(src), "-vf", vf,
                "-fps_mode", "passthrough", "-an"]
    if args.frames:
        # يوقف الفك بعد آخر إطار مطلوب بدل فك الملف حتى نهايته
        dec_cmd += ["-frames:v", str(context + args.frames)]
    dec_cmd += ["-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    enc_cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
               "-r", args.fps, "-i", "pipe:0",
               "-c:v", "libsvtav1", "-preset", str(args.preset), "-crf", str(args.crf),
               "-pix_fmt", "yuv420p10le", "-svtav1-params", SVT_PARAMS,
               "-an", str(dst)]

    dst.parent.mkdir(parents=True, exist_ok=True)
    dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    prev_w = None
    seen = encoded = 0
    try:
        while True:
            if args.frames and encoded >= args.frames:
                break
            buf = read_exact(dec.stdout, frame_bytes)
            if len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(H, W, 3).copy()
            seen += 1
            w = interior_weight(frame)
            w = w if prev_w is None else EMA * prev_w + (1.0 - EMA) * w
            prev_w = w
            if seen <= context:
                continue
            p1 = dt(frame, SIGMA_COLOR_1)
            p2 = dt(p1, SIGMA_COLOR_2)
            m = w[:, :, None]
            out = p1.astype(np.float32) * (1.0 - m) + p2.astype(np.float32) * m
            enc.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
            encoded += 1
            if encoded % 24 == 0:
                print(f"encoded {encoded} frames", flush=True)
    finally:
        dec.stdout.close()
        dec_err = dec.stderr.read().decode("utf-8", "replace")
        dec_rc = dec.wait()
        enc.stdin.close()
        enc_err = enc.stderr.read().decode("utf-8", "replace")
        enc_rc = enc.wait()

    stopped_early = bool(args.frames) and encoded >= args.frames
    if (dec_rc and not stopped_early) or enc_rc or encoded == 0:
        raise RuntimeError(f"فشل: decoder={dec_rc} {dec_err[:300]} encoder={enc_rc} {enc_err[:300]}")
    print(f"done: {encoded} frames -> {dst}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(f"خطأ: {exc}", file=sys.stderr)
        sys.exit(1)
