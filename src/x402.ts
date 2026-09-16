import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";

const execFileAsync = promisify(execFile);

export interface AudioInput {
    fileUrl?: string;
    filePath?: string;
}

export interface BatchTrackItem {
    filePath?: string;
    fileUrl?: string;
    extractLyrics?: boolean;
}

export interface BatchTrackResult {
    track: string;
    filePath?: string;
    fileUrl?: string;
    extractLyrics: boolean;
    status: 'success' | 'error';
    data?: AudioAnalysisResult;
    error?: string;
}

export interface BatchAnalysisResponse {
    totalTracks: number;
    successful: number;
    failed: number;
    concurrency: number;
    results: BatchTrackResult[];
}

export interface CompressionResult {
    resolvedPath: string;
    filename: string;
    mimeType: string;
    size: number;
    cleanup: () => Promise<void>;
}

export interface X402PaymentAccept {
    network: string;
    asset: string;
    payTo: string;
    amount?: string;
    maxAmountRequired?: string;
    extra?: {
        name?: string;
        version?: string;
        [key: string]: any;
    };
    [key: string]: any;
}

export interface X402Requirements {
    x402Version?: number;
    accepts?: X402PaymentAccept[];
    network?: string;
    asset?: string;
    payTo?: string;
    amount?: string;
    maxAmountRequired?: string;
    resource?: any;
    extensions?: any;
    extra?: any;
}

export interface AudioAnalysisResult {
    bpm?: number;
    key?: string;
    scale?: string;
    genres?: Array<{ label: string; score: number }> | string[];
    moods?: Array<{ label: string; score: number }> | string[];
    instruments?: Array<{ label: string; score: number }> | string[];
    lyrics?: string;
    [key: string]: any;
}

const MAX_LOCAL_FILE_SIZE = 50 * 1024 * 1024; // 50 MB limit

// Default max spending limit: 0.20 USDC (USDC uses 6 decimals on Base: 200,000 units = 0.20 USDC)
const DEFAULT_MAX_SPENDING_USDC = 200_000n;

// EIP-3009 authorization valid for 5 minutes (300 seconds) instead of 1 hour
const EIP3009_VALIDITY_SECONDS = 300;

export const SUPPORTED_AUDIO_MIME_TYPES: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
};

// Files above 15 MB or uncompressed PCM formats will be automatically compressed to 128k AAC (m4a)
export const COMPRESSION_SIZE_THRESHOLD = 15 * 1024 * 1024; // 15 MB
export const UNCOMPRESSED_AUDIO_EXTENSIONS = new Set(['.wav', '.aiff', '.aif']);

/**
 * Checks whether an audio file should be compressed prior to upload.
 * Only uncompressed formats or files larger than 15 MB are compressed.
 * Lightweight compressed files (.mp3, .m4a <= 15MB) are untouched.
 */
export function shouldCompressAudio(filename: string, size: number): boolean {
    const ext = path.extname(filename).toLowerCase();
    if (UNCOMPRESSED_AUDIO_EXTENSIONS.has(ext)) {
        return true;
    }
    return size > COMPRESSION_SIZE_THRESHOLD;
}

/**
 * Compresses an audio file to AAC/M4A if it is heavy or uncompressed.
 * Uses native macOS /usr/bin/afconvert when available, or ffmpeg as fallback.
 * Gracefully falls back to original file if compression tools are unavailable.
 */
export async function compressAudioIfHeavy(
    originalPath: string,
    originalFilename: string,
    originalMime: string,
    originalSize: number
): Promise<CompressionResult> {
    const noopCleanup = async () => {};

    if (!shouldCompressAudio(originalFilename, originalSize)) {
        return {
            resolvedPath: originalPath,
            filename: originalFilename,
            mimeType: originalMime,
            size: originalSize,
            cleanup: noopCleanup
        };
    }

    const baseNameWithoutExt = path.basename(originalFilename, path.extname(originalFilename));
    const tempCompressedFilename = `tpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`;
    const tempOutputPath = path.join(os.tmpdir(), tempCompressedFilename);

    const cleanup = async () => {
        try {
            await fs.promises.unlink(tempOutputPath);
        } catch {
            // Ignore if file doesn't exist
        }
    };

    console.error(`[Tag-per-Track MCP] Compressing heavy/uncompressed file (${(originalSize / 1024 / 1024).toFixed(2)} MB): "${originalFilename}" -> AAC/M4A...`);

    try {
        if (process.platform === 'darwin' && fs.existsSync('/usr/bin/afconvert')) {
            await execFileAsync('/usr/bin/afconvert', [
                '-f', 'm4af',
                '-d', 'aac',
                '-b', '128000',
                originalPath,
                tempOutputPath
            ]);
        } else {
            await execFileAsync('ffmpeg', [
                '-y',
                '-i', originalPath,
                '-c:a', 'aac',
                '-b:a', '128k',
                tempOutputPath
            ]);
        }

        const stat = await fs.promises.stat(tempOutputPath);
        if (stat.size > 0 && stat.size < originalSize) {
            console.error(
                `[Tag-per-Track MCP] Compression successful: ${(originalSize / 1024 / 1024).toFixed(2)} MB -> ${(stat.size / 1024 / 1024).toFixed(2)} MB ` +
                `(-${Math.round((1 - stat.size / originalSize) * 100)}%).`
            );
            return {
                resolvedPath: tempOutputPath,
                filename: `${baseNameWithoutExt}.m4a`,
                mimeType: 'audio/mp4',
                size: stat.size,
                cleanup
            };
        } else {
            console.error(`[Tag-per-Track MCP] Compressed file not significantly smaller (${stat.size} vs ${originalSize} bytes). Keeping original.`);
            await cleanup();
            return {
                resolvedPath: originalPath,
                filename: originalFilename,
                mimeType: originalMime,
                size: originalSize,
                cleanup: noopCleanup
            };
        }
    } catch (compressionErr: any) {
        console.error(`[Tag-per-Track MCP] Audio compression skipped / failed (${compressionErr.message}). Falling back to original file.`);
        await cleanup();
        return {
            resolvedPath: originalPath,
            filename: originalFilename,
            mimeType: originalMime,
            size: originalSize,
            cleanup: noopCleanup
        };
    }
}

/**
 * Reads the configured maximum spending limit or defaults to 0.20 USDC.
 */
export function getMaxSpendingCap(): bigint {
    if (process.env.MAX_SPENDING_USDC) {
        const parsed = parseFloat(process.env.MAX_SPENDING_USDC);
        if (!isNaN(parsed) && parsed > 0) {
            return BigInt(Math.round(parsed * 1_000_000));
        }
    }
    return DEFAULT_MAX_SPENDING_USDC;
}

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
 * Detects if a string is intended as a local file path rather than a remote URL.
 */
export function isLikelyLocalPath(str: string): boolean {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    return (
        trimmed.startsWith('file://') ||
        trimmed.startsWith('~') ||
        trimmed.startsWith('/') ||
        trimmed.startsWith('./') ||
        trimmed.startsWith('../') ||
        /^[a-zA-Z]:[\\/]/.test(trimmed)
    );
}

/**
 * Validates audio file extension against strict whitelist and returns its MIME type.
 * Rejects non-audio files immediately to prevent arbitrary file exfiltration.
 */
export function getAudioMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeType = SUPPORTED_AUDIO_MIME_TYPES[ext];
    if (!mimeType) {
        throw new Error(
            `Unsupported file format "${ext || 'none'}". ` +
            `Only audio files (${Object.keys(SUPPORTED_AUDIO_MIME_TYPES).join(', ')}) are accepted.`
        );
    }
    return mimeType;
}

/**
 * Safely constructs the target endpoint URL without string manipulation hazards.
 */
export function buildTargetUrl(apiUrl: string, extractLyrics: boolean): string {
    const url = new URL(apiUrl);
    if (extractLyrics) {
        const cleanPath = url.pathname.replace(/\/+$/, '');
        if (cleanPath.endsWith('/analyze')) {
            url.pathname = cleanPath + '-with-lyrics';
        } else if (!cleanPath.endsWith('/analyze-with-lyrics')) {
            url.pathname = cleanPath.replace(/\/analyze$/, '') + '/analyze-with-lyrics';
        }
    }
    return url.toString();
}

/**
 * Executes a micro-payment via the x402 protocol and analyzes an audio file.
 * Supports both remote URLs (fileUrl) and local binary files (filePath).
 * 
 * @param input Either a fileUrl/filePath string or an object with fileUrl or filePath.
 * @param privateKey Hex string representing the private key (validated 64-hex char).
 * @param apiUrl The Tag-per-Track API base URL.
 * @param extractLyrics Whether to extract vocal lyrics in addition to metadata.
 * @returns The analysis result JSON.
 */
export async function analyzeAudio(
    input: string | AudioInput,
    privateKey: string,
    apiUrl: string,
    extractLyrics: boolean = false
): Promise<AudioAnalysisResult> {
    const account = privateKeyToAccount(privateKey as Hex);

    // Resolve input parameters
    let fileUrl: string | undefined;
    let filePath: string | undefined;

    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (isLikelyLocalPath(trimmed)) {
            filePath = trimmed;
        } else {
            fileUrl = trimmed;
        }
    } else {
        filePath = input.filePath ? input.filePath.trim() : undefined;
        fileUrl = input.fileUrl ? input.fileUrl.trim() : undefined;
    }

    // If both are provided, prioritize the local file
    if (filePath && fileUrl) {
        console.error(`[Tag-per-Track MCP] Both 'filePath' and 'fileUrl' provided. Prioritizing local file: "${filePath}".`);
        fileUrl = undefined;
    }

    // Auto-detect if fileUrl is actually a local file or file:// URL
    if (!filePath && fileUrl) {
        if (isLikelyLocalPath(fileUrl)) {
            const potentialLocalPath = resolveLocalPath(fileUrl);
            if (fs.existsSync(potentialLocalPath)) {
                console.error(`[Tag-per-Track MCP] Detected local file in 'fileUrl' ("${fileUrl}"). Auto-converting to local upload.`);
                filePath = potentialLocalPath;
                fileUrl = undefined;
            } else {
                throw new Error(
                    `Invalid fileUrl "${fileUrl}": local or relative filesystem paths cannot be fetched by the remote server. ` +
                    `The file was also not found locally at "${potentialLocalPath}". Please provide an existing local file via 'filePath' or a valid public HTTP/IPFS URL via 'fileUrl'.`
                );
            }
        }
    }

    if (!filePath && !fileUrl) {
        throw new Error("Missing audio source: Please provide either 'filePath' (for a local audio file on disk) or 'fileUrl' (for a public HTTP/HTTPS or IPFS URL).");
    }

    // Pre-validate local file metadata (WITHOUT loading buffer into memory yet)
    let localFileMeta: { resolvedPath: string; filename: string; mimeType: string; size: number } | undefined;
    let localFileCleanup: (() => Promise<void>) | undefined;

    if (filePath) {
        const resolvedPath = resolveLocalPath(filePath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`Local file not found: "${filePath}" (resolved path: "${resolvedPath}"). Please verify the path.`);
        }
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
            throw new Error(`The provided path is not a regular file: "${filePath}"`);
        }
        if (stat.size > MAX_LOCAL_FILE_SIZE) {
            throw new Error(`File is too large (${(stat.size / 1024 / 1024).toFixed(2)} MB). Maximum allowed size is 50MB.`);
        }
        const filename = path.basename(resolvedPath);
        const mimeType = getAudioMimeType(filename); // Throws if not a recognized audio extension

        // Selectively compress if heavy (> 15 MB) or uncompressed (.wav, .aiff)
        const compressed = await compressAudioIfHeavy(resolvedPath, filename, mimeType, stat.size);
        localFileMeta = {
            resolvedPath: compressed.resolvedPath,
            filename: compressed.filename,
            mimeType: compressed.mimeType,
            size: compressed.size
        };
        localFileCleanup = compressed.cleanup;
    }

    const targetUrl = buildTargetUrl(apiUrl, extractLyrics);

    const sourceDescription = localFileMeta
        ? `local file: ${localFileMeta.filename} (${(localFileMeta.size / 1024 / 1024).toFixed(2)} MB)`
        : `remote URL: ${fileUrl}`;

    console.error(`[Tag-per-Track MCP] Starting analysis for ${sourceDescription} (extractLyrics: ${extractLyrics})`);
    console.error(`[Tag-per-Track MCP] Target endpoint: ${targetUrl}`);

    try {
        // 1. Initial Request (Triggers 402 Payment Required) - 15s timeout
        const triggerBody = fileUrl ? { fileUrl } : { fileName: localFileMeta?.filename };
        let initialResponse: Response;

        try {
            initialResponse = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(triggerBody),
                signal: AbortSignal.timeout(15_000)
            });
        } catch (networkError: any) {
            if (networkError.name === 'TimeoutError') {
                throw new Error(`Initial connection to ${targetUrl} timed out after 15 seconds. Please verify your internet connection or API status.`);
            }
            throw new Error(`Failed to reach Tag-per-Track API: ${networkError.message}`);
        }

        if (initialResponse.status === 400) {
            let errorMsg = 'Bad request';
            try {
                const error = await initialResponse.json();
                errorMsg = error.message || errorMsg;
            } catch {}
            throw new Error(`Request failed (HTTP 400): ${errorMsg}`);
        }

        if (initialResponse.status !== 402) {
            let errorDetail = '';
            try {
                const text = await initialResponse.text();
                if (text) errorDetail = `: ${text.slice(0, 300)}`;
            } catch {}
            throw new Error(`Expected HTTP 402 Payment Required from API, but received HTTP ${initialResponse.status}${errorDetail}`);
        }

        // 2. Extract x402 Payment Requirements
        const paymentRequiredHeader = initialResponse.headers.get("PAYMENT-REQUIRED");
        let requirements: X402Requirements;
        
        try {
            if (paymentRequiredHeader) {
                const decoded = typeof atob !== 'undefined' 
                    ? atob(paymentRequiredHeader) 
                    : Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8');
                requirements = JSON.parse(decoded);
            } else {
                const errorData = await initialResponse.json();
                requirements = errorData.paymentRequirements;
            }
        } catch (parseError: any) {
            throw new Error(`Failed to parse x402 payment requirements from server: ${parseError.message}`);
        }

        if (!requirements) {
            throw new Error("Missing 'paymentRequirements' in the HTTP 402 response.");
        }

        // Handle x402 v2 structure where payment terms are in 'accepts' array
        const accept: X402PaymentAccept | undefined = requirements.accepts ? requirements.accepts[0] : (requirements as unknown as X402PaymentAccept);

        if (!accept || !accept.asset || !accept.payTo) {
            throw new Error("Incomplete payment terms in x402 response (missing asset or payTo address).");
        }

        // 3. Enforce Financial Spending Cap & Security Guards
        const rawAmount = accept.amount || accept.maxAmountRequired;
        if (!rawAmount) {
            throw new Error("Missing payment amount in x402 terms.");
        }

        const requestedAmount = BigInt(rawAmount);
        const maxSpendingCap = getMaxSpendingCap();

        if (requestedAmount > maxSpendingCap) {
            const requestedUsdc = (Number(requestedAmount) / 1_000_000).toFixed(4);
            const maxUsdc = (Number(maxSpendingCap) / 1_000_000).toFixed(4);
            throw new Error(
                `[Security Guard] Requested payment of ${requestedUsdc} USDC exceeds your maximum spending limit of ${maxUsdc} USDC. ` +
                `Aborting transaction to protect your wallet. You can increase this limit by setting the MAX_SPENDING_USDC environment variable.`
            );
        }

        console.error(`[Tag-per-Track MCP] 402 Received. Payment authorized: ${(Number(requestedAmount) / 1_000_000).toFixed(2)} USDC to ${accept.payTo}. Preparing EIP-3009 signature...`);

        // 4. Construct EIP-3009 Message (TransferWithAuthorization)
        const randomBytes = crypto.getRandomValues(new Uint8Array(32));
        const nonce = `0x${Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
        const validBefore = Math.floor(Date.now() / 1000) + EIP3009_VALIDITY_SECONDS; // 5 minutes TTL

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
            value: requestedAmount,
            validAfter: BigInt(0),
            validBefore: BigInt(validBefore),
            nonce: nonce as Hex,
        };

        // 5. Sign the Authorization Message
        const signature = await account.signTypedData({
            domain,
            types,
            primaryType: 'TransferWithAuthorization',
            message,
        });

        // 6. Construct Payment Proof (x402 V2 structure aligned with standard)
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

        console.error(`[Tag-per-Track MCP] Proof generated and signed. Submitting analysis request to ${targetUrl}...`);

        // 7. Secondary Call with PAYMENT-SIGNATURE header & deferred file read
        const headers: Record<string, string> = {
            'PAYMENT-SIGNATURE': paymentProof,
            'X-Payment-Proof': paymentProof // Kept for backwards compatibility
        };

        let body: BodyInit;
        if (localFileMeta) {
            // Deferred read: only read into memory now that the payment challenge has succeeded
            const buffer = await fs.promises.readFile(localFileMeta.resolvedPath);
            const formData = new FormData();
            const blob = new Blob([buffer], { type: localFileMeta.mimeType });
            formData.append('file', blob, localFileMeta.filename);
            body = formData;
        } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify({ fileUrl });
        }

        let finalResponse: Response;
        try {
            finalResponse = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(120_000) // 120s timeout for heavy audio/lyrics AI models
            });
        } catch (networkError: any) {
            if (networkError.name === 'TimeoutError') {
                throw new Error(`Audio analysis timed out after 120 seconds. The audio processing pipeline took longer than expected.`);
            }
            throw new Error(`Failed to transmit signed analysis request: ${networkError.message}`);
        }

        if (!finalResponse.ok) {
            let errorMsg = `Analysis failed after payment (HTTP ${finalResponse.status})`;
            try {
                const error = await finalResponse.json();
                errorMsg = error.message || errorMsg;
                console.error("[Tag-per-Track MCP] Detailed backend error:", JSON.stringify(error, null, 2));
            } catch {
                try {
                    const rawText = await finalResponse.text();
                    if (rawText) errorMsg += `: ${rawText.slice(0, 300)}`;
                } catch {}
            }
            throw new Error(errorMsg);
        }

        const result = await finalResponse.json();
        console.error(`[Tag-per-Track MCP] Analysis completed successfully.`);

        return result.data;
    } finally {
        if (localFileCleanup) {
            await localFileCleanup();
        }
    }
}

/**
 * Runs tasks with a maximum concurrency limit.
 */
export async function runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let currentIndex = 0;

    async function worker() {
        while (currentIndex < items.length) {
            const index = currentIndex++;
            results[index] = await fn(items[index], index);
        }
    }

    const workerCount = Math.min(Math.max(limit, 1), items.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);
    return results;
}

/**
 * Analyzes multiple tracks in parallel with bounded concurrency.
 * Provides resilient, partial-success reporting via Promise.all execution.
 */
export async function analyzeAudioBatch(
    tracks: BatchTrackItem[],
    privateKey: string,
    apiUrl: string,
    globalExtractLyrics: boolean = false,
    concurrency: number = 4
): Promise<BatchAnalysisResponse> {
    const safeConcurrency = Math.min(Math.max(concurrency, 1), 5);

    console.error(`[Tag-per-Track MCP] Starting batch analysis of ${tracks.length} track(s) with concurrency ${safeConcurrency}...`);

    const results = await runWithConcurrency(
        tracks,
        safeConcurrency,
        async (trackItem, index) => {
            const label = trackItem.filePath
                ? path.basename(trackItem.filePath)
                : (trackItem.fileUrl ? trackItem.fileUrl.split('/').pop() || trackItem.fileUrl : `Track #${index + 1}`);

            const extractLyrics = trackItem.extractLyrics !== undefined
                ? trackItem.extractLyrics
                : globalExtractLyrics;

            try {
                const data = await analyzeAudio(
                    { filePath: trackItem.filePath, fileUrl: trackItem.fileUrl },
                    privateKey,
                    apiUrl,
                    extractLyrics
                );
                return {
                    track: label,
                    filePath: trackItem.filePath,
                    fileUrl: trackItem.fileUrl,
                    extractLyrics,
                    status: 'success' as const,
                    data
                };
            } catch (err: any) {
                console.error(`[Tag-per-Track MCP] Batch item failed (${label}):`, err.message);
                return {
                    track: label,
                    filePath: trackItem.filePath,
                    fileUrl: trackItem.fileUrl,
                    extractLyrics,
                    status: 'error' as const,
                    error: err.message || String(err)
                };
            }
        }
    );

    const successful = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;

    console.error(`[Tag-per-Track MCP] Batch completed: ${successful} succeeded, ${failed} failed.`);

    return {
        totalTracks: tracks.length,
        successful,
        failed,
        concurrency: safeConcurrency,
        results
    };
}
