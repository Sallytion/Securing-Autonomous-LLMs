// eslint-disable-next-line @typescript-eslint/no-require-imports
const ddgs = require("duckduckgo-search");

// duckduckgo-search@1.0.7 uses logger.warning internally, which console doesn't provide.
ddgs.logger = ddgs.logger || console;
if (typeof ddgs.logger.warning !== "function") {
  ddgs.logger.warning = console.warn.bind(console);
}

(async () => {
  // Image search
  console.log("Image search results:");
  try {
    for await (const result of ddgs.images("beautiful landscapes")) {
      console.log(result);
    }
  } catch (error) {
    console.error("Image search failed:", error.message);
  }

  // Text search
  console.log("Text search results:");
  try {
    for await (const result of ddgs.text("web development tips")) {
      console.log(result);
    }
  } catch (error) {
    console.error("Text search failed:", error.message);
  }
})();
