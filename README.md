# Tag-per-Track MCP Server

This project is a local **Model Context Protocol (MCP)** server that allows AI agents (like Claude) to analyze audio files via the **Tag-per-Track** API. The server automatically handles the micro-USDC payment process using the **x402** protocol on the **Base** network.

## 🎯 Vision
Enable an AI to "pay to listen" autonomously. When an AI agent wants to analyze a track, it uses this MCP server, which signs an EIP-3009 (USDC) payment authorization and instantly retrieves the enriched track metadata.

## 🚀 Features
- **`analyze_audio` Tool**: Extracts BPM, Genre, Mood, Key, Instruments, and optional Lyrics (0.05 USDC standard / 0.10 USDC with lyrics).
- **`analyze_audio_with_lyrics` Tool**: Extracts complete musical metadata AND transcribes full vocal lyrics (0.10 USDC).
- **Automated x402 Payment**: Manages the x402 challenge-response cycle (HTTP 402).
- **Integrated Web3**: On-chain signing via `viem` (EIP-3009 TransferWithAuthorization on Base).
- **Compatibility**: Designed for use with Claude Desktop, Cursor, Windsurf, or any MCP client.


## ⚙️ Configuration

### CLI Arguments
The server requires your **private key** to sign x402 payment proofs. It must be passed as an argument when launching.


## 🤖 Usage with Claude Desktop

Add the following configuration to your `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
    "tag-per-track": {
      "command": "npx",
      "args": [
        "-y",
        "tag-per-track-mcp",
        "0xYOUR_PRIVATE_KEY_HERE"
      ]
    }
  }
}
```

> [!IMPORTANT]
> Ensure your wallet has sufficient **USDC** on the **Base** network.
> ⚠️ SECURITY ADVICE: Never use your main vault wallet. Please use a dedicated "burner" wallet or a developer wallet funded with a few USDC. The private key remains strictly on your local machine and is never transmitted to our servers.

## 🔧 MCP Tools

### 1. `analyze_audio`
Analyzes an audio file to extract musical metadata tags (BPM, key, scale, moods, genres, instruments) and optional lyrics.

- **Arguments**:
  - `fileUrl` (*string*, required): Direct URL of the audio file (.mp3, .wav, .ogg, .flac).
  - `extractLyrics` (*boolean*, optional): Set to `true` to also extract vocal lyrics (costs 0.10 USDC instead of 0.05 USDC).

### 2. `analyze_audio_with_lyrics`
Analyzes an audio file to extract musical metadata AND transcribe full vocal lyrics using AI.

- **Arguments**:
  - `fileUrl` (*string*, required): Direct URL of the audio file (.mp3, .wav, .ogg, .flac).

## 📄 License
MIT
