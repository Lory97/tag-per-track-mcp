# Tag-per-Track MCP Server

This project is a local **Model Context Protocol (MCP)** server that allows AI agents (like Claude) to analyze audio files via the **Tag-per-Track** API. The server automatically handles the micro-USDC payment process using the **x402** protocol on the **Base** network.

## 🎯 Vision
Enable an AI to "pay to listen" autonomously. When an AI agent wants to analyze a track, it uses this MCP server, which signs an EIP-3009 (USDC) payment authorization and instantly retrieves the enriched track metadata.

## 🚀 Features
- **`analyze_audio` Tool**: Extracts BPM, Genre, Mood, Key, Instruments, etc.
- **Automated x402 Payment**: Manages the x402 challenge-response cycle (HTTP 402).
- **Integrated Web3**: On-chain signing via `viem`.
- **Compatibility**: Designed for use with Claude Desktop or any other MCP client.


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

## 🔧 MCP Tool: `analyze_audio`

The tool exposes the following function:

- **Name**: `analyze_audio`
- **Description**: Analyzes an audio file to extract advanced metadata.
- **Arguments**:
  - `fileUrl` (string): Direct URL of the audio file (.mp3, .wav, .ogg, .flac).

## 📄 License
MIT
