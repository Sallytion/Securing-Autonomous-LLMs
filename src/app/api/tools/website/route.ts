import { NextRequest } from "next/server";
import { fetchWebsiteText } from "@/lib/webTools";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const url = body?.url;

    if (typeof url !== "string" || !url.trim()) {
      return Response.json({ error: "URL is required." }, { status: 400 });
    }

    const result = await fetchWebsiteText(url);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Website fetch failed.",
      },
      { status: 500 }
    );
  }
}
