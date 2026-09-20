#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
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

// 1. Resolve & Validate Private Key Lazily
// Priority: environment variable PRIVATE_KEY (recommended) -> CLI argument (fallback)
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

function getPrivateKey(): string {
  let key = process.env.PRIVATE_KEY || process.env.TAG_PER_TRACK_PRIVATE_KEY;

  if (!key) {
    const cliArg = process.argv.find(arg => arg.startsWith('0x'));
    if (cliArg) {
      key = cliArg;
    }
  }

  if (!key) {
    throw new Error(
      "[Tag-per-Track MCP] No private key provided. Please set the PRIVATE_KEY environment variable (or provide a 0x... CLI argument) to sign x402 USDC micro-payments on Base."
    );
  }

  if (!PRIVATE_KEY_REGEX.test(key)) {
    throw new Error(
      "[Tag-per-Track MCP] Invalid private key format. The private key must be a 66-character hexadecimal string starting with '0x'."
    );
  }

  return key;
}

const initialPrivateKey = process.env.PRIVATE_KEY || process.env.TAG_PER_TRACK_PRIVATE_KEY || process.argv.find(arg => arg.startsWith('0x'));
if (!initialPrivateKey) {
  console.error(
    "[Tag-per-Track MCP] Notice: Server started without a PRIVATE_KEY. Tools discovery is active; monetized tools will require PRIVATE_KEY when invoked."
  );
} else if (!PRIVATE_KEY_REGEX.test(initialPrivateKey)) {
  console.error(
    "[Tag-per-Track MCP] Warning: The provided PRIVATE_KEY does not match the 66-character hex format starting with '0x'."
  );
}

const API_URL = process.env.API_URL || "https://api.tag-per-track.cloud/api/analyze";
const API_BASE_URL = process.env.API_BASE_URL || API_URL.replace(/\/analyze\/?$/, '');

// 2. Initialize MCP Server
const server = new Server(
  {
    name: "tag-per-track-mcp",
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "analyze_audio",
        description: "Analyzes a music track or audio file to extract musical metadata (BPM, genre, mood, key, instruments), AI music detection verdict (HUMAN vs AI_GENERATED Suno/Udio neural vocoder risk with confidence index in 'ai_detection'), and optionally vocal lyrics. Supports local audio files via 'filePath' (read in binary and uploaded) or remote URLs via 'fileUrl'. Note: This tool automatically executes a micro-payment (0.15 USDC for standard analysis, or 0.25 USDC when extractLyrics is enabled) via the x402 protocol on Base.",
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
              description: "Optional: Set to true to transcribe and extract vocal lyrics in addition to metadata. Costs 0.25 USDC instead of 0.15 USDC."
            }
          }
        }
      },
      {
        name: "analyze_audio_with_lyrics",
        description: "Analyzes an audio track to extract complete musical metadata, AI-generated music detection verdict (HUMAN vs AI_GENERATED Suno/Udio), AND transcribe full vocal lyrics using AI. Supports local audio files via 'filePath' (read in binary and uploaded) or remote URLs via 'fileUrl'. Note: This tool automatically executes a micro-payment of 0.25 USDC via the x402 protocol on Base. (Alias for analyze_audio with extractLyrics: true).",
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
                    description: "Whether to extract vocal lyrics for this specific track (costs 0.25 USDC instead of 0.15 USDC)."
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
              description: "Optional global flag: set to true to transcribe and extract vocal lyrics for all tracks in this batch (0.25 USDC per track). Default is false (0.15 USDC per track)."
            },
            concurrency: {
              type: "number",
              description: "Maximum number of simultaneous parallel requests (1 to 5, default is 4 to respect API rate limits)."
            }
          }
        }
      },
      {
        name: "lookup_artist_stats",
        description: "Retrieves streaming traction and commercial metrics for an artist (Spotify monthly listeners, followers, popularity score) for A&R qualification.",
        inputSchema: {
          type: "object",
          properties: {
            artist_name: {
              type: "string",
              description: "Stage name of the artist to look up."
            },
            social_links: {
              type: "array",
              items: { type: "string" },
              description: "Optional social media profile links for future enrichment."
            }
          },
          required: ["artist_name"]
        }
      }

    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;

  if (toolName === "lookup_artist_stats") {
    const args = (request.params.arguments || {}) as {
      artist_name?: string;
      social_links?: string[];
    };

    const artistName = typeof args.artist_name === 'string' ? args.artist_name.trim() : '';
    if (!artistName) {
      throw new Error("Missing required parameter 'artist_name'. Please provide the stage name of the artist.");
    }

    try {
      const targetUrl = `${API_BASE_URL}/artist-stats?name=${encodeURIComponent(artistName)}`;
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(15000), // 15s timeout
      });

      if (response.status === 404) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "not_found",
                artist: artistName,
                message: `Artist "${artistName}" not found on Spotify.`,
                social_links: args.social_links || []
              }, null, 2)
            }
          ]
        };
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Backend API returned HTTP ${response.status} for artist "${artistName}": ${errorBody || response.statusText}`
            }
          ]
        };
      }

      const data = await response.json();
      const enrichedResult = {
        ...data,
        social_links: args.social_links || []
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(enrichedResult, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error looking up artist stats for "${artistName}": ${error?.message || String(error)}`
          }
        ]
      };
    }
  }

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
      const key = getPrivateKey();
      const batchResult = await analyzeAudioBatch(
        tracksToProcess,
        key,
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
    const key = getPrivateKey();
    const data = await analyzeAudio({ filePath, fileUrl }, key, API_URL, shouldExtractLyrics);
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

// 3. Register Prompts (Tailored to Tag-per-Track's Hybrid A&R & Acoustic Intelligence)
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "qualify_demo_ar",
        description: "Comprehensive A&R demo evaluation for record labels and music curators. Combines Essentia acoustic analysis (BPM, key, scale, moods, genres, instruments, lyrics) with real-time Spotify streaming traction (monthly listeners, popularity) to produce an A&R Executive Memo with an Emerging Gem verdict.",
        arguments: [
          {
            name: "audio_source",
            description: "Path to a local audio file on disk (.mp3, .wav, .flac, .m4a, .aiff) or remote public URL of the track",
            required: true
          },
          {
            name: "artist_name",
            description: "Artist or band stage name to cross-reference public streaming traction on Spotify (monthly listeners, followers, popularity score)",
            required: false
          },
          {
            name: "extract_lyrics",
            description: "Set to 'true' to transcribe full vocal lyrics using AI Whisper and evaluate lyrical themes (costs 0.25 USDC instead of 0.15 USDC)",
            required: false
          },
          {
            name: "curation_focus",
            description: "Curatorial objective: 'label_signing_decision', 'dsp_playlist_pitching', 'sync_licensing', or 'dj_radio_programming'",
            required: false
          }
        ]
      },
      {
        name: "batch_demo_screening",
        description: "Screens an EP, album, or folder of demo submissions in parallel using analyze_audio_batch. Evaluates energy flow, harmonic key progression, and selects standout lead singles.",
        arguments: [
          {
            name: "audio_sources",
            description: "Comma-separated list or JSON array of local audio file paths or remote URLs to analyze in parallel",
            required: true
          },
          {
            name: "screening_goal",
            description: "Screening objective: 'lead_single_selection', 'tracklist_harmonic_sequencing', or 'demo_drop_filtering'",
            required: false
          }
        ]
      }
    ]
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "qualify_demo_ar") {
    const source = args?.audio_source || "<path/to/audio>";
    const artist = args?.artist_name ? args.artist_name.trim() : "";
    const extractLyrics = args?.extract_lyrics === "true" || args?.extract_lyrics === "1";
    const focus = args?.curation_focus || "label_signing_decision";

    const artistInstruction = artist
      ? `2. Streaming Traction Enrichment: Call the \`lookup_artist_stats\` tool with artist_name: "${artist}" to fetch public Spotify metrics (monthly listeners, followers, popularity index 0-100, and primary genres).\n`
      : `2. Streaming Traction Enrichment: (No artist name specified; if you identify the artist from metadata or context, invoke \`lookup_artist_stats\` to cross-reference Spotify traction).\n`;

    const tractionSection = artist
      ? `2. Streaming Traction Matrix: Spotify monthly listeners, audience scale, popularity score, and current momentum.\n`
      : ``;

    return {
      description: `A&R qualification for "${source}"${artist ? ` by ${artist}` : ''} (${focus})`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Act as a Senior A&R Director and Music Intelligence Analyst.\n` +
              `Your objective is to qualify the track located at "${source}"${artist ? ` by "${artist}"` : ''} with a focus on "${focus}".\n\n` +
              `Execute the following qualification protocol using the Tag-per-Track MCP tools:\n` +
              `1. Acoustic Signal Analysis: Invoke \`analyze_audio\` on "${source}" (with extractLyrics: ${extractLyrics ? 'true' : 'false'}).\n` +
              `${artistInstruction}` +
              `3. Executive A&R Synthesis: Synthesize the acoustic data, AI detection verdict, and streaming traction into an "A&R Executive Memo" structured as follows:\n` +
              `   - 🎧 Acoustic Fingerprint: BPM, Key & Scale (harmonic mixing compatibility), Dominant Moods, Classified Genres & Sub-genres with confidence ratings, and Detected Instruments.\n` +
              `   - 🛡️ Origin Integrity: AI-generated music verdict (ai_detection: HUMAN authentic vs AI_GENERATED Suno/Udio risk, with confidence rating).\n` +
              (extractLyrics ? `   - 📝 Lyrical Analysis: Key themes, hook memorability, and vocal presence.\n` : ``) +
              `${tractionSection}` +
              `   - 💎 Hybrid A&R Score & Tier: Classify the profile (Emerging Gem: <50k listeners with strong acoustic score, Rising Talent, or Established Artist) with a 0-100 viability score.\n` +
              `   - 📋 Strategic Action Plan: Target DSP Editorial Playlists (Spotify / Apple Music), radio/club format viability, sync licensing potential, and final A&R recommendation (Sign, Creative Development, or Pass).`
          }
        }
      ]
    };
  }

  if (name === "batch_demo_screening") {
    const sources = args?.audio_sources || "<path1.mp3, path2.mp3>";
    const goal = args?.screening_goal || "lead_single_selection";

    return {
      description: `Batch demo screening for ${goal}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Act as a Senior Music Curator and Label Project Manager.\n` +
              `Your objective is to screen and qualify the following batch of tracks: ${sources}.\n` +
              `Screening goal: "${goal}".\n\n` +
              `Execute the screening using the Tag-per-Track MCP tools:\n` +
              `1. Run \`analyze_audio_batch\` on the tracklist in parallel.\n` +
              `2. Build a comparative evaluation matrix:\n` +
              `   - Track Title / Source, BPM, Key, Dominant Mood, Primary Genre.\n` +
              `3. Harmonic & Energy Sequencing: Evaluate BPM pacing and Camelot harmonic compatibility across the tracklist.\n` +
              `4. Commercial Standouts: Flag the top 1-2 standout candidates for lead single / focus track and playlist pitching.\n` +
              `5. Curator Verdict: Provide a prioritized release order and action plan.`
          }
        }
      ]
    };
  }

  throw new Error(`Prompt not found: ${name}`);
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
