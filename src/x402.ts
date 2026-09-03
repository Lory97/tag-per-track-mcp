import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";

export interface AudioInput {
    fileUrl?: string;
    filePath?: string;
}

const MAX_LOCAL_FILE_SIZE = 50 * 1024 * 1024; // 50 MB limit

/**
 * Resolves a local path, expanding '~', file:// URLs, and relative paths.
 */
export function resolveLocalPath(filePath: string): string {
    if (filePath.startsWith('file://')) {
        try {
            return fileURLToPath(filePath);
        } catch {
            return filePath.replace(/^file:\/\//, '');
        }
    }
    if (filePath.startsWith('~')) {
        return path.resolve(os.homedir(), filePath.slice(1).replace(/^[/\\]/, ''));
    }
    return path.resolve(process.cwd(), filePath);
}

/**
 * Maps common audio file extensions to their standard MIME type.
 */
export function getAudioMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case '.mp3':
            return 'audio/mpeg';
        case '.wav':
            return 'audio/wav';
        case '.ogg':
            return 'audio/ogg';
        case '.flac':
            return 'audio/flac';
        case '.m4a':
            return 'audio/mp4';
        case '.aac':
            return 'audio/aac';
        case '.aiff':
        case '.aif':
            return 'audio/aiff';
        default:
            return 'application/octet-stream';
    }
}

/**
 * Executes a micro-payment via the x402 protocol and analyzes an audio file.
 * Supports both remote URLs (fileUrl) and local binary files (filePath).
 * 
 * @param input Either a fileUrl/filePath string or an object with fileUrl or filePath.
 * @param privateKey Hex string representing the private key.
 * @param apiUrl The Tag-per-Track API base URL.
 * @param extractLyrics Whether to extract vocal lyrics in addition to metadata.
 * @returns The analysis result JSON.
 */
export async function analyzeAudio(
    input: string | AudioInput,
    privateKey: string,
    apiUrl: string,
    extractLyrics: boolean = false
): Promise<any> {
    const account = privateKeyToAccount(privateKey as Hex);

    // Resolve input parameters
    let fileUrl: string | undefined;
    let filePath: string | undefined;

    if (typeof input === 'string') {
        if (input.startsWith('file://') || fs.existsSync(input)) {
            filePath = input;
        } else {
            fileUrl = input;
        }
    } else {
        filePath = input.filePath;
        fileUrl = input.fileUrl;
    }

    // Auto-detect if fileUrl is actually a local file or file:// URL
    if (!filePath && fileUrl && (fileUrl.startsWith('file://') || fs.existsSync(fileUrl))) {
        filePath = fileUrl;
        fileUrl = undefined;
    }

    if (!filePath && !fileUrl) {
        throw new Error("Missing audio source: either 'filePath' (local file) or 'fileUrl' (remote URL) must be provided.");
    }

    let localFileData: { buffer: Buffer; filename: string; mimeType: string } | undefined;

    if (filePath) {
        const resolvedPath = resolveLocalPath(filePath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`Local file not found: ${filePath} (resolved path: ${resolvedPath})`);
        }
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
            throw new Error(`The provided path is not a file: ${filePath}`);
        }
        if (stat.size > MAX_LOCAL_FILE_SIZE) {
            throw new Error(`File is too large (${(stat.size / 1024 / 1024).toFixed(2)} MB). Maximum allowed size is 50MB.`);
        }
        const buffer = await fs.promises.readFile(resolvedPath);
        const filename = path.basename(resolvedPath);
        const mimeType = getAudioMimeType(filename);
        localFileData = { buffer, filename, mimeType };
    }

    const targetUrl = extractLyrics
        ? (apiUrl.endsWith('/analyze') ? `${apiUrl}-with-lyrics` : `${apiUrl.replace(/\/analyze$/, '')}/analyze-with-lyrics`)
        : apiUrl;

    const sourceDescription = localFileData
        ? `local file: ${localFileData.filename} (${(localFileData.buffer.length / 1024 / 1024).toFixed(2)} MB)`
        : `remote URL: ${fileUrl}`;

    console.error(`[Tag-per-Track MCP] Starting analysis for ${sourceDescription} (extractLyrics: ${extractLyrics})`);
    console.error(`[Tag-per-Track MCP] Target endpoint: ${targetUrl}`);

    // 1. Initial Request (Triggers 402 Payment Required)
    const triggerBody = fileUrl ? { fileUrl } : { fileName: localFileData?.filename };
    const initialResponse = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(triggerBody)
    });

    if (initialResponse.status === 400) {
        const error = await initialResponse.json();
        throw new Error(`Request failed: ${error.message}`);
    }

    if (initialResponse.status !== 402) {
        throw new Error(`Expected HTTP 402, but received ${initialResponse.status}`);
    }

    // 2. Extract x402 Payment Requirements
    const paymentRequiredHeader = initialResponse.headers.get("PAYMENT-REQUIRED");
    let requirements;
    
    if (paymentRequiredHeader) {
        // Node.js / Browser compatible base64 decoding
        const decoded = typeof atob !== 'undefined' 
            ? atob(paymentRequiredHeader) 
            : Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8');
        requirements = JSON.parse(decoded);
    } else {
        // Fallback to body for backwards compatibility
        const errorData = await initialResponse.json();
        requirements = errorData.paymentRequirements;
    }

    if (!requirements) {
        throw new Error("Missing 'paymentRequirements' in the 402 response.");
    }

    // Handle x402 v2 structure where payment terms are in 'accepts' array
    const accept = requirements.accepts ? requirements.accepts[0] : requirements;

    if (!accept) {
        throw new Error("Missing 'accepts' payment conditions in the 402 response.");
    }

    console.error(`[Tag-per-Track MCP] 402 Received. Preparing EIP-3009 signature for payment...`);

    // 3. Construct EIP-3009 Message (TransferWithAuthorization)
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = `0x${Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
    const validBefore = Math.floor(Date.now() / 1000) + 3600; // expires in 1 hour

    // Determine chain ID from network requirement
    const chainId = accept.network.includes(':')
        ? parseInt(accept.network.split(':')[1], 10)
        : (accept.network === 'base-sepolia' ? 84532 : 8453);

    const domain = {
        name: accept.extra?.name || (accept.network.includes('sepolia') || accept.network.includes('84532') ? 'USDC' : 'USD Coin'),
        version: accept.extra?.version || '2',
        chainId: chainId,
        verifyingContract: accept.asset as Hex,
    } as const;

    const types = {
        TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
        ],
    } as const;

    const message = {
        from: account.address,
        to: accept.payTo as Hex,
        value: BigInt(accept.amount || accept.maxAmountRequired),
        validAfter: BigInt(0),
        validBefore: BigInt(validBefore),
        nonce: nonce as Hex,
    };

    // 4. Sign the Authorization Message
    const signature = await account.signTypedData({
        domain,
        types,
        primaryType: 'TransferWithAuthorization',
        message,
    });

    // 5. Construct Payment Proof (x402 V2 structure aligned with standard)
    const paymentProof = JSON.stringify({
        x402Version: 2,
        accepted: accept,
        payload: {
            signature,
            authorization: {
                from: message.from,
                to: message.to,
                value: message.value.toString(),
                validAfter: message.validAfter.toString(),
                validBefore: message.validBefore.toString(),
                nonce: message.nonce,
            },
        },
        resource: requirements.resource || {
            url: targetUrl,
            description: extractLyrics
                ? 'Tag-per-Track: Agentic-First Musical Audio Analysis API. Extracts BPM, Key, Mood, Genres, Instruments AND Lyrics from audio.'
                : 'Tag-per-Track: Agentic-First Musical Audio Analysis API. Extracts BPM, Key, Mood, Genres and Instruments from audio.',
            mimeType: 'application/json',
        },
        extensions: requirements.extensions
    });

    console.error(`[Tag-per-Track MCP] Proof generated and signed. Re-submitting request to ${targetUrl}...`);

    // 6. Secondary Call with PAYMENT-SIGNATURE header
    const headers: Record<string, string> = {
        'PAYMENT-SIGNATURE': paymentProof,
        'X-Payment-Proof': paymentProof // Kept for backwards compatibility
    };

    let body: BodyInit;
    if (localFileData) {
        const formData = new FormData();
        const blob = new Blob([new Uint8Array(localFileData.buffer)], { type: localFileData.mimeType });
        formData.append('file', blob, localFileData.filename);
        body = formData;
    } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ fileUrl });
    }

    const finalResponse = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body
    });

    if (!finalResponse.ok) {
        const error = await finalResponse.json();
        console.error("[Tag-per-Track MCP] Detailed backend error:", JSON.stringify(error, null, 2));
        throw new Error(error.message || `Analysis failed after payment (HTTP ${finalResponse.status}).`);
    }

    const result = await finalResponse.json();
    console.error(`[Tag-per-Track MCP] Analysis completed successfully.`);

    return result.data;
}
