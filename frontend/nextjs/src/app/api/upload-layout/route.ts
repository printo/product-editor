import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ status: "ok" });
}

export async function POST(req: NextRequest) {
  const backendUrl = process.env.INTERNAL_API_URL || 'http://backend:8000/api';
  const url = `${backendUrl}/ops/layouts`;

  const token = req.headers.get("authorization");
  const contentType = req.headers.get("content-type") || '';

  try {
    // Pipe the raw body bytes directly to Django without buffering or re-serialising.
    // This preserves the multipart boundary so Gunicorn / Django can parse the file.
    const rawBody = await req.arrayBuffer();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...(token ? { "Authorization": token } : {}),
        "Accept": "application/json",
        // Forward the exact Content-Type (incl. boundary=…) unchanged
        "Content-Type": contentType,
      },
      body: rawBody,
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error: any) {
    console.error("Upload Proxy Error:", error);
    return NextResponse.json(
      { detail: error.message || 'Layout upload proxy failed' },
      { status: 500 }
    );
  }
}
