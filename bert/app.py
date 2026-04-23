import os
from typing import Literal

import numpy as np
import onnxruntime as ort
import torch
from fastapi import FastAPI
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_DIR = os.getenv("MODEL_DIR", "model")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "google-bert/bert-base-chinese")
ONNX_MODEL_FILE = os.getenv("ONNX_MODEL_FILE", "")
MAX_LENGTH = int(os.getenv("MAX_LENGTH", "256"))

LABELS = ["negative", "neutral", "positive"]
ID_TO_LABEL = {index: label for index, label in enumerate(LABELS)}
LOW_CONFIDENCE_THRESHOLD = 0.5
POSITIVE_TERMS = (
    "不错",
    "喜欢",
    "满意",
    "推荐",
    "耐心",
    "舒服",
    "划算",
    "稳定",
    "惊喜",
    "及时",
    "清楚",
    "好",
)
NEGATIVE_TERMS = (
    "差",
    "离谱",
    "失望",
    "不值",
    "普通",
    "太吵",
    "很吵",
    "麻烦",
    "噪音",
    "踩雷",
    "没有回复",
    "不耐烦",
    "问题",
)
NEUTRAL_TERMS = ("一般", "还行", "可以接受", "观望", "中规中矩", "略高", "先看看")


class Sample(BaseModel):
    sample_id: str = Field(alias="sample_id")
    text: str


class PredictRequest(BaseModel):
    samples: list[Sample]


class LabelRow(BaseModel):
    sample_id: str
    label: Literal["positive", "neutral", "negative"]
    confidence: float
    reason_short: str


class PredictResponse(BaseModel):
    labels: list[LabelRow]


app = FastAPI(title="XHS BERT Sentiment Service")
tokenizer = None
model = None
onnx_session = None
onnx_input_names: set[str] = set()
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


@app.on_event("startup")
def load_model() -> None:
    global tokenizer, model, onnx_session, onnx_input_names
    has_local_model = os.path.exists(MODEL_DIR)
    model_path = MODEL_DIR if has_local_model else FALLBACK_MODEL
    tokenizer = AutoTokenizer.from_pretrained(model_path)
    onnx_file = find_onnx_model_file(MODEL_DIR)
    onnx_path = os.path.join(MODEL_DIR, onnx_file) if onnx_file else ""
    if has_local_model and os.path.exists(onnx_path):
        onnx_session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
        onnx_input_names = {item.name for item in onnx_session.get_inputs()}
        model = None
    elif has_local_model:
        model = AutoModelForSequenceClassification.from_pretrained(model_path)
    else:
        model = AutoModelForSequenceClassification.from_pretrained(
            model_path,
            num_labels=3,
            id2label=ID_TO_LABEL,
            label2id={label: index for index, label in ID_TO_LABEL.items()},
        )
    if model is not None:
        model.to(device)
        model.eval()


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "modelDir": MODEL_DIR,
        "fallbackModel": FALLBACK_MODEL,
        "runtime": "onnxruntime" if onnx_session is not None else "pytorch",
        "onnxModelFile": find_onnx_model_file(MODEL_DIR),
        "device": str(device),
    }


@app.post("/predict", response_model=PredictResponse)
def predict(request: PredictRequest) -> PredictResponse:
    if not request.samples:
        return PredictResponse(labels=[])

    texts = [sample.text[:300] for sample in request.samples]
    if onnx_session is not None:
        probabilities = predict_probabilities_onnx(texts)
        predictions = np.argmax(probabilities, axis=-1).tolist()
        confidences = np.max(probabilities, axis=-1).tolist()
    else:
        probabilities_tensor = predict_probabilities_torch(texts)
        confidences_tensor, predictions_tensor = torch.max(probabilities_tensor, dim=-1)
        predictions = predictions_tensor.tolist()
        confidences = confidences_tensor.tolist()

    labels = []
    for sample, prediction, confidence in zip(request.samples, predictions, confidences):
        label = ID_TO_LABEL.get(prediction, "neutral")
        reason = "bert"
        if confidence < LOW_CONFIDENCE_THRESHOLD:
            rule_label = rule_label_for(sample.text)
            if rule_label:
                label = rule_label
                confidence = max(confidence, 0.62)
                reason = "bert+rules"

        labels.append(
            LabelRow(
                sample_id=sample.sample_id,
                label=label,
                confidence=round(float(confidence), 4),
                reason_short=reason,
            )
        )
    return PredictResponse(labels=labels)


def predict_probabilities_onnx(texts: list[str]) -> np.ndarray:
    encoded = tokenizer(
        texts,
        padding=True,
        truncation=True,
        max_length=MAX_LENGTH,
        return_tensors="np",
    )
    inputs = {key: value.astype(np.int64) for key, value in encoded.items() if key in onnx_input_names}
    logits = onnx_session.run(None, inputs)[0]
    logits = logits - np.max(logits, axis=-1, keepdims=True)
    exp = np.exp(logits)
    return exp / np.sum(exp, axis=-1, keepdims=True)


def predict_probabilities_torch(texts: list[str]) -> torch.Tensor:
    encoded = tokenizer(
        texts,
        padding=True,
        truncation=True,
        max_length=MAX_LENGTH,
        return_tensors="pt",
    ).to(device)

    with torch.no_grad():
        logits = model(**encoded).logits
        return torch.softmax(logits, dim=-1)


def find_onnx_model_file(model_dir: str) -> str:
    if ONNX_MODEL_FILE:
        return ONNX_MODEL_FILE
    for filename in ("model-int8.onnx", "model.onnx"):
        if os.path.exists(os.path.join(model_dir, filename)):
            return filename
    return ""


def rule_label_for(text: str) -> Literal["positive", "neutral", "negative"] | None:
    positive_hits = sum(1 for term in POSITIVE_TERMS if term in text)
    negative_hits = sum(1 for term in NEGATIVE_TERMS if term in text)
    neutral_hits = sum(1 for term in NEUTRAL_TERMS if term in text)

    if positive_hits and negative_hits:
        return "neutral"
    if negative_hits > positive_hits:
        return "negative"
    if positive_hits > negative_hits:
        return "positive"
    if neutral_hits:
        return "neutral"
    return None
