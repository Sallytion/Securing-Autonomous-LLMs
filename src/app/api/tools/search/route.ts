import { NextRequest } from "next/server";
import { searchDuckDuckGo } from "@/lib/webTools";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const query = body?.query;

    if (typeof query !== "string" || !query.trim()) {
      return Response.json({ error: "Query is required." }, { status: 400 });
    }

    const result = await searchDuckDuckGo(query);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Search failed.",
      },
      { status: 500 }
    );
  }
}
