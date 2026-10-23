#!/usr/bin/env python3
"""مرحلة DT المزدوج: تقرأ bgr24 من stdin وتكتب الناتج إلى stdout."""
import argparse
import sys

import cv2
import numpy as np

SIGMA_SPATIAL = 40
SIGMA_COLOR_1 = 18
SIGMA_COLOR_2 = 60
EMA = 0.6


def read_exact(stream, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            break
        buf.extend(chunk)
    return bytes(buf)


def interior_weight(frame):
    """وزن المساحة الداخلية: 1 داخل المساحات، 0 قرب الحواف."""
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    args = ap.parse_args()
    W, H = args.width, args.height
    frame_bytes = W * H * 3

    inp, out = sys.stdin.buffer, sys.stdout.buffer
    prev_w = None
    while True:
        buf = read_exact(inp, frame_bytes)
        if len(buf) < frame_bytes:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(H, W, 3).copy()
        p1 = dt(frame, SIGMA_COLOR_1)
        p2 = dt(p1, SIGMA_COLOR_2)
        w = interior_weight(frame)
        if prev_w is not None:
            w = EMA * prev_w + (1.0 - EMA) * w
        prev_w = w
        m = w[:, :, None]
        res = p1.astype(np.float32) * (1.0 - m) + p2.astype(np.float32) * m
        out.write(np.clip(res, 0, 255).astype(np.uint8).tobytes())
    out.flush()


if __name__ == "__main__":
    main()
