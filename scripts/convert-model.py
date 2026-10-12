"""
Convert Real-ESRGAN `realesr-general-x4v3.pth` (BSD-3-Clause, xinntao/Real-ESRGAN)
to an ONNX model with a fixed 1x3xTILExTILE input, for onnxruntime-web (WebGPU/WASM).

Usage:
  python -m venv venv && ./venv/bin/pip install "torch==2.5.1" "onnx==1.17.0" "onnxruntime==1.19.2" "numpy<2"
  curl -LO https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth
  ./venv/bin/python scripts/convert-model.py realesr-general-x4v3.pth public/models/realesr-general-x4v3.onnx

Graph notes (to keep every op on the WebGPU execution provider):
  - PReLU is written as relu(x) - a * relu(-x).
  - PixelShuffle is written as reshape/transpose (static shapes).
"""

import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

TILE = 192
SCALE = 4
NUM_FEAT = 64
NUM_CONV = 32


class PReLUExport(nn.Module):
    def __init__(self, n):
        super().__init__()
        self.weight = nn.Parameter(torch.zeros(n))

    def forward(self, x):
        a = self.weight.view(1, -1, 1, 1)
        return F.relu(x) - a * F.relu(-x)


class SRVGGNetCompact(nn.Module):
    """Architecture from Real-ESRGAN (realesrgan/archs/srvgg_arch.py), BSD-3-Clause."""

    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=NUM_FEAT, num_conv=NUM_CONV, upscale=SCALE):
        super().__init__()
        self.upscale = upscale
        self.num_out_ch = num_out_ch
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(PReLUExport(num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(PReLUExport(num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        # PixelShuffle(r): (1, C*r*r, H, W) -> (1, C, H*r, W*r)
        r, c = self.upscale, self.num_out_ch
        _, _, h, w = out.shape
        out = out.reshape(1, c, r, r, h, w).permute(0, 1, 4, 2, 5, 3).reshape(1, c, h * r, w * r)
        base = F.interpolate(x, scale_factor=r, mode="nearest")
        return out + base


def main(src: str, dst: str):
    state = torch.load(src, map_location="cpu", weights_only=True)
    state = state.get("params_ema", state.get("params", state))
    model = SRVGGNetCompact()
    model.load_state_dict(state, strict=True)
    model.eval()

    # Sanity check against torch's own PReLU / PixelShuffle.
    x = torch.rand(1, 3, TILE, TILE)
    with torch.no_grad():
        y = model(x)
        ref = x
        for layer in model.body:
            ref = F.prelu(ref, layer.weight) if isinstance(layer, PReLUExport) else layer(ref)
        ref = F.pixel_shuffle(ref, SCALE) + F.interpolate(x, scale_factor=SCALE, mode="nearest")
    assert torch.allclose(y, ref, atol=1e-4), "export graph differs from reference"

    torch.onnx.export(
        model,
        x,
        dst,
        input_names=["input"],
        output_names=["output"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )

    import onnxruntime as ort

    sess = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
    out = sess.run(None, {"input": x.numpy()})[0]
    err = float(np.abs(out - y.numpy()).max())
    print(f"wrote {dst}: output {out.shape}, max abs error vs torch {err:.2e}")
    assert err < 1e-3


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
