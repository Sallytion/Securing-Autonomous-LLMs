const TOOL_TIMEOUT_MS = 12000;
const MAX_WEBSITE_TEXT_CHARS = 12000;
const MAX_SEARCH_RESULTS = 5;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

export type WebsiteTextResult = {
  url: string;
  title: string | null;
  text: string;
  excerpt: string;
};

export type SearchResultItem = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchResult = {
  query: string;
  results: SearchResultItem[];
};

export type ToolInvocation = {
  kind: "website" | "search";
  prompt: string;
  context: string;
  meta: WebsiteTextResult | WebSearchResult;
};

export const webToolDefinitions = [
  {
    type: "function",
    function: {
      name: "website_fetch",
      description:
        "Fetch a public webpage and return only its extracted readable text. Use this when the user gives a URL or asks you to inspect a website.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The public http or https URL to fetch.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web using DuckDuckGo and return the top result titles, URLs, and snippets. Use this for current web lookup requests.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The DuckDuckGo search query.",
          },
        },
        required: ["query"],
      },
    },
  },
] as const;

function createTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, num: string) =>
      String.fromCharCode(parseInt(num, 10))
    );
}

function collapseWhitespace(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collapseReadableLines(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stripHtmlToText(html: string) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? collapseWhitespace(decodeHtmlEntities(titleMatch[1])) : null;

  const withoutNonVisible = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const withBreaks = withoutNonVisible.replace(
    /<\/?(?:article|aside|blockquote|br|div|footer|h[1-6]|header|hr|li|main|nav|p|pre|section|table|td|th|tr|ul|ol)\b[^>]*>/gi,
    "\n"
  );

  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(withoutTags);
  const text = collapseReadableLines(decoded).slice(0, MAX_WEBSITE_TEXT_CHARS);

  return {
    title,
    text,
    excerpt: text.slice(0, 400),
  };
}

function isPrivateHostname(hostname: string) {
  const lowered = hostname.toLowerCase();

  if (
    lowered === "localhost" ||
    lowered === "0.0.0.0" ||
    lowered === "::1" ||
    lowered.endsWith(".local")
  ) {
    return true;
  }

  if (/^127\.\d+\.\d+\.\d+$/.test(lowered)) {
    return true;
  }

  if (/^10\.\d+\.\d+\.\d+$/.test(lowered)) {
    return true;
  }

  if (/^192\.168\.\d+\.\d+$/.test(lowered)) {
    return true;
  }

  const private172 = lowered.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (private172) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

function normalizeExternalUrl(input: string) {
  const url = new URL(input.trim());

  if (!/^https?:$/i.test(url.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  if (isPrivateHostname(url.hostname)) {
    throw new Error("Private or local network URLs are not allowed.");
  }

  return url.toString();
}

function extractDuckDuckGoTarget(href: string) {
  const decodedHref = decodeHtmlEntities(href);

  try {
    const absolute = new URL(decodedHref, "https://duckduckgo.com");
    const redirected = absolute.searchParams.get("uddg");
    if (redirected) {
      return decodeURIComponent(redirected);
    }
    return absolute.toString();
  } catch {
    return decodedHref;
  }
}

function stripInlineHtml(text: string) {
  return collapseWhitespace(decodeHtmlEntities(text.replace(/<[^>]+>/g, " ")));
}

export async function fetchWebsiteText(inputUrl: string): Promise<WebsiteTextResult> {
  const url = normalizeExternalUrl(inputUrl);
  const { signal, cleanup } = createTimeoutSignal(TOOL_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal,
      headers: {
        "User-Agent": "CapStoneBot/1.0 (+website-fetch-tool)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`Website fetch failed with status ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error("URL did not return an HTML page.");
    }

    const html = await response.text();
    const parsed = stripHtmlToText(html);

    if (!parsed.text) {
      throw new Error("No readable page text was extracted from the website.");
    }

    return {
      url,
      title: parsed.title,
      text: parsed.text,
      excerpt: parsed.excerpt,
    };
  } finally {
    cleanup();
  }
}

async function searchDuckDuckGoInstantAnswer(query: string): Promise<SearchResultItem[]> {
  const response = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`,
    {
      method: "GET",
      cache: "no-store",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  const results: SearchResultItem[] = [];

  if (typeof data?.AbstractURL === "string" && data.AbstractURL) {
    results.push({
      title: String(data.Heading || data.AbstractSource || data.AbstractURL),
      url: data.AbstractURL,
      snippet: String(data.AbstractText || data.Definition || ""),
    });
  }

  const relatedTopics = Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [];
  for (const topic of relatedTopics) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }

    const firstTopic = Array.isArray(topic?.Topics) ? topic.Topics[0] : topic;
    if (typeof firstTopic?.FirstURL !== "string" || typeof firstTopic?.Text !== "string") {
      continue;
    }

    results.push({
      title: firstTopic.Text.split(" - ")[0] || firstTopic.FirstURL,
      url: firstTopic.FirstURL,
      snippet: firstTopic.Text,
    });
  }

  return results;
}

function normalizeDuckDuckGoResultUrl(rawUrl: string) {
  const decoded = decodeHtmlEntities(rawUrl);

  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    if (redirected) {
      return decodeURIComponent(redirected);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function stripMarkdownFormatting(text: string) {
  return collapseWhitespace(
    text
      .replace(/!\[[^\]]*]\([^)]+\)/g, "")
      .replace(/\*\*/g, " ")
      .replace(/__/g, " ")
      .replace(/`/g, "")
  );
}

function parseDuckDuckGoReaderMarkdown(markdown: string) {
  const results: SearchResultItem[] = [];
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length && results.length < MAX_SEARCH_RESULTS; index += 1) {
    const line = lines[index].trim();
    const resultMatch = line.match(/^(?:#{2,3}\s*)?(?:\d+\.)?\[([^\]]+)]\(([^)]+)\)/);

    if (!resultMatch) {
      continue;
    }

    const title = stripMarkdownFormatting(resultMatch[1]);
    const url = normalizeDuckDuckGoResultUrl(resultMatch[2]);

    if (!title || !url.startsWith("http") || url.includes("duckduckgo.com/html")) {
      continue;
    }

    const snippetLines: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const snippetLine = lines[next].trim();

      if (!snippetLine) {
        continue;
      }

      if (/^(?:#{2,3}\s*)?(?:\d+\.)?\[[^\]]+]\([^)]+\)/.test(snippetLine)) {
        break;
      }

      if (/^\[!\[/.test(snippetLine) || /^https?:\/\//.test(snippetLine)) {
        continue;
      }

      snippetLines.push(stripMarkdownFormatting(snippetLine));
      if (snippetLines.join(" ").length > 260) {
        break;
      }
    }

    results.push({
      title,
      url,
      snippet: snippetLines.join(" ").slice(0, 320),
    });
  }

  return results;
}

async function searchDuckDuckGoReader(query: string): Promise<SearchResultItem[]> {
  const response = await fetch(
    `https://r.jina.ai/http://r.jina.ai/http://https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    {
      method: "GET",
      cache: "no-store",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "text/plain, text/markdown",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }
  );

  if (!response.ok) {
    return [];
  }

  const markdown = await response.text();
  return parseDuckDuckGoReaderMarkdown(markdown);
}

async function searchDuckDuckGoFallbacks(query: string) {
  const readerResults = await searchDuckDuckGoReader(query);
  if (readerResults.length > 0) {
    return readerResults;
  }

  return searchDuckDuckGoInstantAnswer(query);
}

export async function searchDuckDuckGo(query: string): Promise<WebSearchResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("Search query is required.");
  }

  const { signal, cleanup } = createTimeoutSignal(TOOL_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(normalizedQuery)}`,
      {
        method: "GET",
        cache: "no-store",
        signal,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed with status ${response.status}.`);
    }

    const html = await response.text();

    if (/anomaly-modal|challenge-form|anomalyDetectionBlock/i.test(html)) {
      const fallbackResults = await searchDuckDuckGoFallbacks(normalizedQuery);
      if (fallbackResults.length > 0) {
        return {
          query: normalizedQuery,
          results: fallbackResults,
        };
      }

      throw new Error("DuckDuckGo blocked this automated search with an anti-bot challenge.");
    }

    const results: SearchResultItem[] = [];
    const anchorRegex =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = anchorRegex.exec(html)) && results.length < MAX_SEARCH_RESULTS) {
      const rawUrl = extractDuckDuckGoTarget(match[1]);
      const title = stripInlineHtml(match[2]);
      const nearbyHtml = html.slice(match.index, match.index + 1500);
      const snippetMatch = nearbyHtml.match(
        /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      );
      const snippet = stripInlineHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? "");

      if (!title || !rawUrl.startsWith("http")) {
        continue;
      }

      results.push({
        title,
        url: rawUrl,
        snippet,
      });
    }

    if (!results.length) {
      const fallbackResults = await searchDuckDuckGoFallbacks(normalizedQuery);
      return {
        query: normalizedQuery,
        results: fallbackResults,
      };
    }

    return {
      query: normalizedQuery,
      results,
    };
  } finally {
    cleanup();
  }
}

function extractUrls(text: string) {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return Array.from(new Set(matches)).slice(0, 2);
}

function formatWebsiteContext(result: WebsiteTextResult) {
  const title = result.title ? `Title: ${result.title}\n` : "";
  return [
    "Website context:",
    `Source URL: ${result.url}`,
    title.trimEnd(),
    "",
    result.text,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSearchContext(result: WebSearchResult) {
  if (!result.results.length) {
    return `DuckDuckGo search context:\nQuery: ${result.query}\nNo results were parsed.`;
  }

  return [
    "DuckDuckGo search context:",
    `Query: ${result.query}`,
    "",
    ...result.results.map((item, index) =>
      [
        `${index + 1}. ${item.title}`,
        `URL: ${item.url}`,
        item.snippet ? `Snippet: ${item.snippet}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    ),
  ].join("\n");
}

function parseToolArguments(rawArguments: string) {
  try {
    const parsed: unknown = JSON.parse(rawArguments || "{}");
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function executeWebTool(name: string, rawArguments: string) {
  const args = parseToolArguments(rawArguments);

  if (name === "website_fetch") {
    const url = args.url;
    if (typeof url !== "string" || !url.trim()) {
      return JSON.stringify({ error: "website_fetch requires a non-empty url string." });
    }

    try {
      const result = await fetchWebsiteText(url);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : "Website fetch failed.",
      });
    }
  }

  if (name === "web_search") {
    const query = args.query;
    if (typeof query !== "string" || !query.trim()) {
      return JSON.stringify({ error: "web_search requires a non-empty query string." });
    }

    try {
      const result = await searchDuckDuckGo(query);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : "DuckDuckGo search failed.",
      });
    }
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

export async function maybeInvokeWebTool(userText: string): Promise<ToolInvocation | null> {
  const trimmed = userText.trim();
  if (!trimmed) {
    return null;
  }

  const fetchCommand = trimmed.match(/^\/fetch\s+(https?:\/\/\S+)(?:\s+([\s\S]*))?$/i);
  if (fetchCommand) {
    const website = await fetchWebsiteText(fetchCommand[1]);
    return {
      kind: "website",
      prompt: fetchCommand[2]?.trim() || "Summarize the fetched page for the user.",
      context: formatWebsiteContext(website),
      meta: website,
    };
  }

  const searchCommand = trimmed.match(/^\/search\s+([\s\S]+)$/i);
  if (searchCommand) {
    const search = await searchDuckDuckGo(searchCommand[1]);
    return {
      kind: "search",
      prompt: search.query,
      context: formatSearchContext(search),
      meta: search,
    };
  }

  const urls = extractUrls(trimmed);
  if (urls.length > 0) {
    const website = await fetchWebsiteText(urls[0]);
    return {
      kind: "website",
      prompt:
        trimmed === urls[0]
          ? "Summarize the fetched page for the user."
          : trimmed,
      context: formatWebsiteContext(website),
      meta: website,
    };
  }

  return null;
}
