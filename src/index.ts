#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from 'dotenv';
import { analyzeAudio } from './x402.js';

dotenv.config();

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
        description: "Analyzes a music track or audio file to extract advanced metadata like BPM, genre, mood, and key. Provide the URL of the audio file (.mp3, .wav, .ogg). Note: This tool automatically executes a micro-payment (0.05 USDC) via the x402 protocol.",
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
  if (request.params.name !== "analyze_audio") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { fileUrl } = request.params.arguments as { fileUrl: string };

  try {
    const data = await analyzeAudio(fileUrl, privateKey, API_URL);
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
