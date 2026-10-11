#!/usr/bin/env node
/**
 * update-projects.mjs — KanekiDevPro Profile Kit
 *
 * Fetches PUBLIC repositories owned by the account via the official GitHub
 * REST API, filters and ranks them, and regenerates ONLY the "Featured
 * Projects" section between the dedicated markers in README.md.
 *
 * Privacy guarantees:
 *   - Only `GET /users/{user}/repos` (public data) is used. The endpoint
 *     returns only PUBLIC repositories even when an authenticated token is
 *     present, so private repository names/data can never leak into the
 *     README.
 *   - No tokens or secrets are ever printed to logs.
 *   - No content outside the markers is modified.
 *
 * Usage:
 *   node scripts/update-projects.mjs [--readme <path>] [--dry-run] [--verbose]
 *
 * Env:
 *   GITHUB_TOKEN   optional; raises the anonymous rate limit (60/h -> 5000/h)
 *   GITHUB_USER    defaults to KanekiDevPro
 *
 * Exit codes:
 *   0 = README updated, or nothing changed, or no eligible repos
 *   2 = usage error
 *   3 = the README markers are missing or malformed
 *   4 = GitHub API error (network, HTTP status, rate limit)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/* ------------------------------------------------------------------ */
/* Configuration (all overridable via CLI/env)                         */
/* ------------------------------------------------------------------ */

const USER = process.env.GITHUB_USER || 'KanekiDevPro';
const HTML_URL = `https://github.com/${USER}`;
const FEATURED_TOPIC = 'profile-featured'; // optional curation topic

const MARKER_START = '<!-- FEATURED_PROJECTS:START -->';
const MARKER_END = '<!-- FEATURED_PROJECTS:END -->';

const DEFAULT_LIMITS = {
  maxFeatured: 6,
  minDaysSincePushToSuppressStale: 0,
};

const WEIGHTS = {
  stars: 0.35,
  forks: 0.10,
  recency: 0.40,
  metadata: 0.15,
};

/* ------------------------------------------------------------------ */
/* CLI parsing                                                         */
/* ------------------------------------------------------------------ */

function parseArgs(argv, env = {}) {
  const args = {
    readme: 'README.md',
    dryRun: env.DRY_RUN === 'true', // workflow sets this instead of interpolating CLI flags
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--readme') args.readme = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose') args.verbose = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2), process.env);
const log = (...m) => { if (args.verbose) console.log(...m); };

/* ------------------------------------------------------------------ */
/* GitHub API client (public data only, no secrets in logs)            */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function apiHeaders() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': `${USER}-profile-kit`,
  };
  const token = process.env.GITHUB_TOKEN;
  if (token && token.trim()) {
    // Only used for the Authorization header; never logged.
    h['Authorization'] = `Bearer ${token.trim()}`;
  }
  return h;
}

async function fetchPage(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { headers: apiHeaders(), redirect: 'follow' });
  } catch (err) {
    if (attempt < 2) {
      const wait = 2 ** attempt * 1000;
      log(`  network error (${err.message}), retrying in ${wait} ms…`);
      await sleep(wait);
      return fetchPage(url, attempt + 1);
    }
    throw new ApiError(`network failure fetching ${redactUrl(url)}: ${err.message}`, 0);
  }

  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining') ?? '?';
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === '0') {
      const at = reset ? new Date(Number(reset) * 1000).toISOString() : 'unknown';
      throw new ApiError(`GitHub API rate limit exhausted (resets at ${at}). ` +
        'Set GITHUB_TOKEN to raise the limit from 60/h (anonymous) to 5,000/h.', 403);
    }
  }

  if (res.status >= 300) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new ApiError(`GitHub API returned HTTP ${res.status} for ${redactUrl(url)} ${body ? `— ${body}` : ''}`, res.status);
  }

  return res.json();
}

function redactUrl(url) {
  // Defensive: strip anything that looks like a credential in a query string.
  return url.replace(/([?&](?:token|access_token|api_key)=)[^&]*/gi, '$1<redacted>');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Follow pagination (Link header is the canonical mechanism). */
async function fetchAllPublicRepos(user) {
  const out = [];
  let page = 1;
  // Hard safety cap: 10 pages x 100 = 1000 repos max.
  while (page <= 10) {
    const url = `https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&page=${page}&type=owner&sort=pushed`;
    const chunk = await fetchPage(url);
    if (!Array.isArray(chunk)) {
      throw new ApiError('unexpected response shape: expected an array of repositories', 200);
    }
    out.push(...chunk);
    if (chunk.length < 100) break;
    page++;
    await sleep(150); // be polite to the API
  }
  log(`fetched ${out.length} public repository record(s) for ${user}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Filtering + ranking                                                 */
/* ------------------------------------------------------------------ */

/**
 * Eligibility rules (documented in SETUP.md):
 *   - public, not a fork, not archived, not disabled, not the profile repo,
 *     not a template repo without content.
 * Returns { eligible: Boolean, reason?: String }.
 */
function isEligible(repo, profileRepo) {
  if (repo.private) return { eligible: false, reason: 'private (should not appear in public listing)' };
  if (repo.fork) return { eligible: false, reason: 'fork' };
  if (repo.archived) return { eligible: false, reason: 'archived' };
  if (repo.disabled) return { eligible: false, reason: 'disabled' };
  if (repo.name === profileRepo) return { eligible: false, reason: 'profile README repository' };
  if (!repo.html_url || !repo.name) return { eligible: false, reason: 'missing metadata' };
  return { eligible: true };
}

/**
 * Transparent, config-driven ranking. Higher score = better.
 * Every component is normalized to 0..1 so weights stay meaningful.
 */
function scoreRepository(repo, now = Date.now()) {
  const stars = Math.log10(repo.stargazers_count + 1) / 3;         // 0..~1.67, clamp below
  const forks = Math.log10(repo.forks_count + 1) / 2;              // 0..~1.5, clamp below
  const daysSincePush = (now - Date.parse(repo.pushed_at || repo.updated_at || 0)) / 86_400_000;
  const recency = Math.exp(-daysSincePush / 180);                  // 180-day half-life-ish decay
  const meta =
    (repo.description ? 0.4 : 0) +
    (repo.language ? 0.3 : 0) +
    (repo.homepage ? 0.15 : 0) +
    (repo.topics?.length ? 0.15 : 0);

  const score =
    WEIGHTS.stars * Math.min(stars, 1) +
    WEIGHTS.forks * Math.min(forks, 1) +
    WEIGHTS.recency * recency +
    WEIGHTS.metadata * meta;

  return {
    score,
    daysSincePush: Math.round(daysSincePush),
  };
}

function rankRepos(repos, { maxFeatured, minDaysSincePushToSuppressStale }, now = Date.now()) {
  if (!Array.isArray(repos) || repos.length === 0) return [];

  const eligible = repos
    .map((repo) => ({ repo, check: isEligible(repo, USER) }))
    .filter((x) => {
      log(x.check.eligible ? `  include ${x.repo.name}` : `  exclude ${x.repo.name} — ${x.check.reason}`);
      return x.check.eligible;
    });

  // Manual curation via topic always wins, and is NOT capped by recency.
  const curated = eligible.filter((x) => x.repo.topics?.includes(FEATURED_TOPIC));
  const automatic = eligible.filter((x) => !x.repo.topics?.includes(FEATURED_TOPIC));

  // Stale suppression: a very-old non-curated repo can be buried.
  const fresh = automatic.filter(
    (x) => !minDaysSincePushToSuppressStale ||
      Date.now() - Date.parse(x.repo.pushed_at || 0) < minDaysSincePushToSuppressStale * 86_400_000,
  );

  const scored = fresh
    .map((x) => {
      const s = scoreRepository(x.repo, now);
      return { ...x, score: s.score, daysSincePush: s.daysSincePush };
    })
    .sort((a, b) => b.score - a.score);

  // Persist curation as an explicit override flag so downstream consumers
  // (logging, rendering) know WHY a repo outranked fresher ones.
  const flaggedCurated = curated.map((x) => ({
    ...x,
    score: Infinity, // pinned: beats any ranked score
    curated: true,
    daysSincePush: Math.round((now - Date.parse(x.repo.pushed_at || x.repo.updated_at || 0)) / 86_400_000),
  }));

  const picked = [...flaggedCurated, ...scored]
    .slice(0, maxFeatured)
    // de-dup (in case a curated repo also ranked high — impossible here but safe)
    .filter((v, i, arr) => arr.findIndex((t) => t.repo.name === v.repo.name) === i);

  log('ranking (score | days since push | repo):');
  for (const r of picked) {
    log(`  ${Number.isFinite(r.score) ? r.score.toFixed(3) : 'PINNED'} | ${r.daysSincePush}d | ${r.repo.name}`);
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Markdown escaping + rendering                                       */
/* ------------------------------------------------------------------ */

/** Escape characters that are special inside Markdown text/links. */
function escapeMarkdown(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]<>])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

function formatDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10); // YYYY-MM-DD
}

function langColor(language) {
  // Minimal, hand-picked grayscale-safe set. When a language is unknown the
  // badge falls back to a neutral color, so nothing ever breaks.
  const map = {
    JavaScript: 'f1e05a', TypeScript: '3178c6', Python: '3572A5',
    Go: '00ADD8', Shell: '89e051', Rust: 'dea584', Java: 'b07219',
    C: '555555', 'C++': 'f34b7d', 'C#': '178600', HTML: 'e34c26',
    CSS: '563d7c', Dart: '00B4AB', Ruby: '701516', PHP: '4F5D95',
    Kotlin: 'A97BFF', Swift: 'F05138', Vimscript: '199f4b', Lua: '000080',
    HCL: '844FBA', Dockerfile: '384d54', Jupyter: 'DA5B0B',
  };
  return map[language] || '777777';
}

function shield(label, value, color) {
  // Empty label renders as a single-segment badge (no leading dash).
  const slug = label
    ? `${encodeURIComponent(label)}-${encodeURIComponent(value)}`
    : encodeURIComponent(value);
  const alt = label ? `${label}: ${value}` : value;
  return `![${escapeMarkdown(alt)}](https://img.shields.io/badge/${slug}-${color})`;
}

function renderProjects(picked) {
  if (picked.length === 0) {
    return 'No eligible public repositories found yet — original, non-forked, non-archived projects will appear here automatically.\n';
  }

  const rows = [];
  for (let i = 0; i < picked.length; i += 2) {
    const cells = [];
    for (let j = i; j < Math.min(i + 2, picked.length); j++) {
      const { repo } = picked[j];
      const desc = escapeMarkdown(repo.description || 'No description provided.');
      const lang = repo.language || 'Misc';
      const parts = [
        `<h3><a href="${escapeMarkdown(repo.html_url)}">${escapeMarkdown(repo.name)}</a></h3>`,
        `<p>${desc}</p>`,
        '<p>',
        shield('', lang, langColor(lang)),
      ];
      if (repo.stargazers_count > 0) parts.push(shield('stars', String(repo.stargazers_count), '777777'));
      if (repo.forks_count > 0) parts.push(shield('forks', String(repo.forks_count), '777777'));
      parts.push(`![last push](https://img.shields.io/date/${Math.floor(Date.parse(repo.pushed_at || repo.updated_at || 0) / 1000)}?color=777777&label=pushed)`);
      parts.push('</p>');
      cells.push(`<td width="50%" valign="top">\n${parts.join(' ')}\n&nbsp;&nbsp;<a href="${escapeMarkdown(repo.html_url)}">View repository ↗</a>\n</td>`);
    }
    rows.push(`  <tr>\n${cells.join('\n')}\n  </tr>`);
  }

  return [
    '<table>',
    ...rows,
    '</table>',
    '',
    `<sub>Generated from all public repositories owned by [@${USER}](${HTML_URL}). ` +
      'Forks, archived repos and the profile repo are excluded. Ranked by recency, description quality and community engagement — popularity is not a proxy for code quality.</sub>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* README surgery — only inside the markers                            */
/* ------------------------------------------------------------------ */

function replaceSection(readme, generatedBody) {
  const startIdx = readme.indexOf(MARKER_START);
  const endIdx = readme.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) {
    const err = new Error(
      `README is missing one or both required markers (${MARKER_START} / ${MARKER_END}). ` +
      'Nothing was modified — add the markers around the Featured Projects section and re-run.',
    );
    err.exitCode = 3;
    throw err;
  }
  if (endIdx < startIdx) {
    const err = new Error('README markers are reversed (END appears before START). Nothing was modified.');
    err.exitCode = 3;
    throw err;
  }
  const before = readme.slice(0, startIdx + MARKER_START.length);
  const after = readme.slice(endIdx);
  const replacement = `\n${generatedBody}<!-- FEATURED_PROJECTS_GENERATED_BY update-projects.mjs -->\n`;
  return `${before}${replacement}${after}`;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  log(`configuration: user=${USER} readme=${args.readme} dryRun=${args.dryRun} curatedTopic=${FEATURED_TOPIC}`);

  const readmeRaw = readFileSync(args.readme, 'utf8');

  let repos;
  try {
    repos = await fetchAllPublicRepos(USER);
  } catch (err) {
    console.error(`[FATAL] ${err.name}: ${err.message}`);
    process.exit(4);
  }

  const picked = rankRepos(repos, DEFAULT_LIMITS);

  const generated = renderProjects(picked);
  log('--- generated section ---');
  log(generated);

  let updated;
  try {
    updated = replaceSection(readmeRaw, generated);
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    process.exit(err.exitCode ?? 3);
  }

  if (updated === readmeRaw) {
    console.log('No changes to the featured-projects section; README untouched (no commit needed).');
    return;
  }

  if (args.dryRun) {
    console.log('Dry-run: README would be updated; no file written.');
    return;
  }

  writeFileSync(args.readme, updated, 'utf8');
  const diffBytes = updated.length - readmeRaw.length;
  console.log(`README updated: featured-projects section regenerated (${picked.length} project(s), ${diffBytes >= 0 ? '+' : ''}${diffBytes} bytes).`);
}

main().catch((err) => {
  console.error(`[FATAL] unexpected error: ${err?.stack || err}`);
  process.exit(1);
});
