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
import { analyzeAudio, analyzeAudioBatch, type BatchTrackItem, type AuthConfig } from './x402.js';
import { triageDemoFolder, TRIAGE_DEFAULT_MAX_TRACKS, TRIAGE_HARD_MAX_TRACKS, type TriageProfile } from './triage.js';
import { paymentModeFor, pricingNote, trackPrice } from './pricing.js';

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

// 1. Resolve Authentication Mode Lazily
// Priority 1: TAG_PER_TRACK_API_KEY (Studio SaaS credits, zero-crypto)
// Priority 2: WALLET_PRIVATE_KEY (x402 USDC micro-payments on Base)
export type AuthMode =
  | { type: 'API_KEY'; apiKey: string }
  | { type: 'PRIVATE_KEY'; privateKey: string }
  | { type: 'NONE' };

const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

export function resolveAuthMode(): AuthMode {
  // Priority 1: TAG_PER_TRACK_API_KEY
  const apiKey = process.env.TAG_PER_TRACK_API_KEY;
  if (apiKey && apiKey.trim()) {
    return { type: 'API_KEY', apiKey: apiKey.trim() };
  }

  // Priority 2: WALLET_PRIVATE_KEY (also backward-compatible with PRIVATE_KEY & TAG_PER_TRACK_PRIVATE_KEY)
  const privateKey =
    process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    process.env.TAG_PER_TRACK_PRIVATE_KEY;
  if (privateKey && privateKey.trim()) {
    return { type: 'PRIVATE_KEY', privateKey: privateKey.trim() };
  }

  return { type: 'NONE' };
}

const initialAuth = resolveAuthMode();
if (initialAuth.type === 'API_KEY') {
  console.error(
    "[Tag-per-Track MCP] Authenticated via Studio API Key (TAG_PER_TRACK_API_KEY). x402 on-chain wallet signing disabled."
  );
} else if (initialAuth.type === 'PRIVATE_KEY') {
  if (!PRIVATE_KEY_REGEX.test(initialAuth.privateKey)) {
    console.error(
      "[Tag-per-Track MCP] Warning: The provided private key does not match the 66-character hex format starting with '0x'."
    );
  } else {
    console.error(
      "[Tag-per-Track MCP] Authenticated via EVM Wallet (x402 USDC micro-payments on Base)."
    );
  }
} else {
  console.error(
    "[Tag-per-Track MCP] Notice: Server started without authentication. Tools discovery is active; monetized analysis tools will require TAG_PER_TRACK_API_KEY or WALLET_PRIVATE_KEY when invoked."
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
  // Prices are described in the unit the configured account pays with (credits or USDC)
  const mode = paymentModeFor(resolveAuthMode().type);
  return {
    tools: [
      {
        name: "analyze_audio",
        description: `Analyzes a music track or audio file to extract musical metadata (BPM, genre, mood, key, instruments), AI music detection verdict (HUMAN vs AI_GENERATED Suno/Udio neural vocoder risk with confidence index in 'ai_detection'), explainable A&R scoring v2 in 'arEvaluation' (discovery / signing / beatmaker profiles, AI gate, vocal vs instrumental), and optionally vocal lyrics. Supports local audio files via 'filePath' (read in binary and uploaded) or remote URLs via 'fileUrl'. ${pricingNote(mode)}`,
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
              description: `Optional: Set to true to transcribe and extract vocal lyrics in addition to metadata. Costs ${trackPrice(mode, true)} instead of ${trackPrice(mode, false)}.`
            }
          }
        }
      },
      {
        name: "analyze_audio_with_lyrics",
        description: `Analyzes an audio track to extract complete musical metadata, AI-generated music detection verdict (HUMAN vs AI_GENERATED Suno/Udio), AND transcribe full vocal lyrics using AI. Supports local audio files via 'filePath' (read in binary and uploaded) or remote URLs via 'fileUrl'. Costs ${trackPrice(mode, true)} per track. (Alias for analyze_audio with extractLyrics: true).`,
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
        name: "triage_demo_folder",
        description: `A&R demo inbox triage in ONE call: scans a local folder of demo submissions (.mp3, .wav, .flac, .m4a, .aiff...), analyzes every track, reads the artist/title from audio tags or 'Artist - Title' file names, fetches Spotify traction per artist, applies A&R scoring v2 and returns a COMPACT ranked report (score, priority, bucket, BPM/key/genre, AI-origin flag, monthly listeners, key reason codes, guarded lyrics excerpt). Buckets: 'priority' (listen first), 'listen', 'pass', 'ai_flagged' (confirmed or suspected AI-generated), 'error' (unreadable or rejected file), 'not_analyzed' (the triage stopped early because studio credits ran out or the API key was rejected: see 'halted'). Prefer this tool over analyze_audio_batch whenever the user wants to sort, rank or screen a folder of demos. ${pricingNote(mode)} Use dryRun to list files and the estimated cost (estimatedCost.label) without charging.`,
        inputSchema: {
          type: "object",
          properties: {
            folderPath: {
              type: "string",
              description: "Absolute path (or ~/...) of the local folder containing the demo audio files."
            },
            profile: {
              type: "string",
              enum: ["discovery", "signing", "beatmaker", "auto"],
              description: "Scoring profile used for the ranking: 'discovery' (A&R scout, default: an unknown artist is never penalized), 'signing' (label head, weighs streaming traction), 'beatmaker' (instrumentals), 'auto' (beatmaker for instrumentals, discovery otherwise)."
            },
            extractLyrics: {
              type: "boolean",
              description: `Also transcribe lyrics (${trackPrice(mode, true)} per track instead of ${trackPrice(mode, false)}). Default false.`
            },
            recursive: {
              type: "boolean",
              description: "Also scan sub-folders. Default false."
            },
            maxTracks: {
              type: "number",
              description: `Maximum number of files analyzed (default ${TRIAGE_DEFAULT_MAX_TRACKS}, hard limit ${TRIAGE_HARD_MAX_TRACKS}).`
            },
            lookupArtists: {
              type: "boolean",
              description: "Fetch Spotify traction for each artist (free). Default true."
            },
            dryRun: {
              type: "boolean",
              description: "List the files, detected artists/titles and the estimated cost without analyzing or charging anything."
            },
            concurrency: {
              type: "number",
              description: "Parallel analyses (1 to 5, default 3)."
            }
          },
          required: ["folderPath"]
        }
      },
      {
        name: "analyze_audio_batch",
        description: `Analyzes multiple music tracks or audio files in parallel (batch processing). Vastly reduces total execution time compared to sequential processing. Accepts a list of local file paths ('filePaths') or remote URLs ('fileUrls'), or a structured array of 'tracks'. ${pricingNote(mode)}`,
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
                    description: `Whether to extract vocal lyrics for this specific track (${trackPrice(mode, true)} instead of ${trackPrice(mode, false)}).`
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
              description: `Optional global flag: set to true to transcribe and extract vocal lyrics for all tracks in this batch (${trackPrice(mode, true)} per track). Default is false (${trackPrice(mode, false)} per track).`
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
            spotify_id: {
              type: "string",
              description: "Optional Spotify artist ID or open.spotify.com artist URL to target an exact artist when the name is ambiguous."
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

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;

  if (toolName === "triage_demo_folder") {
    const args = (request.params.arguments || {}) as {
      folderPath?: string;
      profile?: string;
      extractLyrics?: boolean;
      recursive?: boolean;
      maxTracks?: number;
      lookupArtists?: boolean;
      dryRun?: boolean;
      concurrency?: number;
    };

    const folderPath = typeof args.folderPath === 'string' ? args.folderPath.trim() : '';
    if (!folderPath) {
      throw new Error("Missing required parameter 'folderPath': the local folder containing the demo files.");
    }
    const profile: TriageProfile = ['discovery', 'signing', 'beatmaker', 'auto'].includes(args.profile || '')
      ? (args.profile as TriageProfile)
      : 'discovery';

    const auth = resolveAuthMode();
    if (auth.type === 'NONE' && !args.dryRun) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: No authentication configured for Tag-per-Track. Please define either TAG_PER_TRACK_API_KEY (from https://tag-per-track.cloud) or WALLET_PRIVATE_KEY in your MCP configuration."
          }
        ]
      };
    }

    // Progress notifications keep long triages alive on clients that reset their timeout on progress
    const progressToken = request.params._meta?.progressToken;
    const onProgress = progressToken === undefined
      ? undefined
      : (done: number, total: number, message: string) => {
          extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: done, total, message },
          }).catch(() => {});
        };

    try {
      const report = await triageDemoFolder(
        {
          folderPath,
          profile,
          paymentMode: paymentModeFor(auth.type),
          extractLyrics: Boolean(args.extractLyrics),
          recursive: Boolean(args.recursive),
          maxTracks: args.maxTracks,
          lookupArtists: args.lookupArtists,
          dryRun: Boolean(args.dryRun),
          concurrency: args.concurrency,
        },
        // A dry run never calls the paid routes: any auth placeholder is fine
        auth.type === 'NONE' ? { type: 'API_KEY', apiKey: '' } : auth,
        API_URL,
        API_BASE_URL,
        onProgress
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error triaging demo folder: ${error?.message || String(error)}`
          }
        ]
      };
    }
  }

  if (toolName === "lookup_artist_stats") {
    const args = (request.params.arguments || {}) as {
      artist_name?: string;
      spotify_id?: string;
      social_links?: string[];
    };

    const artistName = typeof args.artist_name === 'string' ? args.artist_name.trim() : '';
    if (!artistName) {
      throw new Error("Missing required parameter 'artist_name'. Please provide the stage name of the artist.");
    }

    try {
      const spotifyId = typeof args.spotify_id === 'string' ? args.spotify_id.trim() : '';
      const targetUrl = `${API_BASE_URL}/artist-stats?name=${encodeURIComponent(artistName)}` +
        (spotifyId ? `&spotifyId=${encodeURIComponent(spotifyId)}` : '');
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

    const auth = resolveAuthMode();
    if (auth.type === 'NONE') {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: No authentication configured for Tag-per-Track. Please define either TAG_PER_TRACK_API_KEY (from https://tag-per-track.cloud) or WALLET_PRIVATE_KEY in your MCP configuration."
          }
        ]
      };
    }

    try {
      const batchResult = await analyzeAudioBatch(
        tracksToProcess,
        auth,
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
      const rawError = error?.message || String(error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error executing batch analysis: ${rawError}`
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

  const auth = resolveAuthMode();
  if (auth.type === 'NONE') {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Error: No authentication configured for Tag-per-Track. Please define either TAG_PER_TRACK_API_KEY (from https://tag-per-track.cloud) or WALLET_PRIVATE_KEY in your MCP configuration."
        }
      ]
    };
  }

  try {
    const data = await analyzeAudio({ filePath, fileUrl }, auth, API_URL, shouldExtractLyrics);
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

    if (rawError.includes("Insufficient studio credits")) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error analyzing track: ${rawError}`
          }
        ]
      };
    }

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
  const mode = paymentModeFor(resolveAuthMode().type);
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
            description: `Set to 'true' to transcribe full vocal lyrics using AI Whisper and evaluate lyrical themes (${trackPrice(mode, true)} instead of ${trackPrice(mode, false)})`,
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
        name: "triage_demos",
        description: "Sorts a local folder of demo submissions like an A&R assistant: one triage_demo_folder call, then a ranked shortlist, AI-generated tracks flagged, and a proposal to file the demos into priority / to-listen / pass / AI sub-folders.",
        arguments: [
          {
            name: "folder_path",
            description: "Local folder containing the demo audio files (e.g. ~/Music/Demos - week 39)",
            required: true
          },
          {
            name: "label_focus",
            description: "Label identity or what you are looking for (e.g. 'afro / urban, club-ready singles'), used to comment the ranking",
            required: false
          },
          {
            name: "profile",
            description: "'discovery' (A&R scout, default), 'signing' (label head, weighs streaming traction), 'beatmaker' or 'auto'",
            required: false
          },
          {
            name: "extract_lyrics",
            description: `Set to 'true' to also transcribe lyrics (${trackPrice(mode, true)} per track instead of ${trackPrice(mode, false)})`,
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

  if (name === "triage_demos") {
    const folder = args?.folder_path || "<path/to/demo/folder>";
    const focus = args?.label_focus?.trim() || "";
    const profile = ['discovery', 'signing', 'beatmaker', 'auto'].includes(args?.profile || '') ? args!.profile! : 'discovery';
    const extractLyrics = args?.extract_lyrics === "true" || args?.extract_lyrics === "1";

    return {
      description: `Demo inbox triage for "${folder}"`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are the A&R assistant of a record label${focus ? ` looking for: ${focus}` : ''}.\n` +
              `Sort the demo submissions in the folder "${folder}". Answer in the language of the user.\n\n` +
              `Protocol:\n` +
              `1. Call \`triage_demo_folder\` ONCE with folderPath: "${folder}", profile: "${profile}", extractLyrics: ${extractLyrics}. ` +
              `Do not call analyze_audio track by track and do not display the raw JSON.\n` +
              `2. Open with one line: number of demos, how many to listen to first, how many AI-flagged, time taken.\n` +
              `3. Ranked table (all analyzed tracks, rank order): #, Artist – Title, Score /100, BPM · Key, Genre, Origin (from ai.flag, see rules), Spotify monthly listeners (or "unknown"), Why (one short plain-language phrase built from the reason codes).\n` +
              `4. "Listen first": the top 1 to 3 'priority' tracks, 2 sentences each${focus ? ', including their fit with the label focus' : ''}. Mention 'isGem' tracks as under-the-radar gems.\n` +
              `5. "AI-flagged": list the 'ai_flagged' tracks with verdict, confidence and generator. A 'suspected' flag is a suspicion to verify by ear, never a certainty.\n` +
              `6. Failed files (bucket 'error') with the reason, if any. If the report has 'halted' (studio credits exhausted or API key rejected), say it first and plainly: how many demos were analyzed, how many are still waiting, and that the user must recharge at https://tag-per-track.cloud; do not present the waiting demos as broken files.\n` +
              `7. Filing proposal: priority -> "1_Priorite", listen -> "2_A_ecouter", pass -> "3_Refus", ai_flagged -> "4_IA_suspecte", error -> "5_Erreurs" (sub-folders of "${folder}"). ` +
              `If you have file-system access, ask for confirmation, then create the sub-folders and move the files; never delete a file.\n\n` +
              `Rules:\n` +
              `- Costs: quote estimatedCost.label as is (studio credits when the account pays with a Studio API key). Never convert it or mention another currency.\n` +
              `- Origin column: derive it from ai.flag, never from the raw ai.verdict: "clear" -> Human, "uncertain" -> Inconclusive (confidence %, omitted when 0), "suspected" -> AI suspected (confidence %), "blocked" -> AI confirmed (confidence %, generator), "unchecked" -> Not checked. An AI_GENERATED verdict under 60 % is inconclusive: never write "AI" for it.\n` +
              `- Reason and recommendation fields are codes (e.g. "+listening.high_engagement", "production.clipping", "listen_first_gem"): translate them into plain language, never show them raw.\n` +
              `- Only quote lyrics whose lyrics.status is "ok". "approximate" means the singing was transcribed with low confidence (typically a language Whisper does not support, such as Creole): write "approximate transcription" and never quote it. "instrumental", "no_vocals_detected" and "suspect_repetition" mean there is no reliable transcription: say so without quoting.\n` +
              `- Unknown Spotify traction is not a weakness: the artist may simply be new.\n` +
              `- The score ranks demos to listen to; it never replaces listening.`
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
