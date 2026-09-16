#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { analyzeAudio, analyzeAudioBatch, type BatchTrackItem } from './x402.js';

dotenv.config({ quiet: true });

// Read package version dynamically from package.json with fallback
let packageVersion = "1.2.3";
try {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  if (pkg.version) packageVersion = pkg.version;
} catch {
  // fallback to 1.2.3
}

// 1. Resolve & Validate Private Key
// Priority: environment variable PRIVATE_KEY (recommended) -> CLI argument (fallback)
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

let privateKey = process.env.PRIVATE_KEY || process.env.TAG_PER_TRACK_PRIVATE_KEY;

if (!privateKey) {
  const cliArg = process.argv.find(arg => arg.startsWith('0x'));
  if (cliArg) {
    privateKey = cliArg;
  }
}

if (!privateKey) {
  console.error(
    "[Tag-per-Track MCP] Error: No private key provided.\n" +
    "Please provide your wallet private key using the PRIVATE_KEY environment variable (recommended) " +
    "or as a CLI argument (e.g. npx tag-per-track-mcp 0x...)."
  );
  process.exit(1);
}

if (!PRIVATE_KEY_REGEX.test(privateKey)) {
  console.error(
    "[Tag-per-Track MCP] Error: Invalid private key format.\n" +
    "The private key must be a 66-character hexadecimal string starting with '0x'."
  );
  process.exit(1);
}

const API_URL = process.env.API_URL || "https://api.tag-per-track.cloud/api/analyze";

// 2. Initialize MCP Server
const server = new Server(
  {
    name: "tag-per-track-mcp",
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "analyze_audio",
        description: "Analyzes a music track or audio file to extract musical metadata (BPM, genre, mood, key, instruments) and optionally vocal lyrics. Supports local audio files via 'filePath' (read in binary and uploaded) or remote URLs via 'fileUrl'. Note: This tool automatically executes a micro-payment (0.05 USDC for standard analysis, or 0.10 USDC when extractLyrics is enabled) via the x402 protocol on Base.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to a local audio file on disk (.mp3, .wav, .ogg, .flac, .m4a, .aac, .aiff). Use this whenever analyzing a local file, recording, or email attachment saved locally."
            },
            fileUrl: {
              type: "string",
              description: "The direct publicly accessible URL (HTTP/HTTPS or IPFS) of the audio file to analyze."
            },
            extractLyrics: {
              type: "boolean",
              description: "Optional: Set to true to transcribe and extract vocal lyrics in addition to metadata. Costs 0.10 USDC instead of 0.05 USDC."
            }
          }
        }
      },
      {
        name: "analyze_audio_with_lyrics",
        description: "Analyzes an audio track to extract complete musical metadata AND transcribe full vocal lyrics using AI. Supports local audio files via 'filePath' (read in binary and uploaded) or remote URLs via 'fileUrl'. Note: This tool automatically executes a micro-payment of 0.10 USDC via the x402 protocol on Base. (Alias for analyze_audio with extractLyrics: true).",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to a local audio file on disk (.mp3, .wav, .ogg, .flac, .m4a, .aac, .aiff). Use this whenever analyzing a local file, recording, or email attachment saved locally."
            },
            fileUrl: {
              type: "string",
              description: "The direct publicly accessible URL (HTTP/HTTPS or IPFS) of the audio file to analyze."
            }
          }
        }
      },
      {
        name: "analyze_audio_batch",
        description: "Analyzes multiple music tracks or audio files in parallel (batch processing). Vastly reduces total execution time compared to sequential processing. Accepts a list of local file paths ('filePaths') or remote URLs ('fileUrls'), or a structured array of 'tracks'. Executes micro-payments per track on Base via x402.",
        inputSchema: {
          type: "object",
          properties: {
            tracks: {
              type: "array",
              description: "Array of audio items to analyze in parallel. Each item can specify 'filePath' or 'fileUrl' and optional per-track 'extractLyrics'.",
              items: {
                type: "object",
                properties: {
                  filePath: {
                    type: "string",
                    description: "Path to a local audio file on disk."
                  },
                  fileUrl: {
                    type: "string",
                    description: "Direct public URL of the audio file."
                  },
                  extractLyrics: {
                    type: "boolean",
                    description: "Whether to extract vocal lyrics for this specific track (costs 0.10 USDC instead of 0.05 USDC)."
                  }
                }
              }
            },
            filePaths: {
              type: "array",
              items: { type: "string" },
              description: "Convenience shortcut: list of local audio file paths to analyze in parallel."
            },
            fileUrls: {
              type: "array",
              items: { type: "string" },
              description: "Convenience shortcut: list of remote audio URLs to analyze in parallel."
            },
            extractLyrics: {
              type: "boolean",
              description: "Optional global flag: set to true to transcribe and extract vocal lyrics for all tracks in this batch (0.10 USDC per track). Default is false (0.05 USDC per track)."
            },
            concurrency: {
              type: "number",
              description: "Maximum number of simultaneous parallel requests (1 to 5, default is 4 to respect API rate limits)."
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;

  if (toolName === "analyze_audio_batch") {
    const args = (request.params.arguments || {}) as {
      tracks?: Array<{ filePath?: string; fileUrl?: string; extractLyrics?: boolean }>;
      filePaths?: string[];
      fileUrls?: string[];
      extractLyrics?: boolean;
      concurrency?: number;
    };

    const tracksToProcess: BatchTrackItem[] = [];

    if (Array.isArray(args.tracks) && args.tracks.length > 0) {
      tracksToProcess.push(...args.tracks);
    }
    if (Array.isArray(args.filePaths)) {
      for (const fp of args.filePaths) {
        if (typeof fp === 'string' && fp.trim()) {
          tracksToProcess.push({ filePath: fp.trim() });
        }
      }
    }
    if (Array.isArray(args.fileUrls)) {
      for (const fu of args.fileUrls) {
        if (typeof fu === 'string' && fu.trim()) {
          tracksToProcess.push({ fileUrl: fu.trim() });
        }
      }
    }

    if (tracksToProcess.length === 0) {
      throw new Error("Missing tracks for batch: Please provide 'tracks', 'filePaths', or 'fileUrls' array.");
    }

    try {
      const batchResult = await analyzeAudioBatch(
        tracksToProcess,
        privateKey,
        API_URL,
        Boolean(args.extractLyrics),
        args.concurrency || 4
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(batchResult, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error executing batch analysis: ${error?.message || String(error)}`
          }
        ]
      };
    }
  }

  if (toolName !== "analyze_audio" && toolName !== "analyze_audio_with_lyrics") {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const { filePath, fileUrl, extractLyrics } = (request.params.arguments || {}) as {
    filePath?: string;
    fileUrl?: string;
    extractLyrics?: boolean;
  };

  if (!filePath && !fileUrl) {
    throw new Error("Missing audio source: Please provide either 'filePath' (for a local audio file on disk) or 'fileUrl' (for a public HTTP/HTTPS or IPFS URL).");
  }

  const shouldExtractLyrics = toolName === "analyze_audio_with_lyrics" || Boolean(extractLyrics);

  try {
    const data = await analyzeAudio({ filePath, fileUrl }, privateKey, API_URL, shouldExtractLyrics);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2)
        }
      ]
    };
  } catch (error: any) {
    const rawError = error?.message || String(error);
    let contextualHelp = "";

    if (rawError.includes("[Security Guard]")) {
      contextualHelp = " Transaction halted by client security policy.";
    } else if (rawError.includes("timed out") || rawError.includes("Failed to reach")) {
      contextualHelp = " Check network connectivity or remote API availability.";
    } else if (rawError.includes("Local file not found") || rawError.includes("Unsupported file format")) {
      contextualHelp = " Verify file path and ensure it has a supported audio extension (.mp3, .wav, .flac, etc.).";
    } else if (rawError.toLowerCase().includes("funds") || rawError.toLowerCase().includes("balance") || rawError.toLowerCase().includes("payment")) {
      contextualHelp = " Ensure your burner wallet has sufficient USDC on the Base network.";
    }

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error analyzing track: ${rawError}.${contextualHelp}`
        }
      ]
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[Tag-per-Track MCP] Server started on stdio (v${packageVersion})`);
}

main().catch(error => {
  console.error("[Tag-per-Track MCP] Fatal error:", error);
  process.exit(1);
});
