import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_READ_CHARS = 12000;
const tempRoot = path.resolve(process.cwd(), "temp");

export type FileToolPolicy = {
  sandboxEnabled: boolean;
};

export const fileToolDefinitions = [
  {
    type: "function",
    function: {
      name: "file_read",
      description:
        "Read a UTF-8 text file from the local filesystem. When sandboxing is enabled, this can only read files inside the app's temp folder.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path to read. Relative paths are resolved from temp when sandboxed, or from the app working directory when unsandboxed.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description:
        "Write UTF-8 text to a local filesystem file. When sandboxing is enabled, this can only write files inside the app's temp folder.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path to write. Relative paths are resolved from temp when sandboxed, or from the app working directory when unsandboxed.",
          },
          content: {
            type: "string",
            description: "UTF-8 text content to write.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_list",
      description:
        "List files and folders in a local filesystem directory. When sandboxing is enabled, this can only list directories inside the app's temp folder.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path to list. Defaults to temp when sandboxed, or the app working directory when unsandboxed.",
          },
        },
      },
    },
  },
] as const;

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

function hasNullByte(value: string) {
  return value.includes("\0");
}

function isInsidePath(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveToolPath(inputPath: string | undefined, policy: FileToolPolicy) {
  const input = inputPath?.trim() || ".";
  const rawPath = policy.sandboxEnabled && /^(?:\.?[\\/])?temp[\\/]?$/i.test(input)
    ? "."
    : input;

  if (hasNullByte(rawPath)) {
    throw new Error("Path cannot contain null bytes.");
  }

  const basePath = policy.sandboxEnabled ? tempRoot : process.cwd();
  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(basePath, rawPath);

  if (policy.sandboxEnabled && !isInsidePath(tempRoot, resolvedPath)) {
    throw new Error(`Sandbox denied access outside temp: ${rawPath}`);
  }

  return resolvedPath;
}

function displayPath(filePath: string) {
  const relativeToWorkspace = path.relative(process.cwd(), filePath);
  return relativeToWorkspace && !relativeToWorkspace.startsWith("..")
    ? relativeToWorkspace
    : filePath;
}

export async function executeFileTool(
  name: string,
  rawArguments: string,
  policy: FileToolPolicy
) {
  const args = parseToolArguments(rawArguments);

  try {
    if (name === "file_read") {
      const filePathArg = args.path;
      if (typeof filePathArg !== "string" || !filePathArg.trim()) {
        return JSON.stringify({ error: "file_read requires a non-empty path string." });
      }

      const filePath = resolveToolPath(filePathArg, policy);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return JSON.stringify({ error: "Path is not a file.", path: displayPath(filePath) });
      }

      const content = await readFile(filePath, "utf8");
      return JSON.stringify({
        path: displayPath(filePath),
        sandboxEnabled: policy.sandboxEnabled,
        content: content.slice(0, MAX_FILE_READ_CHARS),
        truncated: content.length > MAX_FILE_READ_CHARS,
      });
    }

    if (name === "file_write") {
      const filePathArg = args.path;
      const contentArg = args.content;
      if (typeof filePathArg !== "string" || !filePathArg.trim()) {
        return JSON.stringify({ error: "file_write requires a non-empty path string." });
      }
      if (typeof contentArg !== "string") {
        return JSON.stringify({ error: "file_write requires content as a string." });
      }

      const filePath = resolveToolPath(filePathArg, policy);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contentArg, "utf8");

      return JSON.stringify({
        path: displayPath(filePath),
        sandboxEnabled: policy.sandboxEnabled,
        bytesWritten: Buffer.byteLength(contentArg, "utf8"),
      });
    }

    if (name === "file_list") {
      const dirPathArg = typeof args.path === "string" ? args.path : undefined;
      const dirPath = resolveToolPath(dirPathArg, policy);
      const entries = await readdir(dirPath, { withFileTypes: true });

      return JSON.stringify({
        path: displayPath(dirPath),
        sandboxEnabled: policy.sandboxEnabled,
        entries: entries.slice(0, 100).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        })),
        truncated: entries.length > 100,
      });
    }

    return JSON.stringify({ error: `Unknown file tool: ${name}` });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : "Filesystem tool failed.",
      sandboxEnabled: policy.sandboxEnabled,
    });
  }
}
