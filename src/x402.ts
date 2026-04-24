import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";

/**
 * Executes a micro-payment via the x402 protocol and analyzes an audio file.
 * 
 * @param fileUrl The URL of the audio file to analyze.
 * @param privateKey Hex string representing the private key.
 * @param apiUrl The Tag-per-Track API URL.
 * @returns The analysis result JSON.
 */
export async function analyzeAudio(fileUrl: string, privateKey: string, apiUrl: string): Promise<any> {
    const account = privateKeyToAccount(privateKey as Hex);

    console.error(`[Tag-per-Track MCP] Starting analysis for: ${fileUrl}`);

    // 1. Initial Request (Triggers 402 Payment Required)
    const initialResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUrl })
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
            url: apiUrl,
            description: 'Tag-per-Track: Agentic-First Musical Audio Analysis API. Extracts BPM, Key, Mood, Genres and Instruments from audio URLs.',
            mimeType: 'application/json',
        },
        extensions: requirements.extensions
    });

    console.error(`[Tag-per-Track MCP] Proof generated and signed. Re-submitting request...`);

    // 6. Secondary Call with PAYMENT-SIGNATURE header
    const finalResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'PAYMENT-SIGNATURE': paymentProof,
            'X-Payment-Proof': paymentProof // Kept for backwards compatibility
        },
        body: JSON.stringify({ fileUrl })
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
