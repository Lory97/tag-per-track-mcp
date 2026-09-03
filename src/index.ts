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

// Parse private key from arguments
// E.g. `npx tag-per-track-mcp 0x...` or `tag-per-track-mcp 0x...`
const privateKey = process.argv.find(arg => arg.startsWith('0x'));

if (!privateKey) {
  console.error("Error: Please provide a private key as a command line argument (must start with '0x').");
  process.exit(1);
}

const API_URL = process.env.API_URL || "https://api.tag-per-track.cloud/api/analyze";

const server = new Server(
  {
    name: "tag-per-track-mcp",
    version: "1.0.0",
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
        description: "Analyzes a music track or audio file to extract musical metadata (BPM, genre, mood, key, instruments) and optionally vocal lyrics. Note: This tool automatically executes a micro-payment (0.05 USDC for standard analysis, or 0.10 USDC when extractLyrics is enabled) via the x402 protocol on Base.",
        inputSchema: {
          type: "object",
          properties: {
            fileUrl: {
              type: "string",
              description: "The direct URL of the audio file to analyze (supports mp3, wav, ogg, flac)."
            },
            extractLyrics: {
              type: "boolean",
              description: "Optional: Set to true to transcribe and extract song lyrics in addition to metadata. Costs 0.10 USDC instead of 0.05 USDC."
            }
          },
          required: ["fileUrl"]
        }
      },
      {
        name: "analyze_audio_with_lyrics",
        description: "Analyzes an audio track to extract complete musical metadata AND transcribe full vocal lyrics using AI. Note: This tool automatically executes a micro-payment of 0.10 USDC via the x402 protocol on Base.",
        inputSchema: {
          type: "object",
          properties: {
            fileUrl: {
              type: "string",
              description: "The direct URL of the audio file to analyze (supports mp3, wav, ogg, flac)."
            }
          },
          required: ["fileUrl"]
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

  const { fileUrl, extractLyrics } = (request.params.arguments || {}) as {
    fileUrl: string;
    extractLyrics?: boolean;
  };

  if (!fileUrl) {
    throw new Error("Missing required argument: fileUrl");
  }

  const shouldExtractLyrics = toolName === "analyze_audio_with_lyrics" || Boolean(extractLyrics);

  try {
    const data = await analyzeAudio(fileUrl, privateKey, API_URL, shouldExtractLyrics);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2)
        }
      ]
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error analyzing track: ${error.message}. Ensure your wallet has sufficient USDC on the correct network.`
        }
      ]
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Tag-per-Track MCP] Server started on stdio");
}

main().catch(error => {
  console.error("[Tag-per-Track MCP] Fatal error:", error);
  process.exit(1);
});
