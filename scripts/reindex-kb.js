#!/usr/bin/env node
'use strict';

const path = require('path');
const { ensureIndex, statusLine } = require('../modules/kb-rag');

const ROOT = path.resolve(__dirname, '..');
const kbDir = process.env.KB_DIR || path.join(ROOT, 'data', 'kb');
const indexFile = process.env.KB_RAG_INDEX_FILE || path.join(ROOT, 'data', 'kb-rag-index.json');

try {
    const t0 = Date.now();
    const { index, rebuilt } = ensureIndex(kbDir, indexFile, { force: true });
    console.log(`${rebuilt ? 'rebuilt' : 'loaded'} ${statusLine(index)} in ${Date.now() - t0}ms`);
    console.log(indexFile);
} catch (e) {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
}
