// Resumable downloader with integrity verification.
//
// The local network here drops long connections mid-transfer (npm's own
// tarball fetches were truncated at ~24-70 MB), so a plain one-shot download
// silently produces a corrupt file. This helper resumes with Range requests
// until the expected size and checksum match.
//
// Usage: node scripts/fetch-verified.mjs <url> <outFile> <expectedSha512Base64> [expectedBytes]
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, statSync, truncateSync } from 'node:fs';
import process from 'node:process';

const MAX_ATTEMPTS = 40;
const CHUNK_TIMEOUT_MS = 120_000;

async function head(url) {
  const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
  const range = response.headers.get('content-range');
  const lengthHeader = response.headers.get('content-length');
  await response.body?.cancel().catch(() => undefined);
  if (range) {
    const total = Number.parseInt(range.split('/')[1], 10);
    if (Number.isInteger(total)) return total;
  }
  return lengthHeader ? Number.parseInt(lengthHeader, 10) : null;
}

async function download(url, outFile, expectedBytes) {
  let existing = existsSync(outFile) ? statSync(outFile).size : 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (expectedBytes !== null && existing === expectedBytes) return existing;
    if (expectedBytes !== null && existing > expectedBytes) {
      // A previous attempt overshot (should not happen); restart cleanly.
      truncateSync(outFile, 0);
      existing = 0;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
    try {
      const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('no body');

      const stream = createWriteStream(outFile, { flags: existing > 0 ? 'a' : 'w' });
      let received = 0;
      for await (const chunk of response.body) {
        stream.write(chunk);
        received += chunk.length;
      }
      await new Promise((resolve, reject) => {
        stream.end((error) => (error ? reject(error) : resolve()));
      });

      existing += received;
      if (expectedBytes === null || existing === expectedBytes) return existing;
    } catch (error) {
      // Keep whatever bytes arrived; the next attempt resumes from there.
      existing = existsSync(outFile) ? statSync(outFile).size : existing;
      process.stderr.write(
        `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)} (have ${existing} bytes)\n`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return existsSync(outFile) ? statSync(outFile).size : 0;
}

function sha512Base64(file) {
  const hash = createHash('sha512');
  hash.update(readFileSync(file));
  return hash.digest('base64');
}

const [url, outFile, expectedIntegrity, expectedBytesArg] = process.argv.slice(2);
if (!url || !outFile) {
  console.error('usage: node scripts/fetch-verified.mjs <url> <outFile> [sha512-base64] [bytes]');
  process.exit(2);
}

const expectedBytes = expectedBytesArg ? Number.parseInt(expectedBytesArg, 10) : await head(url);
const size = await download(url, outFile, expectedBytes);
const actual = sha512Base64(outFile);
const expected = expectedIntegrity ? expectedIntegrity.replace(/^sha512-/u, '') : null;

if (expectedBytes !== null && size !== expectedBytes) {
  console.error(`SIZE_MISMATCH: got ${size}, expected ${expectedBytes}`);
  process.exit(1);
}
if (expected && actual !== expected) {
  console.error(`INTEGRITY_MISMATCH: got ${actual}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, bytes: size, sha512: actual }));
