'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STOP_WORDS = new Set([
    'yang', 'dan', 'atau', 'buat', 'untuk', 'dengan', 'kalau', 'pake', 'pakai',
    'bisa', 'apa', 'gimana', 'kenapa', 'versi', 'setting', 'settingan', 'jadi',
    'ini', 'itu', 'dari', 'ke', 'di', 'ga', 'gak', 'nggak', 'ngga', 'aja', 'yg',
    'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'are', 'was'
]);

const SYNONYMS = {
    mtk: ['mediatek'],
    mediatek: ['mtk'],
    dimensity: ['mediatek', 'mtk'],
    helio: ['mediatek', 'mtk'],
    mali: ['mediatek', 'mtk'],
    adreno: ['snapdragon', 'turnip'],
    snapdragon: ['adreno'],
    sd: ['snapdragon', 'adreno'],
    dx12: ['vkd3d', 'directx12'],
    directx12: ['dx12', 'vkd3d'],
    vkd3d: ['dx12', 'directx12'],
    dx11: ['dxvk', 'directx11'],
    directx11: ['dx11', 'dxvk'],
    dxvk: ['dx11', 'directx11'],
    wine: ['winlator', 'proton'],
    winlator: ['wine'],
    bannerhub: ['the412banner'],
    ludashi: ['winlator'],
    box64: ['dynarec'],
    fex: ['fexcore'],
    fexcore: ['fex'],
    turnip: ['adreno', 'snapdragon']
};

function listMarkdownFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => path.join(dir, f));
}

function sourceSignature(files) {
    const h = crypto.createHash('sha256');
    for (const file of files) {
        const raw = fs.readFileSync(file);
        h.update(path.basename(file));
        h.update('\0');
        h.update(raw);
        h.update('\0');
    }
    return h.digest('hex');
}

function confidencePriority(text) {
    const t = String(text || '').toUpperCase();
    if (t.includes('[VERIFIED')) return 0;
    if (t.includes('[REVEALED PREFERENCE') || t.includes('[REVEALED PREF')) return 1;
    if (t.includes('[THEORETICAL')) return 3;
    return 2;
}

function splitSections(raw) {
    const parts = String(raw || '').split(/^## /m);
    const sections = [];
    if (parts[0] && parts[0].trim()) {
        sections.push({ header: '(intro)', body: parts[0].trim() });
    }
    for (let i = 1; i < parts.length; i++) {
        const seg = parts[i];
        const nl = seg.indexOf('\n');
        const header = nl < 0 ? seg.trim() : seg.slice(0, nl).trim();
        const body = nl < 0 ? '' : seg.slice(nl + 1).trim();
        if ((header + body).trim()) sections.push({ header, body });
    }
    return sections;
}

function wordsOf(text) {
    return String(text || '')
        .replace(/`([^`]+)`/g, ' $1 ')
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9.+_-]{1,}/g) || [];
}

function expandToken(token) {
    const out = [token];
    if (/^v?\d{2,3}$/.test(token)) out.push(`driver-${token.replace(/^v/, '')}`);
    if (/^8gen\d$/.test(token)) out.push('snapdragon', 'adreno');
    if (SYNONYMS[token]) out.push(...SYNONYMS[token]);
    return out;
}

function featuresFor(text) {
    const base = wordsOf(text).filter((w) => !STOP_WORDS.has(w));
    const tokens = [];
    for (const t of base) tokens.push(...expandToken(t));
    for (let i = 0; i < base.length - 1; i++) {
        if (!STOP_WORDS.has(base[i]) && !STOP_WORDS.has(base[i + 1])) {
            tokens.push(`${base[i]}_${base[i + 1]}`);
        }
    }
    return tokens;
}

function chunkText(text, maxWords = 180, overlap = 45) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return [words.join(' ')];
    const chunks = [];
    const step = Math.max(40, maxWords - overlap);
    for (let i = 0; i < words.length; i += step) {
        chunks.push(words.slice(i, i + maxWords).join(' '));
        if (i + maxWords >= words.length) break;
    }
    return chunks;
}

function buildRawChunks(kbDir) {
    const files = listMarkdownFiles(kbDir);
    const chunks = [];
    let sectionCount = 0;
    for (const filePath of files) {
        const file = path.basename(filePath);
        const raw = fs.readFileSync(filePath, 'utf8');
        for (const sec of splitSections(raw)) {
            sectionCount++;
            const full = `${sec.header}\n${sec.body}`.trim();
            const pieces = chunkText(full);
            pieces.forEach((piece, idx) => {
                const id = crypto.createHash('sha1')
                    .update(`${file}\0${sec.header}\0${idx}\0${piece}`)
                    .digest('hex')
                    .slice(0, 16);
                chunks.push({
                    id,
                    file,
                    header: sec.header,
                    chunk: idx + 1,
                    text: piece,
                    confidence: confidencePriority(full)
                });
            });
        }
    }
    return { files, chunks, sectionCount };
}

function vectorize(features, idf) {
    const counts = {};
    for (const f of features) counts[f] = (counts[f] || 0) + 1;
    const vec = {};
    let normSq = 0;
    for (const [feature, count] of Object.entries(counts)) {
        const weight = (1 + Math.log(count)) * (idf[feature] || 1);
        vec[feature] = Number(weight.toFixed(6));
        normSq += weight * weight;
    }
    return { vector: vec, norm: Math.sqrt(normSq) || 1 };
}

function buildIndex(kbDir) {
    const { files, chunks, sectionCount } = buildRawChunks(kbDir);
    const docFreq = {};
    const chunkFeatures = chunks.map((chunk) => {
        const features = featuresFor(`${chunk.file}\n${chunk.header}\n${chunk.text}`);
        for (const f of new Set(features)) docFreq[f] = (docFreq[f] || 0) + 1;
        return features;
    });
    const total = Math.max(1, chunks.length);
    const idf = {};
    for (const [feature, df] of Object.entries(docFreq)) {
        idf[feature] = Number((1 + Math.log((1 + total) / (1 + df))).toFixed(6));
    }
    const indexedChunks = chunks.map((chunk, i) => {
        const { vector, norm } = vectorize(chunkFeatures[i], idf);
        return { ...chunk, vector, norm: Number(norm.toFixed(6)) };
    });
    return {
        version: 1,
        builtAt: new Date().toISOString(),
        sourceHash: sourceSignature(files),
        fileCount: files.length,
        sectionCount,
        chunkCount: indexedChunks.length,
        idf,
        chunks: indexedChunks
    };
}

function loadIndex(indexFile) {
    try {
        if (!fs.existsSync(indexFile)) return null;
        return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch {
        return null;
    }
}

function saveIndex(indexFile, index) {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, indexFile);
}

function ensureIndex(kbDir, indexFile, opts = {}) {
    const files = listMarkdownFiles(kbDir);
    const currentHash = sourceSignature(files);
    const cached = opts.force ? null : loadIndex(indexFile);
    if (cached && cached.version === 1 && cached.sourceHash === currentHash && Array.isArray(cached.chunks)) {
        return { index: cached, rebuilt: false };
    }
    const index = buildIndex(kbDir);
    saveIndex(indexFile, index);
    return { index, rebuilt: true };
}

function dotProduct(a, b) {
    let score = 0;
    const small = Object.keys(a).length <= Object.keys(b).length ? a : b;
    const large = small === a ? b : a;
    for (const [k, v] of Object.entries(small)) {
        if (large[k]) score += v * large[k];
    }
    return score;
}

function domainBonus(query, chunk) {
    const q = String(query || '').toLowerCase();
    const hay = `${chunk.file}\n${chunk.header}\n${chunk.text}`.toLowerCase();
    let bonus = 0;
    const pairs = [
        [/mali|mtk|mediatek|dimensity|helio/, /mali|mtk|mediatek|dimensity|helio|mtk-mali-modern|gpu-rules/],
        [/adreno|snapdragon|turnip/, /adreno|snapdragon|turnip|turnip-per-adreno|gpu-rules/],
        [/dx12|directx ?12|vkd3d/, /dx12|directx ?12|vkd3d/],
        [/dx11|directx ?11|dxvk/, /dx11|directx ?11|dxvk/],
        [/box64|dynarec|bigblock|safeflags/, /box64|dynarec|bigblock|safeflags/],
        [/fex|fexcore/, /fex|fexcore/],
        [/wine|proton|winlator|ludashi|bannerhub/, /wine|proton|winlator|ludashi|bannerhub|the412banner/]
    ];
    for (const [needle, target] of pairs) {
        if (needle.test(q) && target.test(hay)) bonus += 0.08;
    }
    if (chunk.confidence === 0) bonus += 0.04;
    if (chunk.confidence === 1) bonus += 0.02;
    if (chunk.confidence === 3) bonus -= 0.03;
    return bonus;
}

function searchIndex(index, query, opts = {}) {
    const topK = Math.max(1, opts.topK || 8);
    const qFeatures = featuresFor(query);
    if (!qFeatures.length) return [];
    const { vector: qVec, norm: qNorm } = vectorize(qFeatures, index.idf || {});
    const scored = [];
    for (const chunk of index.chunks || []) {
        const cosine = dotProduct(qVec, chunk.vector || {}) / (qNorm * (chunk.norm || 1));
        const score = cosine + domainBonus(query, chunk);
        if (score > 0) scored.push({ ...chunk, score });
    }
    scored.sort((a, b) => b.score - a.score || a.confidence - b.confidence || a.file.localeCompare(b.file));
    return scored.slice(0, topK);
}

function formatResults(query, hits, index) {
    if (!hits.length) return `kb_rag_search: ga ada chunk relevan buat "${query}".`;
    let out = `# KB RAG hits buat "${query}" (${hits.length}/${index.chunkCount} chunk, source: COPUX data/kb)\n`;
    for (const h of hits) {
        let body = h.text.replace(/\s+/g, ' ').trim();
        if (body.length > 850) body = `${body.slice(0, 850)} ...`;
        out += `\n## ${h.header}\n_(file: ${h.file}, chunk: ${h.chunk}, score: ${h.score.toFixed(3)})_\n${body}\n`;
    }
    return out;
}

function statusLine(index) {
    if (!index) return 'RAG: belum loaded';
    return `RAG: ${index.chunkCount} chunk / ${index.sectionCount} section / ${index.fileCount} file, built ${index.builtAt}`;
}

module.exports = {
    buildIndex,
    ensureIndex,
    loadIndex,
    saveIndex,
    searchIndex,
    formatResults,
    statusLine
};
