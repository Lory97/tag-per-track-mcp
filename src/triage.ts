import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from 'music-metadata';
import {
    analyzeAudioBatch,
    isAccountLevelFailure,
    resolveLocalPath,
    SUPPORTED_AUDIO_MIME_TYPES,
    type ArEvaluation,
    type ArProfile,
    type AudioAnalysisResult,
    type AuthConfig,
    type BatchTrackItem,
} from './x402.js';

/**
 * Demo inbox triage: scans a local folder of demo submissions, analyzes every track, enriches it with
 * Spotify traction, re-scores it server-side (A&R scoring v2) and returns a compact ranked report.
 * The raw analysis payloads are deliberately NOT returned: a 20-track folder must fit in the LLM context.
 */

export const TRIAGE_DEFAULT_MAX_TRACKS = 25;
export const TRIAGE_HARD_MAX_TRACKS = 50;
export const TRIAGE_DEFAULT_CONCURRENCY = 3;

export type TriageProfile = ArProfile | 'auto';
/** not_analyzed: never analyzed because the account stopped the triage (credits exhausted, invalid key) */
export type TriageBucket = 'priority' | 'listen' | 'pass' | 'ai_flagged' | 'error' | 'not_analyzed';
export type LyricsStatus = 'ok' | 'instrumental' | 'no_vocals_detected' | 'suspect_repetition';

export interface TriageOptions {
    folderPath: string;
    profile?: TriageProfile;
    extractLyrics?: boolean;
    recursive?: boolean;
    maxTracks?: number;
    concurrency?: number;
    dryRun?: boolean;
    lookupArtists?: boolean;
}

export interface TrackIdentity {
    filePath: string;
    file: string;
    artist?: string;
    title: string;
    identitySource: 'tags' | 'filename';
}

export interface LyricsAssessment {
    status: LyricsStatus;
    excerpt?: string;
}

export interface TriageTrack {
    rank?: number;
    /** Absent on a dry run (nothing analyzed yet) */
    bucket?: TriageBucket;
    file: string;
    artist?: string;
    title: string;
    score?: number;
    priority?: string;
    recommendation?: string;
    isGem?: boolean;
    profile?: ArProfile;
    audio?: {
        bpm?: number;
        key?: string;
        genre?: string;
        moods?: string[];
        audioType?: string;
        durationSec?: number;
    };
    ai?: {
        verdict?: string;
        confidence?: number;
        generator?: string;
        flag: 'blocked' | 'suspected' | 'uncertain' | 'clear' | 'unchecked';
    };
    traction?: {
        spotifyArtist: string;
        monthlyListeners: number | null;
        followers: number | null;
        tier: string;
    } | null;
    reasons?: string[];
    lyrics?: LyricsAssessment;
    error?: string;
}

export interface TriageReport {
    folder: string;
    profile: TriageProfile;
    dryRun: boolean;
    totalFiles: number;
    analyzed: number;
    failed: number;
    skippedOverLimit: number;
    /** Set when the triage stopped early: studio credits exhausted or API key rejected */
    halted?: { reason: string; notAnalyzed: number };
    buckets: Record<TriageBucket, number>;
    estimatedCost: { studioCredits: number; usdc: number };
    scoringVersion?: string;
    elapsedSeconds: number;
    notes: string[];
    tracks: TriageTrack[];
}

type ArtistStats = {
    name: string;
    spotify?: { id?: string; followers?: number; popularity?: number; monthlyListeners?: number };
};

// ---------------------------------------------------------------------------
// Folder scanning & track identity
// ---------------------------------------------------------------------------

export async function listAudioFiles(folderPath: string, recursive = false): Promise<string[]> {
    const root = resolveLocalPath(folderPath);
    if (!fs.existsSync(root)) {
        throw new Error(`Folder not found: "${folderPath}" (resolved path: "${root}").`);
    }
    if (!(await fs.promises.stat(root)).isDirectory()) {
        throw new Error(`The provided path is not a folder: "${folderPath}". Use analyze_audio for a single file.`);
    }

    const found: string[] = [];
    const walk = async (dir: string) => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (recursive) await walk(full);
            } else if (entry.isFile() && SUPPORTED_AUDIO_MIME_TYPES[path.extname(entry.name).toLowerCase()]) {
                found.push(full);
            }
        }
    };
    await walk(root);
    return found.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

/** Upload-site suffixes that say nothing about the song: "(Clip officiel)", "[Official Video]", "(128k)"... */
const TITLE_NOISE =
    /\s*[([](?:clip officiel|official (?:music )?video|music video|official audio|audio officiel|audio|visuali[sz]er|lyrics? video|\d{2,3}\s?k(?:bps)?)[)\]]/gi;

export function cleanTitle(title: string): string {
    return title.replace(TITLE_NOISE, '').replace(/\s+/g, ' ').trim() || title.trim();
}

/** "Artist - Title" (or "Artist – Title") file names; otherwise the whole name is the title. */
export function identityFromFilename(filePath: string): { artist?: string; title: string } {
    const base = path.basename(filePath, path.extname(filePath)).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = base.split(/\s[-–—]\s/);
    if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
        return { artist: parts[0].trim(), title: cleanTitle(parts.slice(1).join(' - ')) };
    }
    return { title: cleanTitle(base) };
}

/**
 * An explicit "Artist - Title" file name wins over the tags: on demos, tags are often DAW or
 * account defaults ("lory_f") or the tags of a borrowed beat, while the file name is what the sender chose.
 */
export async function readTrackIdentity(filePath: string): Promise<TrackIdentity> {
    const fromName = identityFromFilename(filePath);
    const base = { filePath, file: path.basename(filePath) };
    if (fromName.artist) {
        return { ...base, artist: fromName.artist, title: fromName.title, identitySource: 'filename' };
    }
    try {
        const { common } = await parseFile(filePath, { duration: false, skipCovers: true });
        const artists = [...new Set((common.artists?.length ? common.artists : [common.artist || '']).map((a) => a.trim()).filter(Boolean))];
        const tagTitle = common.title?.trim();
        if (artists.length || tagTitle) {
            return {
                ...base,
                artist: artists.length ? artists.join(' & ') : undefined,
                title: tagTitle ? cleanTitle(tagTitle) : fromName.title,
                identitySource: 'tags',
            };
        }
    } catch {
        // Unreadable tags: keep the file name
    }
    return { ...base, title: fromName.title, identitySource: 'filename' };
}

/** Main artist used for the Spotify lookup: "Miimii ft Dj Skycee" -> "Miimii". */
export function primaryArtist(artist: string): string {
    return artist.split(/\s+(?:feat\.?|ft\.?|featuring|x|&|avec|with)\s+|\s*[,;/]\s*/i)[0].trim();
}

// ---------------------------------------------------------------------------
// Lyrics guard (point 3): never show hallucinated lyrics on an instrumental
// ---------------------------------------------------------------------------

const LYRICS_EXCERPT_MAX_CHARS = 180;

/**
 * Whisper invents text over music without a voice (a short phrase looping, often in another language).
 * The backend already drops the segments Whisper itself flags as no-speech; this is the client-side net.
 */
export function assessLyrics(lyrics: string | undefined, evaluation?: ArEvaluation): LyricsAssessment | undefined {
    if (lyrics === undefined || lyrics === null) return undefined;
    if (evaluation?.audioType === 'instrumental') return { status: 'instrumental' };

    const text = String(lyrics).replace(/\s+/g, ' ').trim();
    if (!text) return { status: 'no_vocals_detected' };

    const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    const unique = new Set(words);
    if (words.length >= 6 && unique.size <= 6 && words.length >= unique.size * 2) {
        return { status: 'suspect_repetition', excerpt: truncate(text, 60) };
    }
    return { status: 'ok', excerpt: truncate(text, LYRICS_EXCERPT_MAX_CHARS) };
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Backend helpers (free routes: artist stats and A&R re-scoring)
// ---------------------------------------------------------------------------

async function fetchArtistStats(apiBaseUrl: string, name: string): Promise<ArtistStats | null> {
    const url = `${apiBaseUrl}/artist-stats?name=${encodeURIComponent(name)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (response.status === 404) return null;
        if (response.status === 429 && attempt === 0) {
            // Gateway throttling (30 req/min/IP): wait once, then give up on this artist
            const retryAfter = Number(response.headers.get('retry-after'));
            await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10_000, 20_000)));
            continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as ArtistStats;
    }
    throw new Error('rate limited');
}

async function rescore(
    apiBaseUrl: string,
    items: Array<{ analysis: AudioAnalysisResult; artistStats: ArtistStats | null }>,
): Promise<ArEvaluation[] | null> {
    try {
        const response = await fetch(`${apiBaseUrl}/ar-score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ items }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { evaluations?: ArEvaluation[] };
        return Array.isArray(body.evaluations) && body.evaluations.length === items.length ? body.evaluations : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export function bucketFor(evaluation: ArEvaluation, profile: ArProfile): TriageBucket {
    if (evaluation.aiGate?.blocked || evaluation.aiGate?.suspected) return 'ai_flagged';
    const priority = evaluation.profiles?.[profile]?.priority;
    if (priority === 'top' || priority === 'high') return 'priority';
    if (priority === 'medium') return 'listen';
    return 'pass';
}

function aiFlag(evaluation: ArEvaluation | undefined, checked: boolean): NonNullable<TriageTrack['ai']>['flag'] {
    if (!checked) return 'unchecked';
    if (evaluation?.aiGate?.blocked) return 'blocked';
    if (evaluation?.aiGate?.suspected) return 'suspected';
    if (evaluation?.aiGate?.uncertain) return 'uncertain';
    return 'clear';
}

/** Up to 4 reason codes that actually moved the score (neutral mentions are left out). */
function keyReasons(evaluation: ArEvaluation): string[] {
    const reasons: string[] = [];
    if (evaluation.aiGate?.reason) reasons.push(evaluation.aiGate.reason.code);
    for (const sub of Object.values(evaluation.subScores || {})) {
        for (const reason of sub?.reasons || []) {
            if (reason.impact === 'neutral') continue;
            const sign = reason.impact === 'positive' ? '+' : '-';
            reasons.push(`${sign}${reason.code}${reason.value !== undefined ? `(${reason.value})` : ''}`);
        }
    }
    return [...new Set(reasons)].slice(0, 4);
}

function topLabels(list: AudioAnalysisResult['genres'], count: number): string[] {
    if (!Array.isArray(list)) return [];
    return list
        .slice(0, count)
        .map((item: any) => (typeof item === 'string' ? item : item?.label))
        .filter((label: any): label is string => typeof label === 'string' && label.length > 0);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function triageDemoFolder(
    options: TriageOptions,
    auth: AuthConfig,
    apiUrl: string,
    apiBaseUrl: string,
    onProgress?: (done: number, total: number, message: string) => void,
): Promise<TriageReport> {
    const startedAt = Date.now();
    const profile: TriageProfile = options.profile || 'discovery';
    const extractLyrics = Boolean(options.extractLyrics);
    const maxTracks = Math.min(Math.max(Math.floor(options.maxTracks || TRIAGE_DEFAULT_MAX_TRACKS), 1), TRIAGE_HARD_MAX_TRACKS);
    const notes: string[] = [];

    const allFiles = await listAudioFiles(options.folderPath, Boolean(options.recursive));
    if (allFiles.length === 0) {
        throw new Error(
            `No supported audio file found in "${options.folderPath}" (${Object.keys(SUPPORTED_AUDIO_MIME_TYPES).join(', ')}).`,
        );
    }
    const files = allFiles.slice(0, maxTracks);
    if (allFiles.length > files.length) {
        notes.push(`${allFiles.length - files.length} file(s) not analyzed: over the maxTracks limit of ${maxTracks}.`);
    }

    const identities = await Promise.all(files.map(readTrackIdentity));
    // Credits and payments are only taken on a successful analysis
    const costFor = (tracks: number) => ({
        studioCredits: tracks * (extractLyrics ? 2 : 1),
        usdc: Math.round(tracks * (extractLyrics ? 0.25 : 0.15) * 100) / 100,
    });
    const emptyBuckets = (): Record<TriageBucket, number> => ({ priority: 0, listen: 0, pass: 0, ai_flagged: 0, error: 0, not_analyzed: 0 });

    if (options.dryRun) {
        return {
            folder: resolveLocalPath(options.folderPath),
            profile,
            dryRun: true,
            totalFiles: allFiles.length,
            analyzed: 0,
            failed: 0,
            skippedOverLimit: allFiles.length - files.length,
            buckets: emptyBuckets(),
            estimatedCost: costFor(identities.length),
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            notes: [...notes, 'Dry run: nothing was analyzed or charged.'],
            tracks: identities.map((id) => ({ file: id.file, artist: id.artist, title: id.title })),
        };
    }

    // 1. Paid analyses (bounded concurrency; the Python engine runs 2 inferences at a time)
    const batchItems: BatchTrackItem[] = identities.map((id) => ({
        filePath: id.filePath,
        artist: id.artist,
        trackTitle: id.title,
    }));
    const batch = await analyzeAudioBatch(
        batchItems,
        auth,
        apiUrl,
        extractLyrics,
        options.concurrency || TRIAGE_DEFAULT_CONCURRENCY,
        (done, total, label, status) =>
            onProgress?.(done, total, `${status === 'success' ? 'Analyzed' : status === 'skipped' ? 'Not sent' : 'Failed'}: ${label}`),
    );

    // 2. Spotify traction, one lookup per distinct artist (free route)
    const statsByArtist = new Map<string, ArtistStats | null>();
    if (options.lookupArtists !== false) {
        const artists = [
            ...new Set(
                identities
                    .filter((_, i) => batch.results[i].status === 'success')
                    .map((id) => (id.artist ? primaryArtist(id.artist) : ''))
                    .filter(Boolean),
            ),
        ];
        for (const artist of artists) {
            try {
                statsByArtist.set(artist.toLowerCase(), await fetchArtistStats(apiBaseUrl, artist));
            } catch (err: any) {
                statsByArtist.set(artist.toLowerCase(), null);
                notes.push(`Spotify lookup failed for "${artist}" (${err?.message || err}): traction not evaluated.`);
            }
        }
    }
    const statsFor = (id: TrackIdentity) => (id.artist ? statsByArtist.get(primaryArtist(id.artist).toLowerCase()) ?? null : null);

    // 3. Server-side re-scoring with the traction attached (free, stateless)
    const successIdx = batch.results.map((r, i) => (r.status === 'success' ? i : -1)).filter((i) => i >= 0);
    const evaluations = new Map<number, ArEvaluation>();
    if (successIdx.length > 0) {
        const rescored = await rescore(
            apiBaseUrl,
            successIdx.map((i) => ({ analysis: batch.results[i].data!, artistStats: statsFor(identities[i]) })),
        );
        if (!rescored) notes.push('A&R re-scoring with Spotify traction unavailable: audio-only scores are shown.');
        successIdx.forEach((i, k) => {
            const evaluation = rescored?.[k] || batch.results[i].data?.arEvaluation;
            if (evaluation) evaluations.set(i, evaluation);
        });
    }

    // 4. Compact, ranked report
    const tracks: TriageTrack[] = identities.map((id, i) => {
        const result = batch.results[i];
        if (result.status !== 'success' || !result.data) {
            const error = result.error || 'Analysis failed';
            const bucket: TriageBucket = result.status === 'skipped' || isAccountLevelFailure(error) ? 'not_analyzed' : 'error';
            return { bucket, file: id.file, artist: id.artist, title: id.title, error };
        }
        const data = result.data;
        const evaluation = evaluations.get(i);
        const ai = data.aiDetection || data.ai_detection;
        const stats = statsFor(id);
        const trackProfile: ArProfile = profile === 'auto' ? evaluation?.suggestedProfile || 'discovery' : profile;
        const profileResult = evaluation?.profiles?.[trackProfile];

        return {
            bucket: evaluation ? bucketFor(evaluation, trackProfile) : 'listen',
            file: id.file,
            artist: id.artist,
            title: id.title,
            score: profileResult?.score,
            priority: profileResult?.priority,
            recommendation: profileResult?.recommendation,
            isGem: profileResult?.isGem,
            profile: trackProfile,
            audio: {
                bpm: typeof data.bpm === 'number' ? Math.round(data.bpm) : undefined,
                key: data.key ? `${data.key} ${data.scale || ''}`.trim() : undefined,
                genre: topLabels(data.genres, 1)[0],
                moods: topLabels(data.moods, 2),
                audioType: evaluation?.audioType,
                durationSec: typeof data.duration === 'number' ? Math.round(data.duration) : undefined,
            },
            ai: {
                verdict: ai?.verdict,
                confidence: ai?.confidence,
                generator: ai?.generator,
                flag: aiFlag(evaluation, ai?.checked === true && ai?.status !== 'UNAVAILABLE'),
            },
            traction: stats?.spotify
                ? {
                      spotifyArtist: stats.name,
                      monthlyListeners: evaluation?.metrics?.monthlyListeners ?? stats.spotify.monthlyListeners ?? null,
                      followers: evaluation?.metrics?.followers ?? stats.spotify.followers ?? null,
                      tier: evaluation?.tier || 'unknown',
                  }
                : null,
            reasons: evaluation ? keyReasons(evaluation) : [],
            lyrics: assessLyrics(data.lyrics, evaluation),
        };
    });

    const unranked = (t: TriageTrack) => t.bucket === 'error' || t.bucket === 'not_analyzed';
    tracks.sort((a, b) => {
        if (unranked(a) || unranked(b)) return Number(unranked(a)) - Number(unranked(b));
        return (b.score ?? -1) - (a.score ?? -1);
    });
    const ranked = tracks.map((t, i) => (unranked(t) ? t : { rank: i + 1, ...t }));

    const buckets = emptyBuckets();
    for (const t of ranked) if (t.bucket) buckets[t.bucket]++;
    if (batch.haltReason) {
        notes.unshift(
            `Triage stopped early: ${batch.haltReason} ${buckets.not_analyzed} track(s) were not analyzed (nothing charged for them). ` +
                `The ${batch.successful} analyzed track(s) are ranked below; recharge and run the triage again on the remaining files.`,
        );
    }
    const withoutArtist = identities.filter((id) => !id.artist).length;
    if (withoutArtist > 0 && options.lookupArtists !== false) {
        notes.push(`${withoutArtist} track(s) without an artist name (no tags, no "Artist - Title" file name): traction not evaluated.`);
    }

    return {
        folder: resolveLocalPath(options.folderPath),
        profile,
        dryRun: false,
        totalFiles: allFiles.length,
        analyzed: batch.successful,
        failed: buckets.error,
        halted: batch.haltReason ? { reason: batch.haltReason, notAnalyzed: buckets.not_analyzed } : undefined,
        skippedOverLimit: allFiles.length - files.length,
        buckets,
        estimatedCost: costFor(batch.successful),
        scoringVersion: evaluations.values().next().value?.version,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        notes,
        tracks: ranked,
    };
}
