import { NextRequest, NextResponse } from "next/server";

const TOXICITY_THRESHOLD = 0.8;

type PerspectiveApiResponse = {
  attributeScores?: {
    TOXICITY?: {
      summaryScore?: {
        value?: number;
      };
    };
  };
};

export async function POST(request: NextRequest) {
  const perspectiveApiKey = process.env.PERSPECTIVE_API_KEY;

  if (!perspectiveApiKey) {
    return NextResponse.json(
      { error: "PERSPECTIVE_API_KEY is not configured." },
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

  const endpoint = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${perspectiveApiKey}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        comment: { text },
        languages: ["en"],
        doNotStore: true,
        requestedAttributes: {
          TOXICITY: {},
        },
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const detail = await response.text();
      return NextResponse.json(
        {
          error: "Perspective API request failed.",
          detail: detail.slice(0, 240),
        },
        { status: 502 },
      );
    }

    const result = (await response.json()) as PerspectiveApiResponse;
    const toxicityScore =
      result.attributeScores?.TOXICITY?.summaryScore?.value ?? 0;

    return NextResponse.json({
      toxicityScore,
      threshold: TOXICITY_THRESHOLD,
      isToxic: toxicityScore >= TOXICITY_THRESHOLD,
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach Perspective API." },
      { status: 502 },
    );
  }
}
