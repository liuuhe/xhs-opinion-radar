import argparse
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForSequenceClassification, AutoTokenizer


class SequenceClassificationOnnxWrapper(torch.nn.Module):
    def __init__(self, model) -> None:
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask, token_type_ids):
        return self.model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=token_type_ids,
        ).logits


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Export the fine-tuned sentiment model to ONNX.")
    parser.add_argument("--model-dir", default="models/xhs-bert-sentiment", help="Fine-tuned Hugging Face model directory.")
    parser.add_argument("--output", default="", help="Output ONNX path. Defaults to <model-dir>/model.onnx.")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--opset", type=int, default=18)
    parser.add_argument("--quantize", action="store_true", help="Also create <model-dir>/model-int8.onnx with dynamic int8 quantization.")
    parser.add_argument("--verify", action="store_true", help="Run a small ONNX Runtime parity check after export.")
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    output_path = Path(args.output) if args.output else model_dir / "model.onnx"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    model = AutoModelForSequenceClassification.from_pretrained(model_dir, attn_implementation="eager")
    model.config._attn_implementation = "eager"
    model.config._attn_implementation_internal = "eager"
    model.eval()

    encoded = tokenizer(
        ["服务很耐心，下次还会去。", "排队太久了，体验很差。"],
        padding=True,
        truncation=True,
        max_length=args.max_length,
        return_tensors="pt",
    )
    input_names = ["input_ids", "attention_mask", "token_type_ids"]
    dynamic_axes = {
        name: {0: "batch", 1: "sequence"}
        for name in input_names
    }
    dynamic_axes["logits"] = {0: "batch"}

    wrapped_model = SequenceClassificationOnnxWrapper(model)
    wrapped_model.eval()
    with torch.no_grad():
        torch.onnx.export(
            wrapped_model,
            tuple(encoded[name] for name in input_names),
            output_path,
            input_names=input_names,
            output_names=["logits"],
            dynamic_axes=dynamic_axes,
            opset_version=args.opset,
            dynamo=True,
        )

    if args.quantize:
        quantized_path = output_path.with_name("model-int8.onnx")
        quantize_dynamic(
            model_input=str(output_path),
            model_output=str(quantized_path),
            weight_type=QuantType.QInt8,
        )
        print(f"Quantized ONNX model exported: {quantized_path}")

    if args.verify:
        verify_export(model, tokenizer, output_path, args.max_length)
        if args.quantize:
            verify_export(model, tokenizer, output_path.with_name("model-int8.onnx"), args.max_length, tolerance=0.08)

    print(f"ONNX model exported: {output_path}")


def verify_export(model, tokenizer, output_path: Path, max_length: int, tolerance: float = 1e-3) -> None:
    texts = ["服务很耐心，下次还会去。", "排队太久了，体验很差。", "价格略高，不过味道稳定。"]
    encoded_pt = tokenizer(texts, padding=True, truncation=True, max_length=max_length, return_tensors="pt")
    encoded_np = tokenizer(texts, padding=True, truncation=True, max_length=max_length, return_tensors="np")
    with torch.no_grad():
        torch_logits = model(**encoded_pt).logits.detach().cpu().numpy()

    session = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    input_names = {item.name for item in session.get_inputs()}
    ort_inputs = {key: value.astype(np.int64) for key, value in encoded_np.items() if key in input_names}
    onnx_logits = session.run(None, ort_inputs)[0]
    max_diff = float(np.max(np.abs(torch_logits - onnx_logits)))
    print(f"ONNX verification {output_path.name} max_abs_diff={max_diff:.6f}")
    if max_diff > tolerance:
        raise SystemExit(f"ONNX verification failed: max_abs_diff={max_diff:.6f}")


if __name__ == "__main__":
    main()
