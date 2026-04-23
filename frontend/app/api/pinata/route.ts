import { NextRequest, NextResponse } from "next/server";

type PinataResponse = {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
};

export async function POST(request: NextRequest) {
  const pinataApiKey = process.env.PINATA_API_KEY;
  const pinataSecretApiKey = process.env.PINATA_SECRET_API_KEY;
  const pinataGateway = process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud";

  if (!pinataApiKey || !pinataSecretApiKey) {
    return NextResponse.json(
      { error: "Pinata credentials are not configured." },
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

  const tag =
    typeof payload === "object" && payload !== null && "tag" in payload
      ? String((payload as { tag: unknown }).tag).trim()
      : "General";

  if (!text) {
    return NextResponse.json(
      { error: "Field 'text' is required." },
      { status: 400 },
    );
  }

  if (text.length > 6000) {
    return NextResponse.json(
      { error: "Text exceeds pinning payload limits." },
      { status: 400 },
    );
  }

  const createdAt = new Date().toISOString();

  try {
    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        pinata_api_key: pinataApiKey,
        pinata_secret_api_key: pinataSecretApiKey,
      },
      body: JSON.stringify({
        pinataMetadata: {
          name: `veritas-post-${Date.now()}`,
        },
        pinataContent: {
          text,
          tag,
          createdAt,
          source: "veritas",
        },
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const detail = await response.text();
      return NextResponse.json(
        {
          error: "Pinata upload failed.",
          detail: detail.slice(0, 240),
        },
        { status: 502 },
      );
    }

    const data = (await response.json()) as PinataResponse;

    return NextResponse.json({
      cid: data.IpfsHash,
      pinSize: data.PinSize,
      timestamp: data.Timestamp,
      gatewayUrl: `${pinataGateway.replace(/\/$/, "")}/ipfs/${data.IpfsHash}`,
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach Pinata API." },
      { status: 502 },
    );
  }
}
