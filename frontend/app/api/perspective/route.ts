import { NextRequest, NextResponse } from "next/server";

const TOXICITY_THRESHOLD = 0.8;
const HF_MODEL_URL = "https://router.huggingface.co/hf-inference/models/unitary/toxic-bert";

type HfLabel = {
  label: string;
  score: number;
};

type HfInferenceError = {
  error?: string;
};

export async function POST(request: NextRequest) {
  const huggingFaceToken = process.env.HUGGINGFACE_TOKEN;

  if (!huggingFaceToken) {
    return NextResponse.json(
      { error: "HUGGINGFACE_TOKEN is not configured." },
      { status: 500 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const text =
    typeof payload === "object" && payload !== null && "text" in payload
      ? String((payload as { text: unknown }).text).trim()
      : "";

  if (!text) {
    return NextResponse.json(
      { error: "Field 'text' is required." },
      { status: 400 },
    );
  }

  if (text.length > 6000) {
    return NextResponse.json(
      { error: "Text exceeds moderation payload limits." },
      { status: 400 },
    );
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(HF_MODEL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${huggingFaceToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: text,
        options: { wait_for_model: true },
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const raw = await response.text();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const isJson = contentType.includes("application/json");

    if (!isJson) {
      const snippet = raw.slice(0, 240).replace(/\s+/g, " ").trim();
      return NextResponse.json(
        {
          error: `Hugging Face returned a non-JSON response (status ${response.status}). ${snippet}`,
          status: response.status,
          detail: raw.slice(0, 240),
        },
        { status: 503 },
      );
    }

    let result: HfLabel[][] | HfInferenceError = {};
    try {
      result = (raw ? JSON.parse(raw) : {}) as HfLabel[][] | HfInferenceError;
    } catch {
      const snippet = raw.slice(0, 240).replace(/\s+/g, " ").trim();
      return NextResponse.json(
        {
          error: `Hugging Face returned invalid JSON (status ${response.status}). ${snippet}`,
          status: response.status,
          detail: raw.slice(0, 240),
        },
        { status: 503 },
      );
    }

    if (!response.ok || ("error" in result && result.error)) {
      const detail = "error" in result ? result.error : "Hugging Face moderation request failed.";
      return NextResponse.json(
        { error: detail, status: response.status },
        { status: 503 },
      );
    }

    const labels = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
    const toxicLabel = labels.find((label) => label.label.toLowerCase() === "toxic");
    const toxicityScore = toxicLabel?.score ?? 0;
    const isToxic = toxicityScore >= TOXICITY_THRESHOLD;

    return NextResponse.json({
      toxicityScore,
      threshold: TOXICITY_THRESHOLD,
      isToxic,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not reach Hugging Face Inference API.";

    return NextResponse.json(
      { error: `Could not reach Hugging Face Inference API: ${message}` },
      { status: 502 },
    );
  }
}
