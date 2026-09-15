#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from 'dotenv';
import { analyzeAudio } from './x402.js';

dotenv.config({ quiet: true });

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
    version: "1.2.1",
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
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;

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
  console.error("[Tag-per-Track MCP] Server started on stdio (v1.2.1)");
}

main().catch(error => {
  console.error("[Tag-per-Track MCP] Fatal error:", error);
  process.exit(1);
});
